'use strict';

/**
 * Turns the Zigbee state Homey's controller reports into a graph model.
 *
 * The state gives us two useful things:
 *   - `nodes`                  : keyed by IEEE address, one entry per joined device
 *   - `controllerState.routes` : keyed by network address, the ordered list of
 *                                relays the coordinator uses to reach that device.
 *                                An empty array means "direct child of the coordinator".
 *
 * The route lists are prefix-consistent (the route to a relay is always the
 * route of the device behind it, minus the last hop), so we can rebuild the
 * whole tree by walking each route and connecting consecutive hops.
 */

import {
  blankNode, describeRate, finishGraph, gradeFor, Graph, GraphLink, GraphNode,
} from './graph.js';

export type {
  Grade, Graph, GraphLink, GraphNode,
} from './graph.js';
export { gradeFor } from './graph.js';

const COORDINATOR_ADDR = 0;

/** One entry of `nodes`, as far as we read it. */
export type RawZigbeeNode = {
  ieeeAddr?: string;
  ieeeAddress?: string;
  nwkAddr?: number;
  networkAddress?: number;
  name?: string;
  type?: string;
  deviceType?: string;
  modelId?: string;
  manufacturerName?: string;
  swBuildId?: string;
  ownerUri?: string;
  receiveWhenIdle?: boolean;
  lastSeen?: number;
  stats?: { tx?: number; txSuccess?: number; txError?: number; rx?: number };
  capabilities?: Record<string, boolean> | null;
  endpointDescriptors?: Array<{
    nwkAddrOfInterest?: number;
    endpointId?: number;
    applicationProfileId?: number;
    applicationDeviceId?: number;
    inputClusters?: number[];
    outputClusters?: number[];
  }>;
  /** ieeeAddress -> list of "endpoint:cluster" bindings */
  bindings?: Record<string, Array<string | number>> | null;
};

/** The shape of `GET /api/manager/zigbee/state`, as far as we rely on it. */
export type ZigbeeState = {
  zigbee_error?: string | null;
  zigbee_ready?: boolean;
  zigbee_state?: { currentCommand?: string };
  controllerState?: {
    channel?: number;
    panId?: string;
    extendedPanId?: string;
    IEEEAddress?: string;
    ieeeAddr?: string;
    softwareVersion?: string;
    currentCommand?: string;
    /** networkAddress -> ordered list of relays the controller routes through */
    routes?: Record<string, number[]>;
  };
  nodes?: Record<string, RawZigbeeNode>;
};

/** The network address a device had when Homey interviewed it, if it says. */
function interviewAddr(node: RawZigbeeNode): number | undefined {
  return node.endpointDescriptors?.find((ep) => ep.nwkAddrOfInterest != null)?.nwkAddrOfInterest;
}

/** A Zigbee network address as it is usually written: 0x1a2b. */
const hex = (addr: number) => `0x${addr.toString(16).padStart(4, '0')}`;

function buildNode(addr: number, ieee: string, node: RawZigbeeNode): GraphNode {
  const stats = node.stats ?? {};
  const tx = stats.tx ?? 0;
  const txSuccess = stats.txSuccess ?? 0;
  return {
    ...blankNode(addr, node.name || node.modelId || `0x${addr.toString(16)}`, node.type || node.deviceType || 'unknown'),
    addrLabel: hex(addr),
    pairedAddr: interviewAddr(node),
    ieeeAddr: ieee,
    modelId: node.modelId,
    manufacturerName: node.manufacturerName,
    swBuildId: node.swBuildId,
    ownerUri: node.ownerUri,
    receiveWhenIdle: node.receiveWhenIdle,
    lastSeen: node.lastSeen,
    stats: {
      tx,
      txSuccess,
      txError: stats.txError ?? 0,
      rx: stats.rx ?? 0,
      successRate: tx > 0 ? txSuccess / tx : null,
    },
    capabilities: node.capabilities ?? null,
    endpoints: (node.endpointDescriptors ?? []).map((ep) => ({
      endpointId: ep.endpointId,
      profileId: ep.applicationProfileId,
      deviceId: ep.applicationDeviceId,
      inputClusters: ep.inputClusters ?? [],
      outputClusters: ep.outputClusters ?? [],
    })),
    bindings: node.bindings ?? null,
  };
}

/** A routing-table entry whose device is no longer in the node list. */
function ghostNode(addr: number): GraphNode {
  return {
    ...blankNode(addr, `Unknown 0x${addr.toString(16)}`, 'ghost'),
    addrLabel: hex(addr),
    isGhost: true,
  };
}

export function buildGraph(state: ZigbeeState): Graph {
  const controller = state.controllerState ?? {};
  const routes = controller.routes ?? {};
  const rawNodes = state.nodes ?? {};

  const byAddr = new Map<number, GraphNode>();

  // Two devices can report the same network address: a conflict, or a record
  // Homey never updated. The route belongs to the address, so it goes to one of
  // them: the one that already had the address when Homey interviewed it, else
  // the first. The other stays in the graph under an id of its own, without a route.
  let spareId = -1;
  Object.entries(rawNodes).forEach(([ieee, node]) => {
    const addr = node.nwkAddr ?? node.networkAddress;
    if (addr == null) return;
    const built = buildNode(addr, ieee, node);
    const holder = byAddr.get(addr);
    if (!holder) {
      byAddr.set(addr, built);
      return;
    }
    const [keep, spare] = interviewAddr(node) === addr ? [built, holder] : [holder, built];
    spare.addr = spareId;
    spareId -= 1;
    byAddr.set(addr, keep);
    byAddr.set(spare.addr, spare);
    keep.sharedWith = [...(keep.sharedWith ?? []), spare.name];
    spare.sharedWith = [...(spare.sharedWith ?? []), keep.name];
  });

  // Devices that only exist in the routing table (stale entries left behind by
  // a device that was removed or re-joined with a new address).
  Object.keys(routes).forEach((key) => {
    const addr = Number(key);
    if (!byAddr.has(addr)) byAddr.set(addr, ghostNode(addr));
  });

  // A stale entry at the address a device had when Homey paired it, while that
  // device now reports another one, is most likely that same device: the route
  // to it still exists, and it is Homey's record of the device that is out of date.
  byAddr.forEach((ghost) => {
    if (!ghost.isGhost) return;
    const owners = [...byAddr.values()]
      .filter((n) => !n.isGhost && n.pairedAddr === ghost.addr && n.nwkAddr !== ghost.addr);
    if (!owners.length) return;
    ghost.probablyWas = owners.map((n) => n.addr);
    ghost.name = `0x${ghost.addr.toString(16)} · ${owners.map((n) => n.name).join(' / ')}?`;
    owners.forEach((n) => {
      n.staleAddr = ghost.addr;
    });
  });

  const coordinator = byAddr.get(COORDINATOR_ADDR);
  if (coordinator) {
    coordinator.isCoordinator = true;
    coordinator.hops = 0;
    coordinator.path = [];
  }

  // ---- paths ------------------------------------------------------------
  Object.entries(routes).forEach(([key, hops]) => {
    const addr = Number(key);
    const node = byAddr.get(addr);
    if (!node || addr === COORDINATOR_ADDR) return;
    node.path = [COORDINATOR_ADDR, ...hops, addr];
    node.hops = hops.length + 1;
    node.hasRoute = true;
  });

  // Bindings are logical (cluster-level) relations, not routing. They are kept
  // as a separate layer the UI can toggle on.
  const bindings = new Map<string, GraphLink>();
  byAddr.forEach((node) => {
    Object.entries(node.bindings ?? {}).forEach(([targetIeee, clusters]) => {
      const target = [...byAddr.values()].find((n) => n.ieeeAddr === targetIeee);
      if (!target || target.addr === node.addr) return;
      const id = `${node.addr}->${target.addr}:binding`;
      bindings.set(id, {
        id, source: node.addr, target: target.addr, kind: 'binding', clusters,
      });
    });
  });

  // Each hop is graded by the TX counters of the device at its far end.
  const gradeLink = (link: GraphLink, child: GraphNode) => {
    const { successRate, tx, txError } = child.stats;
    const grade = gradeFor(successRate, tx);
    Object.assign(link, {
      rate: successRate, sample: tx, txError, grade, score: successRate, ...describeRate(successRate, tx, grade),
    });
  };

  return finishGraph('zigbee', byAddr, gradeLink, {
    controller: {
      channel: controller.channel,
      panId: controller.panId,
      extendedPanId: controller.extendedPanId,
      ieeeAddress: controller.IEEEAddress || controller.ieeeAddr,
      softwareVersion: controller.softwareVersion,
      currentCommand: controller.currentCommand,
    },
    meta: { ready: state.zigbee_ready, error: state.zigbee_error },
    links: [...bindings.values()],
  });
}
