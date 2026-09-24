'use strict';

/**
 * Turns a Homey Zigbee network dump into a graph model.
 *
 * The dump gives us two useful things:
 *   - `nodes`            : keyed by IEEE address, one entry per joined device
 *   - `controllerState.routes` : keyed by network address, the ordered list of
 *                          relays the coordinator uses to reach that device.
 *                          An empty array means "direct child of the coordinator".
 *
 * The route lists are prefix-consistent (the route to a relay is always the
 * route of the device behind it, minus the last hop), so we can rebuild the
 * whole tree by walking each route and connecting consecutive hops.
 *
 * Runs both in Node and in the browser — see the export at the bottom.
 */

const COORDINATOR_ADDR = 0;

/**
 * Link quality grades, derived from the TX success counters. The dump carries
 * no LQI/RSSI, so this is a proxy: a device that has to retry a lot to get its
 * frames through is a device with a poor link to its parent.
 */
const GRADES = [
  { grade: 'good', min: 0.95 },
  { grade: 'fair', min: 0.85 },
  { grade: 'weak', min: 0.70 },
  { grade: 'bad', min: 0 },
];

// Below this many transmissions the success rate is too noisy to judge.
const MIN_SAMPLE = 30;

function gradeFor(rate, sample) {
  if (rate == null || sample < MIN_SAMPLE) return 'unknown';
  return GRADES.find((g) => rate >= g.min).grade;
}

/**
 * Keys holding the secrets that let anyone join or decrypt the mesh. Homey puts
 * the network key in `controllerState`, but we sweep the whole object so a
 * differently shaped export cannot slip one past us.
 */
const SECRET_KEY = /^(network|link|tclink|trustcenterlink|preconfigured)_?key$/i;

/**
 * Deletes every secret key in place and returns the names it removed. Call this
 * before the dump is parsed, stored or shown, so a user who forgot to redact
 * their own dump never carries the key any further than the drop zone.
 */
function stripSecrets(value, removed = []) {
  if (Array.isArray(value)) {
    for (const item of value) stripSecrets(item, removed);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (SECRET_KEY.test(key)) {
        removed.push(key);
        delete value[key];
      } else {
        stripSecrets(value[key], removed);
      }
    }
  }
  return removed;
}

function parseDump(raw) {
  const dump = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const controller = dump.controllerState || {};
  const routes = controller.routes || {};
  const rawNodes = dump.nodes || {};

  const byAddr = new Map();

  // Two devices can report the same network address: a conflict, or a record
  // Homey never updated. The route belongs to the address, so it goes to one of
  // them: the one that already had the address when Homey interviewed it, else
  // the first. The other stays on the map under an id of its own, without a route.
  let spareId = -1;
  for (const [ieee, node] of Object.entries(rawNodes)) {
    const addr = node.nwkAddr ?? node.networkAddress;
    const built = buildNode(addr, ieee, node);
    const holder = byAddr.get(addr);
    if (!holder) {
      byAddr.set(addr, built);
      continue;
    }
    const [keep, spare] = interviewAddr(node) === addr ? [built, holder] : [holder, built];
    spare.addr = spareId;
    spareId -= 1;
    byAddr.set(addr, keep);
    byAddr.set(spare.addr, spare);
    keep.sharedWith = [...(keep.sharedWith || []), spare.name];
    spare.sharedWith = [...(spare.sharedWith || []), keep.name];
  }

  // Devices that only exist in the routing table (stale entries left behind by
  // a device that was removed or re-joined with a new address).
  for (const key of Object.keys(routes)) {
    const addr = Number(key);
    if (!byAddr.has(addr)) byAddr.set(addr, ghostNode(addr));
  }

  // A stale entry at the address a device had when Homey paired it, while that
  // device now reports another one, is most likely that same device: the route
  // to it still exists, and it is Homey's record of the device that is out of date.
  for (const ghost of byAddr.values()) {
    if (!ghost.isGhost) continue;
    const owners = [...byAddr.values()]
      .filter((n) => !n.isGhost && n.pairedAddr === ghost.addr && n.nwkAddr !== ghost.addr);
    if (!owners.length) continue;
    ghost.probablyWas = owners.map((n) => n.addr);
    ghost.name = `0x${ghost.addr.toString(16)} · ${owners.map((n) => n.name).join(' / ')}?`;
    owners.forEach((n) => { n.staleAddr = ghost.addr; });
  }

  const coordinator = byAddr.get(COORDINATOR_ADDR);
  if (coordinator) {
    coordinator.isCoordinator = true;
    coordinator.hops = 0;
    coordinator.path = [];
  }

  // ---- paths ------------------------------------------------------------
  for (const [key, hops] of Object.entries(routes)) {
    const addr = Number(key);
    const node = byAddr.get(addr);
    if (!node || addr === COORDINATOR_ADDR) continue;
    node.path = [COORDINATOR_ADDR, ...hops, addr];
    node.hops = hops.length + 1;
    node.hasRoute = true;
  }

  // ---- links ------------------------------------------------------------
  const links = new Map();
  const addLink = (source, target, kind) => {
    const id = `${source}->${target}:${kind}`;
    if (!links.has(id)) links.set(id, { id, source, target, kind });
    return links.get(id);
  };

  for (const node of byAddr.values()) {
    if (!node.path || node.path.length < 2) continue;
    for (let i = 0; i < node.path.length - 1; i++) {
      addLink(node.path[i], node.path[i + 1], 'route');
    }
    node.parent = node.path[node.path.length - 2];
  }

  // Bindings are logical (cluster-level) relations, not routing. They are kept
  // as a separate layer the UI can toggle on.
  for (const node of byAddr.values()) {
    for (const [targetIeee, clusters] of Object.entries(node.bindings || {})) {
      const target = [...byAddr.values()].find((n) => n.ieeeAddr === targetIeee);
      if (!target || target.addr === node.addr) continue;
      const link = addLink(node.addr, target.addr, 'binding');
      link.clusters = clusters;
    }
  }

  // ---- link quality -----------------------------------------------------
  // Every route link a->b is b's uplink (b.parent === a, because the route
  // lists are prefix-consistent), so b's TX counters describe that hop.
  for (const link of links.values()) {
    if (link.kind !== 'route') continue;
    const child = byAddr.get(link.target);
    if (!child) continue;
    const { successRate, tx, txError } = child.stats;
    link.rate = successRate;
    link.sample = tx;
    link.txError = txError;
    link.grade = gradeFor(successRate, tx);
    child.uplinkGrade = link.grade;
    child.uplinkRate = successRate;
  }

  // ---- derived stats ----------------------------------------------------
  const childCount = new Map();
  for (const node of byAddr.values()) {
    if (node.parent === undefined) continue;
    childCount.set(node.parent, (childCount.get(node.parent) || 0) + 1);
  }
  for (const node of byAddr.values()) {
    node.childCount = childCount.get(node.addr) || 0;
    node.descendantCount = 0;
  }
  for (const node of byAddr.values()) {
    for (const hop of (node.path || []).slice(0, -1)) {
      const relay = byAddr.get(hop);
      if (relay) relay.descendantCount++;
    }
  }

  const nodes = [...byAddr.values()].sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99));

  return {
    controller: {
      channel: controller.channel,
      panId: controller.panId,
      extendedPanId: controller.extendedPanId,
      ieeeAddress: controller.IEEEAddress || controller.ieeeAddr,
      softwareVersion: controller.softwareVersion,
      currentCommand: controller.currentCommand,
    },
    meta: {
      ready: dump.zigbee_ready,
      error: dump.zigbee_error,
      nodeCount: nodes.length,
      deviceCount: nodes.filter((n) => !n.isGhost).length,
      routerCount: nodes.filter((n) => n.type === 'router').length,
      endDeviceCount: nodes.filter((n) => n.type === 'enddevice').length,
      ghostCount: nodes.filter((n) => n.isGhost).length,
      unreachableCount: nodes.filter((n) => !n.hasRoute && !n.isCoordinator).length,
      maxHops: nodes.reduce((max, n) => Math.max(max, n.hops ?? 0), 0),
      weakLinkCount: [...links.values()].filter((l) => l.grade === 'weak' || l.grade === 'bad').length,
      generatedAt: Date.now(),
    },
    nodes,
    links: [...links.values()],
  };
}

/** The network address a device had when Homey interviewed it, if it says. */
function interviewAddr(node) {
  const ep = (node.endpointDescriptors || []).find((e) => e.nwkAddrOfInterest != null);
  return ep ? ep.nwkAddrOfInterest : undefined;
}

function buildNode(addr, ieee, node) {
  const stats = node.stats || {};
  const tx = stats.tx || 0;
  const txSuccess = stats.txSuccess || 0;
  return {
    addr,
    nwkAddr: addr, // what the device reports; addr is its id here, which differs for a shared address
    pairedAddr: interviewAddr(node),
    ieeeAddr: ieee,
    name: node.name || node.modelId || `0x${addr.toString(16)}`,
    type: node.type || node.deviceType || 'unknown',
    modelId: node.modelId,
    manufacturerName: node.manufacturerName,
    swBuildId: node.swBuildId,
    ownerUri: node.ownerUri,
    receiveWhenIdle: node.receiveWhenIdle,
    lastSeen: node.lastSeen,
    stats: {
      tx,
      txSuccess,
      txError: stats.txError || 0,
      rx: stats.rx || 0,
      successRate: tx > 0 ? txSuccess / tx : null,
    },
    capabilities: node.capabilities || null,
    endpoints: (node.endpointDescriptors || []).map((ep) => ({
      endpointId: ep.endpointId,
      profileId: ep.applicationProfileId,
      deviceId: ep.applicationDeviceId,
      inputClusters: ep.inputClusters || [],
      outputClusters: ep.outputClusters || [],
    })),
    bindings: node.bindings || null,
    isGhost: false,
    isCoordinator: false,
    hasRoute: false,
    hops: null,
    path: null,
    uplinkGrade: 'unknown',
    uplinkRate: null,
  };
}

function ghostNode(addr) {
  return {
    addr,
    nwkAddr: addr,
    ieeeAddr: null,
    name: `Unknown 0x${addr.toString(16)}`,
    type: 'ghost',
    stats: { tx: 0, txSuccess: 0, txError: 0, rx: 0, successRate: null },
    endpoints: [],
    bindings: null,
    isGhost: true,
    isCoordinator: false,
    uplinkGrade: 'unknown',
    uplinkRate: null,
    hasRoute: false,
    hops: null,
    path: null,
  };
}

const api = { parseDump, gradeFor, stripSecrets };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof self !== 'undefined') self.ZigbeeParse = api;
