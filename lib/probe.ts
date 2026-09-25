'use strict';

/**
 * A raw dump of every network the Homey runs — Zigbee, Z-Wave, Thread and
 * Matter — for finding out what the Web API returns for each. The API spec
 * names these calls but not what they answer, so real dumps are how a graph
 * adapter for Z-Wave, Thread or Matter gets written.
 *
 * Everything here is read-only. A network the Homey doesn't have, or a call
 * that fails, is recorded as an error in the dump rather than failing it.
 */

/** How long one call may take. The Web API's default is shorter than a slow Z-Wave state needs. */
const CALL_TIMEOUT_MS = 30 * 1000;

/** How long one Matter node's network details may take; a sleeping device may never answer. */
const NODE_TIMEOUT_MS = 8 * 1000;

/** How many Matter nodes are asked at once. */
const NODE_CONCURRENCY = 4;

/**
 * Keys that may hold a secret on any of the networks: network keys, Z-Wave S0/S2
 * keys, Thread's PSKc and active dataset, Matter certificates and the IPK, Wi-Fi
 * names. Deliberately wide, since a dump is meant to be shared in public, but the
 * short ones are anchored: a bare "ssid" or "cert" also matches "commandClassId"
 * and "isUncertified", which a real Z-Wave and Matter dump both have.
 */
const SECRET_KEY = /key|pskc|psk|secret|passw|dataset|credential|token|certs?$|certificates?$|^(noc|icac|rcac|ipk)$|^b?ssid$/i;

/**
 * A 128-bit key written as hex, whatever it is called. Addresses are 64-bit, so
 * they pass. There is no such rule for 16 numbers in a list: Z-Wave's list of
 * node ids can be exactly that.
 */
const HEX_128 = /^(0x)?[0-9a-f]{32}$/i;

/** The part of the Web API client the probe calls, all of it optional: a manager may be missing. */
type Call = (args?: Record<string, unknown>) => Promise<unknown>;
export type ProbeApi = {
  zigbee?: { getState?: Call };
  zwave?: { getState?: Call };
  thread?: { getState?: Call; getNetworkTopology?: Call };
  matter?: {
    getState?: Call;
    getMatterNodes?: Call;
    nodeThreadNetworkInformation?: Call;
    nodeWiFiNetworkInformation?: Call;
  };
};

/** One call's outcome: what it returned, or why it didn't. */
type Result = { value: unknown } | { error: string };

async function attempt(call: Call | undefined, args: Record<string, unknown> = {}, timeout = CALL_TIMEOUT_MS): Promise<Result> {
  if (!call) return { error: 'Not available on this Homey' };
  try {
    return { value: await call({ ...args, $timeout: timeout }) };
  } catch (err) {
    return { error: (err as Error)?.message ?? String(err) };
  }
}

/** The ids of the Matter nodes, whether the API answers with a list or an object keyed by id. */
function nodeIds(nodes: unknown): string[] {
  if (Array.isArray(nodes)) {
    return nodes
      .map((node) => (node as { id?: unknown })?.id)
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
  }
  return nodes && typeof nodes === 'object' ? Object.keys(nodes) : [];
}

/** Each Matter node's Thread and Wi-Fi details, a few nodes at a time. */
async function matterNodeNetworks(api: ProbeApi, ids: string[]) {
  const out: Record<string, { thread: Result; wifi: Result }> = {};
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      out[id] = {
        thread: await attempt(api.matter?.nodeThreadNetworkInformation, { id }, NODE_TIMEOUT_MS),
        wifi: await attempt(api.matter?.nodeWiFiNetworkInformation, { id }, NODE_TIMEOUT_MS),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(NODE_CONCURRENCY, ids.length) }, worker));
  return out;
}

/**
 * A copy of `value` without anything that looks secret, by name or by shape.
 * The path of every value left out goes into `redacted`, so a reader of the
 * dump can tell a removed field from a missing one.
 */
export function redact(value: unknown, redacted: string[], at = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => redact(item, redacted, `${at}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, v]) => {
      const path = at ? `${at}.${key}` : key;
      if (SECRET_KEY.test(key) || (typeof v === 'string' && HEX_128.test(v))) redacted.push(path);
      else out[key] = redact(v, redacted, path);
    });
    return out;
  }
  return value;
}

/** Every network's raw state, with secrets left out, as the text of a JSON file. */
export default async function buildProbe(api: ProbeApi, about: { appVersion: string; homeyVersion: string }): Promise<string> {
  // The networks don't depend on each other, so they are asked at the same time.
  const [zigbee, zwave, threadState, threadTopology, matterState, matterNodes] = await Promise.all([
    attempt(api.zigbee?.getState),
    attempt(api.zwave?.getState),
    attempt(api.thread?.getState),
    attempt(api.thread?.getNetworkTopology),
    attempt(api.matter?.getState),
    attempt(api.matter?.getMatterNodes),
  ]);
  const ids = 'value' in matterNodes ? nodeIds(matterNodes.value) : [];

  const redacted: string[] = [];
  const networks = redact({
    zigbee: { state: zigbee },
    zwave: { state: zwave },
    thread: { state: threadState, topology: threadTopology },
    matter: { state: matterState, nodes: matterNodes, nodeNetworks: await matterNodeNetworks(api, ids) },
  }, redacted);

  return JSON.stringify({
    probe: 1,
    takenAt: new Date().toISOString(),
    ...about,
    note: 'Raw network data for building the visualizer\'s adapters. Anything that looked secret is left out; see redacted.',
    redacted,
    networks,
  }, null, 2);
}
