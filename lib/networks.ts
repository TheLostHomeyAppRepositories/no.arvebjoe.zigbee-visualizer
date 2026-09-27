'use strict';

/**
 * One way in for every network: the state of each network Homey runs, as one
 * object, and the graph of any one of them.
 *
 * The app fills a NetworkStates from the Web API; a probe dump (lib/probe.ts)
 * holds the same calls' answers, so probeStates() reads one back into the same
 * shape. That is how a dump from someone else's Homey is drawn.
 */

import type { Graph, NetworkId } from './graph.js';
import { buildGraph, ZigbeeState } from './zigbee-graph.js';
import { buildThreadGraph, ThreadInput } from './thread-graph.js';
import { buildZwaveGraph, ZwaveInput } from './zwave-graph.js';

export type NetworkStates = {
  zigbee?: ZigbeeState | null;
  thread?: ThreadInput;
  zwave?: ZwaveInput;
};

export function buildNetworkGraph(network: NetworkId, states: NetworkStates): Graph {
  if (network === 'thread') return buildThreadGraph(states.thread ?? {});
  if (network === 'zwave') return buildZwaveGraph(states.zwave ?? {});
  return buildGraph(states.zigbee ?? {});
}

/** One call's outcome in a probe dump: what it returned, or why it didn't. */
type Result = { value?: unknown; error?: string } | undefined;

const valueOf = <T>(result: Result): T | undefined => (result && 'value' in result ? result.value as T : undefined);

/** Whether a loaded file is a probe dump rather than a Zigbee state. */
export function isProbe(input: unknown): boolean {
  const dump = input as { probe?: unknown; networks?: unknown } | null;
  return Boolean(dump && typeof dump === 'object' && dump.probe && dump.networks && typeof dump.networks === 'object');
}

/** The networks in a probe dump, in the shape the builders take. */
export function probeStates(input: unknown): NetworkStates {
  const { networks = {} } = input as {
    networks?: {
      zigbee?: { state?: Result };
      zwave?: { state?: Result };
      thread?: { state?: Result; topology?: Result };
      matter?: {
        nodes?: Result;
        nodeNetworks?: Record<string, { thread?: Result; wifi?: Result }>;
      };
    };
  };

  const diagnostics: NonNullable<ThreadInput['diagnostics']> = {};
  Object.entries(networks.matter?.nodeNetworks ?? {}).forEach(([id, result]) => {
    diagnostics[id] = { thread: valueOf(result.thread) ?? null, wifi: valueOf(result.wifi) ?? null };
  });

  return {
    zigbee: valueOf<ZigbeeState>(networks.zigbee?.state) ?? null,
    thread: {
      state: valueOf(networks.thread?.state) ?? null,
      topology: valueOf(networks.thread?.topology) ?? null,
      matterNodes: valueOf(networks.matter?.nodes) ?? null,
      diagnostics,
      error: networks.thread?.topology?.error ?? null,
    },
    zwave: {
      state: valueOf(networks.zwave?.state) ?? null,
      error: networks.zwave?.state?.error ?? null,
    },
  };
}

/** The part of the Web API client the live graphs need. */
type Call = (args?: Record<string, unknown>) => Promise<unknown>;
export type NetworkApi = {
  zigbee: { getState: Call };
  zwave: { getState: Call };
  thread: { getState: Call; getNetworkTopology: Call };
  matter: { getMatterNodes: Call; nodeThreadNetworkInformation: Call; nodeWiFiNetworkInformation: Call };
  devices: { getDevices: Call };
};

/** How long one Matter node may take to answer; a sleepy device may never do. */
const NODE_TIMEOUT_MS = 5 * 1000;

/** How many Matter nodes are asked at once. */
const NODE_CONCURRENCY = 6;

/** A call's answer, or undefined when it fails: one silent device mustn't take the map down. */
async function tryCall<T>(call: Call, args: Record<string, unknown> = {}): Promise<T | undefined> {
  try {
    return await call(args) as T;
  } catch {
    return undefined;
  }
}

type DeviceInfo = { name?: string; settings?: Record<string, unknown> };

/** Every Matter node's own network diagnostics: Thread for a Thread node, Wi-Fi for a Wi-Fi one. */
async function matterDiagnostics(api: NetworkApi, nodes: Record<string, { network?: { type?: string } }>) {
  const out: NonNullable<ThreadInput['diagnostics']> = {};
  const queue = Object.entries(nodes).filter(([, n]) => n.network?.type === 'thread' || n.network?.type === 'wifi');
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [id, node] = next;
      const args = { id, $timeout: NODE_TIMEOUT_MS };
      out[id] = node.network?.type === 'thread'
        ? { thread: (await tryCall(api.matter.nodeThreadNetworkInformation, args)) ?? null }
        : { wifi: (await tryCall(api.matter.nodeWiFiNetworkInformation, args)) ?? null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(NODE_CONCURRENCY, queue.length) }, worker));
  return out;
}

/** One network's live state, read from the Web API, in the shape the builders take. */
export async function fetchStates(api: NetworkApi, network: NetworkId): Promise<NetworkStates> {
  if (network === 'zigbee') return { zigbee: await api.zigbee.getState() as ZigbeeState };

  const devices = (await tryCall<Record<string, DeviceInfo>>(api.devices.getDevices)) ?? {};

  if (network === 'zwave') {
    // A device with several channels is several Homey devices on one node; the first name will do.
    const deviceNames: Record<string, string> = {};
    Object.values(devices).forEach((d) => {
      const node = d.settings?.zw_node_id;
      if (node != null && d.name && !deviceNames[String(node)]) deviceNames[String(node)] = d.name;
    });
    return { zwave: { state: await api.zwave.getState() as ZwaveInput['state'], deviceNames } };
  }

  const [state, topology, matterNodes] = await Promise.all([
    tryCall<ThreadInput['state']>(api.thread.getState),
    tryCall<ThreadInput['topology']>(api.thread.getNetworkTopology),
    tryCall<Record<string, { network?: { type?: string } }>>(api.matter.getMatterNodes),
  ]);
  const deviceNames: Record<string, string> = {};
  Object.entries(devices).forEach(([id, d]) => {
    if (d.name) deviceNames[id] = d.name;
  });
  return {
    thread: {
      state: state ?? null,
      topology: topology ?? null,
      matterNodes: (matterNodes ?? null) as ThreadInput['matterNodes'],
      diagnostics: matterNodes ? await matterDiagnostics(api, matterNodes) : {},
      deviceNames,
      error: topology === undefined && matterNodes === undefined ? 'Homey didn\'t answer for Thread or Matter' : null,
    },
  };
}
