'use strict';

import type { RawZigbeeNode, ZigbeeState } from './zigbee-graph';

/** One moment in the export: a saved snapshot, or the live state at the end. */
export type ExportPoint = {
  takenAt: string;
  live: boolean;
  state: ZigbeeState;
};

type DeviceRef = { nwkAddr: number; ieee: string | null; name: string };

type Counters = { tx: number; txSuccess: number; txError: number; rx: number };

// Read first by whoever (or whatever) opens the file, so the fields need no guessing.
const ABOUT = {
  what: 'The history of one Homey Zigbee network: a snapshot of every device per point in time, oldest '
    + 'first. The last point is the live state at the moment of export.',
  devices: 'Keyed by IEEE address, which never changes. nwkAddr is the current 16-bit network address; it '
    + 'changes when a device rejoins.',
  nwkAddrOfInterest: 'The network address the device had when Homey interviewed it. rejoinedSinceInterview is true '
    + 'when that differs from nwkAddr.',
  route: 'The controller routes to each device along path: from the controller (nwkAddr 0) through relays '
    + 'to the device. parent is the last relay before the device, hops the number of links. A device '
    + 'without a route has hops, parent and path null.',
  counters: 'tx, txSuccess, txError and rx are cumulative counters kept by Homey for each device; successRate '
    + 'is txSuccess / tx. delta holds the change since the previous point; it is null for the first '
    + 'point, or when a counter went down (reset, e.g. after a Homey restart).',
  staleRoutes: 'Routing table entries for a network address no device has any more, usually left behind by a '
    + 'device that rejoined. probablyWas lists devices whose nwkAddrOfInterest is that address.',
  sharedAddresses: 'Network addresses used by more than one device at once: an address conflict.',
  routeAmbiguous: 'True when another device reports the same nwkAddr. The routing table is keyed by address, '
    + 'so hops, parent and path may belong to the other device rather than this one.',
  privacy: 'The network key and other secrets are not included.',
};

function counters(node: RawZigbeeNode): Counters {
  const s = node.stats ?? {};
  return {
    tx: s.tx ?? 0, txSuccess: s.txSuccess ?? 0, txError: s.txError ?? 0, rx: s.rx ?? 0,
  };
}

const rate = (success: number, total: number) => (total > 0 ? Math.round((success / total) * 1000) / 1000 : null);

/** The change in counters since the point before, or null when there is none to compare with. */
function deltaOf(now: Counters, before: Counters | undefined) {
  if (!before) return null;
  const d = {
    tx: now.tx - before.tx, txSuccess: now.txSuccess - before.txSuccess, txError: now.txError - before.txError, rx: now.rx - before.rx,
  };
  if (d.tx < 0 || d.txSuccess < 0 || d.txError < 0 || d.rx < 0) return null;
  return { ...d, successRate: rate(d.txSuccess, d.tx) };
}

/** One point in time, reduced to what matters for analysing the mesh. */
function summarise(point: ExportPoint, previous: Map<string, Counters>) {
  const { state } = point;
  const controller = state.controllerState ?? {};
  const routes = controller.routes ?? {};
  const nodes = Object.entries(state.nodes ?? {}).map(([ieee, node]) => ({
    ieee, node, nwkAddr: node.nwkAddr ?? node.networkAddress,
  }));

  const byNwk = new Map<number, DeviceRef[]>();
  nodes.forEach(({ ieee, node, nwkAddr }) => {
    if (nwkAddr == null) return;
    byNwk.set(nwkAddr, [...(byNwk.get(nwkAddr) ?? []), { nwkAddr, ieee, name: node.name ?? ieee }]);
  });
  // Where two devices share an address, a hop through it is named after both.
  const ref = (addr: number): DeviceRef => {
    const found = byNwk.get(addr);
    if (!found) return { nwkAddr: addr, ieee: null, name: 'unknown (stale address)' };
    return found.length === 1 ? found[0] : { nwkAddr: addr, ieee: null, name: found.map((d) => d.name).join(' / ') };
  };

  const devices = nodes.filter(({ nwkAddr }) => nwkAddr !== 0).map(({ ieee, node, nwkAddr }) => {
    const relays = nwkAddr == null ? undefined : routes[String(nwkAddr)];
    const path = relays ? [0, ...relays, nwkAddr as number].map(ref) : null;
    const interview = (node.endpointDescriptors ?? []).find((ep) => ep.nwkAddrOfInterest != null)?.nwkAddrOfInterest ?? null;
    const now = counters(node);
    return {
      ieee,
      name: node.name ?? null,
      type: node.type ?? node.deviceType ?? null,
      manufacturer: node.manufacturerName || null,
      model: node.modelId ?? null,
      firmware: node.swBuildId ?? null,
      powerSourceMains: node.capabilities?.powerSourceMains ?? null,
      receiveWhenIdle: node.receiveWhenIdle ?? null,
      nwkAddr: nwkAddr ?? null,
      nwkAddrOfInterest: interview,
      rejoinedSinceInterview: interview == null || nwkAddr == null ? null : interview !== nwkAddr,
      hops: relays ? relays.length + 1 : null,
      parent: path ? path[path.length - 2] : null,
      path,
      routeAmbiguous: nwkAddr != null && (byNwk.get(nwkAddr)?.length ?? 0) > 1,
      ...now,
      successRate: rate(now.txSuccess, now.tx),
      lastSeen: node.lastSeen ? new Date(node.lastSeen).toISOString() : null,
      delta: deltaOf(now, previous.get(ieee)),
    };
  });

  const staleRoutes = Object.entries(routes)
    .filter(([addr]) => !byNwk.has(Number(addr)))
    .map(([addr, relays]) => ({
      nwkAddr: Number(addr),
      path: [0, ...relays, Number(addr)].map(ref),
      probablyWas: devices.filter((d) => d.nwkAddrOfInterest === Number(addr)).map((d) => ({ ieee: d.ieee, name: d.name })),
    }));

  const sharedAddresses = [...byNwk].filter(([, list]) => list.length > 1)
    .map(([nwkAddr, list]) => ({ nwkAddr, devices: list.map((d) => ({ ieee: d.ieee, name: d.name })) }));

  const coordinator = byNwk.get(0)?.[0];
  return {
    takenAt: point.takenAt,
    live: point.live,
    controller: {
      ieee: coordinator?.ieee ?? controller.IEEEAddress ?? null,
      name: coordinator?.name ?? null,
      channel: controller.channel ?? null,
      panId: controller.panId ?? null,
      extendedPanId: controller.extendedPanId ?? null,
      firmware: controller.softwareVersion ?? null,
    },
    devices,
    staleRoutes,
    sharedAddresses,
  };
}

/** The whole history as one object, ready to be written out as JSON. */
export default function buildExport(points: ExportPoint[], meta: { timezone: string; intervalHours: number }) {
  let previous = new Map<string, Counters>();
  const snapshots = points.map((point) => {
    const summary = summarise(point, previous);
    previous = new Map(summary.devices.map((d) => [d.ieee, {
      tx: d.tx, txSuccess: d.txSuccess, txError: d.txError, rx: d.rx,
    }]));
    return summary;
  });
  return {
    about: ABOUT,
    exportedAt: new Date().toISOString(),
    timezone: meta.timezone,
    intervalHours: meta.intervalHours,
    snapshots,
  };
}
