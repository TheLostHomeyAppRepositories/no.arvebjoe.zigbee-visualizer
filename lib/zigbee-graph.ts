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

const COORDINATOR_ADDR = 0;

/**
 * Link quality grades, derived from the TX success counters. The state carries
 * no LQI/RSSI, so this is a proxy: a device that has to retry a lot to get its
 * frames through is a device with a poor link to its parent.
 */
const GRADES = [
  { grade: 'good', min: 0.95 },
  { grade: 'fair', min: 0.85 },
  { grade: 'weak', min: 0.70 },
  { grade: 'bad', min: 0 },
] as const;

// Below this many transmissions the success rate is too noisy to judge.
const MIN_SAMPLE = 30;

export type Grade = 'good' | 'fair' | 'weak' | 'bad' | 'unknown';

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

export type GraphNode = {
  addr: number;
  ieeeAddr: string | null;
  name: string;
  type: string;
  modelId?: string;
  manufacturerName?: string;
  swBuildId?: string;
  ownerUri?: string;
  receiveWhenIdle?: boolean;
  lastSeen?: number;
  stats: {
    tx: number;
    txSuccess: number;
    txError: number;
    rx: number;
    successRate: number | null;
  };
  capabilities: Record<string, boolean> | null;
  endpoints: Array<{
    endpointId?: number;
    profileId?: number;
    deviceId?: number;
    inputClusters: number[];
    outputClusters: number[];
  }>;
  bindings: Record<string, Array<string | number>> | null;
  isGhost: boolean;
  isCoordinator: boolean;
  hasRoute: boolean;
  hops: number | null;
  path: number[] | null;
  parent?: number;
  childCount: number;
  descendantCount: number;
  uplinkGrade: Grade;
  uplinkRate: number | null;
};

export type GraphLink = {
  id: string;
  source: number;
  target: number;
  kind: 'route' | 'binding';
  clusters?: Array<string | number>;
  rate?: number | null;
  sample?: number;
  txError?: number;
  grade?: Grade;
};

export type Graph = {
  controller: {
    channel?: number;
    panId?: string;
    extendedPanId?: string;
    ieeeAddress?: string;
    softwareVersion?: string;
    currentCommand?: string;
  };
  meta: {
    ready?: boolean;
    error?: string | null;
    nodeCount: number;
    deviceCount: number;
    routerCount: number;
    endDeviceCount: number;
    ghostCount: number;
    unreachableCount: number;
    bindingCount: number;
    maxHops: number;
    weakLinkCount: number;
    generatedAt: number;
  };
  nodes: GraphNode[];
  links: GraphLink[];
};

export function gradeFor(rate: number | null, sample: number): Grade {
  if (rate == null || sample < MIN_SAMPLE) return 'unknown';
  return (GRADES.find((g) => rate >= g.min) ?? GRADES[GRADES.length - 1]).grade;
}

function buildNode(addr: number, ieee: string, node: RawZigbeeNode): GraphNode {
  const stats = node.stats ?? {};
  const tx = stats.tx ?? 0;
  const txSuccess = stats.txSuccess ?? 0;
  return {
    addr,
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
    isGhost: false,
    isCoordinator: false,
    hasRoute: false,
    hops: null,
    path: null,
    childCount: 0,
    descendantCount: 0,
    uplinkGrade: 'unknown',
    uplinkRate: null,
  };
}

/** A routing-table entry whose device is no longer in the node list. */
function ghostNode(addr: number): GraphNode {
  return {
    addr,
    ieeeAddr: null,
    name: `Unknown 0x${addr.toString(16)}`,
    type: 'ghost',
    stats: {
      tx: 0, txSuccess: 0, txError: 0, rx: 0, successRate: null,
    },
    capabilities: null,
    endpoints: [],
    bindings: null,
    isGhost: true,
    isCoordinator: false,
    hasRoute: false,
    hops: null,
    path: null,
    childCount: 0,
    descendantCount: 0,
    uplinkGrade: 'unknown',
    uplinkRate: null,
  };
}

export function buildGraph(state: ZigbeeState): Graph {
  const controller = state.controllerState ?? {};
  const routes = controller.routes ?? {};
  const rawNodes = state.nodes ?? {};

  const byAddr = new Map<number, GraphNode>();

  Object.entries(rawNodes).forEach(([ieee, node]) => {
    const addr = node.nwkAddr ?? node.networkAddress;
    if (addr == null) return;
    byAddr.set(addr, buildNode(addr, ieee, node));
  });

  // Devices that only exist in the routing table (stale entries left behind by
  // a device that was removed or re-joined with a new address).
  Object.keys(routes).forEach((key) => {
    const addr = Number(key);
    if (!byAddr.has(addr)) byAddr.set(addr, ghostNode(addr));
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

  // ---- links ------------------------------------------------------------
  const links = new Map<string, GraphLink>();
  const addLink = (source: number, target: number, kind: GraphLink['kind']) => {
    const id = `${source}->${target}:${kind}`;
    if (!links.has(id)) {
      links.set(id, {
        id, source, target, kind,
      });
    }
    return links.get(id) as GraphLink;
  };

  byAddr.forEach((node) => {
    if (!node.path || node.path.length < 2) return;
    for (let i = 0; i < node.path.length - 1; i += 1) {
      addLink(node.path[i], node.path[i + 1], 'route');
    }
    node.parent = node.path[node.path.length - 2];
  });

  // Bindings are logical (cluster-level) relations, not routing. They are kept
  // as a separate layer the UI can toggle on.
  byAddr.forEach((node) => {
    Object.entries(node.bindings ?? {}).forEach(([targetIeee, clusters]) => {
      const target = [...byAddr.values()].find((n) => n.ieeeAddr === targetIeee);
      if (!target || target.addr === node.addr) return;
      addLink(node.addr, target.addr, 'binding').clusters = clusters;
    });
  });

  // ---- link quality -----------------------------------------------------
  // Every route link a->b is b's uplink (b.parent === a, because the route
  // lists are prefix-consistent), so b's TX counters describe that hop.
  links.forEach((link) => {
    if (link.kind !== 'route') return;
    const child = byAddr.get(link.target);
    if (!child) return;
    const { successRate, tx, txError } = child.stats;
    link.rate = successRate;
    link.sample = tx;
    link.txError = txError;
    link.grade = gradeFor(successRate, tx);
    child.uplinkGrade = link.grade;
    child.uplinkRate = successRate;
  });

  // ---- derived stats ----------------------------------------------------
  const childCount = new Map<number, number>();
  byAddr.forEach((node) => {
    if (node.parent === undefined) return;
    childCount.set(node.parent, (childCount.get(node.parent) ?? 0) + 1);
  });
  byAddr.forEach((node) => {
    node.childCount = childCount.get(node.addr) ?? 0;
  });
  byAddr.forEach((node) => {
    (node.path ?? []).slice(0, -1).forEach((hop) => {
      const relay = byAddr.get(hop);
      if (relay) relay.descendantCount += 1;
    });
  });

  const nodes = [...byAddr.values()].sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99));
  const linkList = [...links.values()];

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
      ready: state.zigbee_ready,
      error: state.zigbee_error,
      nodeCount: nodes.length,
      deviceCount: nodes.filter((n) => !n.isGhost).length,
      routerCount: nodes.filter((n) => n.type === 'router').length,
      endDeviceCount: nodes.filter((n) => n.type === 'enddevice').length,
      ghostCount: nodes.filter((n) => n.isGhost).length,
      unreachableCount: nodes.filter((n) => !n.hasRoute && !n.isCoordinator).length,
      bindingCount: linkList.filter((l) => l.kind === 'binding').length,
      maxHops: nodes.reduce((max, n) => Math.max(max, n.hops ?? 0), 0),
      weakLinkCount: linkList.filter((l) => l.grade === 'weak' || l.grade === 'bad').length,
      generatedAt: Date.now(),
    },
    nodes,
    links: linkList,
  };
}
