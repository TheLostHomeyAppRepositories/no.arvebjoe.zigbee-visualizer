'use strict';

/**
 * Turns Homey's Z-Wave state into a graph model.
 *
 * `zwave.getState()` lists every node with its device classes and Homey's TX
 * counters for it, but not the mesh: which nodes hear each other, or the route
 * Homey uses to reach one. Homey's developer tools read those with
 * `runCommand getNetworkTopology`, which needs a scope apps are not given.
 *
 * So the map is a star: every node joined straight to Homey, graded by how
 * many of Homey's transmissions to it got through, as Zigbee's hops are. The
 * line means "Homey talks to this node", not "this node is in range of Homey";
 * the graph's notice says so.
 */

import {
  blankNode, describeRate, Fact, finishGraph, gradeFor, Graph, GraphLink, GraphNode,
} from './graph';

type Named = { name?: string; value?: number };

/** One entry of `zw_state.nodeSettings`, as far as it is read here. */
export type ZwaveNodeSettings = {
  isController?: boolean | string;
  deviceClassBasic?: Named;
  deviceClassGeneric?: Named;
  deviceClassSpecific?: Named;
  manufacturerId?: Named;
  productTypeId?: Named;
  productId?: Named;
  applicationVersion?: string | number;
  applicationSubVersion?: string | number;
  capability?: { listening?: boolean; frequentListening?: boolean | string };
};

/** The shape of `GET /api/manager/zwave/state`, as far as it is read here. */
export type ZwaveState = {
  zw_ready?: boolean;
  zw_error?: string | null;
  zw_state?: {
    nodeId?: number;
    homeId?: number;
    nodes?: number[];
    nodeSettings?: Record<string, ZwaveNodeSettings>;
    stats?: Record<string, { tx?: number; tx_ok?: number; tx_err?: number; rx?: number }>;
    noAckNodes?: number[];
    version?: string;
    softwareRegion?: string;
    hardwareRegion?: string;
    sucId?: number;
  };
};

export type ZwaveInput = {
  state?: ZwaveState | null;
  /** Homey's device names by Z-Wave node id, from each device's zw_node_id setting. */
  deviceNames?: Record<string, string>;
  error?: string | null;
};

const NOTICE = 'Homey doesn\'t let apps read the Z-Wave mesh, so every device is drawn straight from Homey. '
  + 'A line means Homey talks to that device, not that the two are in range of each other: '
  + 'the messages may well go through other devices on the way.';

/** A device class name as the state has it, e.g. GENERIC_TYPE_SWITCH_BINARY, made readable: "Switch binary". */
function className(named: Named | undefined): string | undefined {
  if (!named?.name) return undefined;
  const words = named.name.replace(/^(BASIC|GENERIC|SPECIFIC)_TYPE_/, '').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const hex4 = (value: number | undefined) => (value == null ? '?' : `0x${value.toString(16).padStart(4, '0')}`);

export function buildZwaveGraph(input: ZwaveInput): Graph {
  const zw = input.state?.zw_state ?? {};
  const names = input.deviceNames ?? {};
  const controllerId = zw.nodeId ?? 1;
  const noAck = new Set(zw.noAckNodes ?? []);
  const byAddr = new Map<number, GraphNode>();

  const homey = {
    ...blankNode(0, 'Homey', 'coordinator'),
    key: 'homey',
    nwkAddr: controllerId,
    addrLabel: `node ${controllerId}`,
    isCoordinator: true,
    hops: 0,
    path: [0],
  };
  byAddr.set(0, homey);

  (zw.nodes ?? []).forEach((id) => {
    if (id === controllerId) return;
    const settings = zw.nodeSettings?.[String(id)] ?? {};
    const counters = zw.stats?.[`node_${id}_network`] ?? {};
    const tx = counters.tx ?? 0;
    const txSuccess = counters.tx_ok ?? 0;
    const listening = settings.capability?.listening === true;
    const kind = className(settings.deviceClassSpecific) ?? className(settings.deviceClassGeneric);

    const facts: Fact[] = [];
    if (kind) facts.push({ label: 'Device class', value: kind });
    facts.push({
      label: 'Listening',
      value: listening ? 'Always (can repeat for others)' : 'Sleeps (battery)',
    });
    if (settings.manufacturerId?.value != null) {
      facts.push({
        label: 'Product',
        value: `${hex4(settings.manufacturerId.value)} / ${hex4(settings.productTypeId?.value)} / ${hex4(settings.productId?.value)}`,
      });
    }
    if (settings.applicationVersion != null) {
      facts.push({ label: 'Firmware', value: `${settings.applicationVersion}.${settings.applicationSubVersion ?? 0}` });
    }

    const node: GraphNode = {
      ...blankNode(id, names[String(id)] || kind || `Z-Wave node ${id}`, listening ? 'router' : 'enddevice'),
      // A node id stays with the device until it is excluded; a new inclusion gets a new one.
      key: `node:${id}`,
      addrLabel: `node ${id}`,
      receiveWhenIdle: listening,
      stats: {
        tx,
        txSuccess,
        txError: counters.tx_err ?? 0,
        rx: counters.rx ?? 0,
        successRate: tx > 0 ? txSuccess / tx : null,
      },
      facts,
      hasRoute: true,
      hops: 1,
      path: [0, id],
    };
    if (noAck.has(id)) node.note = 'Homey lists this device as not answering.';
    byAddr.set(id, node);
  });

  const gradeLink = (link: GraphLink, child: GraphNode) => {
    const { successRate, tx, txError } = child.stats;
    const grade = gradeFor(successRate, tx);
    Object.assign(link, {
      rate: successRate, sample: tx, txError, grade, score: successRate, ...describeRate(successRate, tx, grade),
    });
  };

  const facts: Fact[] = [];
  if (zw.version) facts.push({ label: 'Chip', value: zw.version });
  if (zw.softwareRegion) facts.push({ label: 'Region', value: zw.softwareRegion });
  if (zw.homeId != null) facts.push({ label: 'Home ID', value: `0x${zw.homeId.toString(16)}` });
  facts.push({ label: 'Controller', value: `node ${controllerId}` });

  return finishGraph('zwave', byAddr, gradeLink, {
    controller: { softwareVersion: zw.version, facts },
    meta: {
      ready: input.state?.zw_ready,
      error: input.error ?? input.state?.zw_error ?? null,
      notice: NOTICE,
    },
  });
}

/**
 * The Z-Wave state cut down to what buildZwaveGraph reads, for a snapshot:
 * Homey's state carries much more per node than the map shows. Null when
 * Homey has no Z-Wave devices, so there is no history of nothing.
 */
export function trimZwaveInput(input: ZwaveInput): ZwaveInput | null {
  const zw = input.state?.zw_state;
  const controllerId = zw?.nodeId ?? 1;
  const ids = (zw?.nodes ?? []).filter((id) => id !== controllerId);
  if (!zw || !ids.length) return null;

  const nodeSettings: Record<string, ZwaveNodeSettings> = {};
  const stats: NonNullable<NonNullable<ZwaveState['zw_state']>['stats']> = {};
  ids.forEach((id) => {
    const n = zw.nodeSettings?.[String(id)];
    if (n) {
      nodeSettings[String(id)] = {
        deviceClassGeneric: n.deviceClassGeneric,
        deviceClassSpecific: n.deviceClassSpecific,
        manufacturerId: n.manufacturerId,
        productTypeId: n.productTypeId,
        productId: n.productId,
        applicationVersion: n.applicationVersion,
        applicationSubVersion: n.applicationSubVersion,
        capability: { listening: n.capability?.listening },
      };
    }
    const counters = zw.stats?.[`node_${id}_network`];
    if (counters) {
      stats[`node_${id}_network`] = {
        tx: counters.tx, tx_ok: counters.tx_ok, tx_err: counters.tx_err, rx: counters.rx,
      };
    }
  });

  return {
    state: {
      zw_ready: input.state?.zw_ready,
      zw_error: input.state?.zw_error,
      zw_state: {
        nodeId: zw.nodeId,
        homeId: zw.homeId,
        nodes: zw.nodes,
        nodeSettings,
        stats,
        noAckNodes: zw.noAckNodes,
        version: zw.version,
        softwareRegion: zw.softwareRegion,
      },
    },
    deviceNames: input.deviceNames,
  };
}
