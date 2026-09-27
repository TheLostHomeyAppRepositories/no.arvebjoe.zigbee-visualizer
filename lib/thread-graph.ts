'use strict';

/**
 * Turns Homey's Thread and Matter state into a graph model.
 *
 * Thread has no routing table to read the way Zigbee does, so the map is put
 * together from three sources:
 *
 *   - `thread.getNetworkTopology()` : every router and child on the network,
 *     with its RLOC16 and, for routers, its IPv6 addresses. Children carry only
 *     the link to their parent. Its router-to-router links are too sparse to
 *     route by (a router that talks to eight others lists one), so they are
 *     only a last resort.
 *   - `matter.getMatterNodes()` : the Matter devices, with their names, what
 *     network each is on and its IPv6 address, which is how a Matter node is
 *     matched to a Thread router.
 *   - `matter.nodeThreadNetworkInformation()` per node : Thread's own network
 *     diagnostics, where a device supports them. A router lists every other
 *     router with link quality both ways (0–3) and its signal strength; a
 *     sleepy end device lists its parent.
 *
 * Thread routers route along the cheapest path, where a link's cost follows
 * from its link quality (3 → 1, 2 → 2, 1 → 4, 0 → no link). The route to each
 * device is that cheapest path from Homey's own router, found here with
 * Dijkstra over every link the diagnostics report.
 *
 * Matter devices on Wi-Fi or Ethernet are not part of the mesh; they hang off
 * Homey directly, graded by Wi-Fi signal where they report it.
 */

import {
  blankNode, Fact, finishGraph, Grade, Graph, GraphLink, GraphNode,
} from './graph.js';

/** One router or child in `thread.getNetworkTopology()`. */
export type ThreadTopologyEntry = {
  rloc?: number;
  extendedAddress?: string;
  type?: string;
  ipAddresses?: string[];
  links?: Array<{ rloc?: number; quality?: number }>;
};

/** One entry of a router's neighbour table, from Thread network diagnostics. */
type NeighborEntry = {
  extAddress?: string;
  rloc16?: number;
  lqi?: number;
  averageRssi?: number;
  lastRssi?: number;
  frameErrorRate?: number;
  messageErrorRate?: number;
  isChild?: boolean;
};

/** One entry of a router's route table, from Thread network diagnostics. */
type RouteEntry = {
  rloc16?: number;
  LQIIn?: number;
  LQIOut?: number;
  linkEstablished?: boolean;
};

/** What `matter.nodeThreadNetworkInformation()` answers, as far as it is read here. */
export type ThreadDiagnostics = {
  networkName?: string;
  panId?: number;
  extendedPanId?: string;
  channel?: number;
  routingRole?: string;
  leaderRouterId?: number;
  neighborTable?: NeighborEntry[];
  routeTable?: RouteEntry[];
};

/** What `matter.nodeWiFiNetworkInformation()` answers, as far as it is read here. */
export type WifiDiagnostics = { channel?: number; rssi?: number };

/** One node of `matter.getMatterNodes()`, as far as it is read here. */
export type MatterNode = {
  id?: string;
  nodeId?: number;
  bridgeDeviceId?: string | null;
  basicInformation?: {
    vendorName?: string;
    productName?: string;
    softwareVersionString?: string;
  };
  network?: { type?: string; name?: string };
  ipAddress?: string | null;
  devices?: Array<{ homeyDeviceId?: string }>;
  hasLeftFabric?: boolean;
};

/** Everything the builder reads. Each part may be missing: a Homey without Thread still has Matter. */
export type ThreadInput = {
  state?: { ready?: boolean; extPanId?: string } | null;
  topology?: ThreadTopologyEntry[] | null;
  matterNodes?: Record<string, MatterNode> | MatterNode[] | null;
  /** Per Matter node id; a node that doesn't support diagnostics is simply absent. */
  diagnostics?: Record<string, { thread?: ThreadDiagnostics | null; wifi?: WifiDiagnostics | null }>;
  /** Homey's device names by device id, so a Matter node gets the name the user gave it. */
  deviceNames?: Record<string, string>;
  error?: string | null;
};

/** Graph ids for devices that have no RLOC16 of their own: Wi-Fi and Ethernet Matter, and the like. */
const OFF_MESH_BASE = 0x20000;

/** What a link of each Thread link quality costs to route over; 0 is no link. */
const LINK_COST = [Infinity, 4, 2, 1];

const LQ_GRADE: Grade[] = ['bad', 'weak', 'fair', 'good'];

/** Wi-Fi signal grades, in dBm. */
const WIFI_GRADES: Array<{ grade: Grade; min: number }> = [
  { grade: 'good', min: -60 },
  { grade: 'fair', min: -70 },
  { grade: 'weak', min: -80 },
  { grade: 'bad', min: -Infinity },
];

const hex = (rloc: number) => `0x${rloc.toString(16).padStart(4, '0')}`;

/** RLOC16 of a router: its router id in the top six bits, child id 0. */
const routerOf = (rloc: number) => rloc & 0xfc00;

/**
 * Whether a router carries the addresses Homey's border router takes: the
 * leader (fc00), the backbone router (fc38) or the DHCPv6/SLAAC agents
 * (fc10–fc2f). With one Homey on the network, it is the router with most of them.
 */
function serviceScore(entry: ThreadTopologyEntry): number {
  return (entry.ipAddresses ?? []).filter((ip) => /:0:ff:fe00:fc(00|38|[12][0-9a-f])$/i.test(ip)).length;
}

/** The Matter nodes as a list, whether the API answers with a list or an object keyed by id. */
function matterList(nodes: ThreadInput['matterNodes']): MatterNode[] {
  if (!nodes) return [];
  return Array.isArray(nodes) ? nodes : Object.entries(nodes).map(([id, node]) => ({ id, ...node }));
}

/** A link's Thread link quality, read both ways: the worse of the two counts. */
type Edge = { a: number; b: number; lq: number; rssi?: number; errorRate?: number };

/** The neighbour relation, undirected, keyed "low-high". */
class Edges {

  private edges = new Map<string, Edge>();

  private static key(a: number, b: number) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  /** Records what one side saw; a link seen from both sides keeps the worse figures. */
  add(a: number, b: number, lq: number, extra: { rssi?: number; errorRate?: number } = {}) {
    if (a === b) return;
    const key = Edges.key(a, b);
    const had = this.edges.get(key);
    if (!had) {
      this.edges.set(key, {
        a, b, lq, ...extra,
      });
      return;
    }
    had.lq = Math.min(had.lq, lq);
    if (extra.rssi != null) had.rssi = had.rssi == null ? extra.rssi : Math.min(had.rssi, extra.rssi);
    if (extra.errorRate != null) had.errorRate = Math.max(had.errorRate ?? 0, extra.errorRate);
  }

  has(a: number, b: number) {
    return this.edges.has(Edges.key(a, b));
  }

  get(a: number, b: number) {
    return this.edges.get(Edges.key(a, b));
  }

  neighbours(of: number): Array<{ to: number; edge: Edge }> {
    const out: Array<{ to: number; edge: Edge }> = [];
    this.edges.forEach((edge) => {
      if (edge.a === of) out.push({ to: edge.b, edge });
      else if (edge.b === of) out.push({ to: edge.a, edge });
    });
    return out;
  }

}

/** The cheapest path from `root` to every node it can reach, as each node's previous hop. */
function shortestPaths(root: number, edges: Edges, nodes: number[]): Map<number, number[]> {
  const cost = new Map<number, number>([[root, 0]]);
  const previous = new Map<number, number>();
  const open = new Set(nodes);
  while (open.size) {
    let here: number | undefined;
    open.forEach((n) => {
      if (!cost.has(n)) return;
      // Ties go to the lower address, so the same state always draws the same map.
      if (here === undefined || (cost.get(n) as number) < (cost.get(here) as number)
        || ((cost.get(n) as number) === (cost.get(here) as number) && n < here)) here = n;
    });
    if (here === undefined) break;
    open.delete(here);
    const base = cost.get(here) as number;
    edges.neighbours(here).forEach(({ to, edge }) => {
      if (!open.has(to)) return;
      const next = base + LINK_COST[edge.lq];
      if (!Number.isFinite(next)) return;
      const had = cost.get(to);
      if (had === undefined || next < had || (next === had && here as number < (previous.get(to) as number))) {
        cost.set(to, next);
        previous.set(to, here as number);
      }
    });
  }

  const paths = new Map<number, number[]>();
  const walk = (n: number): number[] => {
    const known = paths.get(n);
    if (known) return known;
    const path = n === root ? [n] : [...walk(previous.get(n) as number), n];
    paths.set(n, path);
    return path;
  };
  cost.forEach((_, n) => walk(n));
  return paths;
}

function wifiGrade(rssi: number | undefined): Grade {
  if (rssi == null || rssi === 0) return 'unknown';
  return (WIFI_GRADES.find((g) => rssi >= g.min) as { grade: Grade }).grade;
}

const lqGrade = (lq: number | undefined): Grade => (lq == null ? 'unknown' : LQ_GRADE[lq] ?? 'unknown');

const dbm = (rssi: number) => `${rssi < 0 ? '−' : ''}${Math.abs(rssi)} dBm`;

export function buildThreadGraph(input: ThreadInput): Graph {
  const topology = input.topology ?? [];
  const names = input.deviceNames ?? {};
  const byAddr = new Map<number, GraphNode>();
  const edges = new Edges();

  // ---- Homey --------------------------------------------------------------
  // Homey's border router is the router with the border-router service addresses.
  const routers = topology.filter((t) => t.type === 'router' && t.rloc != null);
  const homeyEntry = [...routers].sort((a, b) => serviceScore(b) - serviceScore(a))[0];
  const homeyRloc = homeyEntry?.rloc;
  /** The graph id of an RLOC16: Homey is 0, and a device at RLOC16 0 moves out of its way. */
  const idOf = (rloc: number) => {
    if (rloc === homeyRloc) return 0;
    return rloc === 0 ? OFF_MESH_BASE - 1 : rloc;
  };

  const homey = {
    ...blankNode(0, 'Homey', 'coordinator'),
    isCoordinator: true,
    hops: 0,
    path: [0],
    addrLabel: homeyRloc != null ? hex(homeyRloc) : '—',
    nwkAddr: homeyRloc ?? 0,
    key: 'homey',
  };
  byAddr.set(0, homey);

  // ---- the mesh, from the topology ----------------------------------------
  topology.forEach((t) => {
    if (t.rloc == null || t.rloc === homeyRloc) return;
    const isRouter = t.type === 'router';
    const node = {
      ...blankNode(idOf(t.rloc), isRouter ? `Thread router ${hex(t.rloc)}` : `Thread device ${hex(t.rloc)}`, isRouter ? 'router' : 'enddevice'),
      nwkAddr: t.rloc,
      addrLabel: hex(t.rloc),
      ieeeAddr: t.extendedAddress ?? null,
      // A child's RLOC16 changes with its parent, and it has no other address to go by.
      key: isRouter && t.extendedAddress ? `ext:${t.extendedAddress}` : undefined,
      facts: [{ label: 'Thread role', value: isRouter ? 'Router' : 'Child' }],
      note: isRouter ? 'Not a Matter device of this Homey, so only Thread knows it.' : undefined,
    };
    byAddr.set(node.addr, node);
  });
  // A child reaches the mesh through its parent only; routers route among themselves.
  topology.forEach((t) => {
    if (t.rloc == null || t.type === 'router') return;
    const parent = t.links?.find((l) => l.rloc != null && routerOf(l.rloc) === routerOf(t.rloc as number))
      ?? t.links?.[0];
    if (parent?.rloc != null) edges.add(idOf(parent.rloc), idOf(t.rloc), parent.quality ?? 0);
  });

  // ---- Matter devices -----------------------------------------------------
  const byIp = new Map<string, number>();
  topology.forEach((t) => (t.ipAddresses ?? []).forEach((ip) => {
    if (t.rloc != null) byIp.set(ip.toLowerCase(), idOf(t.rloc));
  }));
  const diagnostics = input.diagnostics ?? {};
  const isHomeyNetwork = (d: ThreadDiagnostics | null | undefined) => !d?.extendedPanId || !input.state?.extPanId
    || d.extendedPanId.replace(/:/g, '').toLowerCase() === input.state.extPanId.toLowerCase();

  let spare = OFF_MESH_BASE;
  /** Children that a Matter end device has already claimed, so two don't take the same one. */
  const claimed = new Set<number>();
  const byExt = new Map<string, number>();
  topology.forEach((t) => {
    if (t.extendedAddress && t.rloc != null) byExt.set(t.extendedAddress.replace(/:/g, '').toLowerCase(), idOf(t.rloc));
  });
  /** A neighbour's graph id: by RLOC16, else by its extended address. */
  const neighbourId = (n: NeighborEntry | RouteEntry): number | undefined => {
    const ext = 'extAddress' in n && n.extAddress ? byExt.get(n.extAddress.replace(/:/g, '').toLowerCase()) : undefined;
    if (ext !== undefined) return ext;
    return n.rloc16 != null ? idOf(n.rloc16) : undefined;
  };

  matterList(input.matterNodes).forEach((m) => {
    if (m.hasLeftFabric) return;
    const info = m.basicInformation ?? {};
    const homeyIds = (m.devices ?? []).map((d) => d.homeyDeviceId).filter((id): id is string => Boolean(id));
    const named = homeyIds.map((id) => names[id]).find(Boolean);
    const name = named || info.productName || `Matter node ${m.nodeId ?? m.id}`;
    const medium = m.network?.type ?? 'unknown';
    const diag = m.id ? diagnostics[m.id] : undefined;
    const thread = isHomeyNetwork(diag?.thread) ? diag?.thread : undefined;

    const facts: Fact[] = [
      { label: 'Network', value: { thread: 'Thread', wifi: 'Wi-Fi', ethernet: 'Ethernet' }[medium] ?? 'Unknown' },
    ];
    if (thread?.routingRole) facts.push({ label: 'Thread role', value: thread.routingRole });
    if (info.vendorName) facts.push({ label: 'Vendor', value: info.vendorName });
    if (info.productName) facts.push({ label: 'Product', value: info.productName });
    if (info.softwareVersionString) facts.push({ label: 'Firmware', value: info.softwareVersionString });
    if (m.ipAddress) facts.push({ label: 'IP address', value: m.ipAddress });
    if (homeyIds.length > 1) facts.push({ label: 'Homey devices', value: String(homeyIds.length) });
    if (m.bridgeDeviceId) facts.push({ label: 'Bridge', value: `bridges ${homeyIds.length - 1} devices` });
    if (diag?.wifi?.rssi) facts.push({ label: 'Wi-Fi signal', value: dbm(diag.wifi.rssi) });
    if (diag?.wifi?.channel) facts.push({ label: 'Wi-Fi channel', value: String(diag.wifi.channel) });

    const details = {
      name,
      manufacturerName: info.vendorName,
      modelId: info.productName,
      swBuildId: info.softwareVersionString,
      ownerUri: homeyIds[0] ? `homey:device:${homeyIds[0]}` : undefined,
      key: `matter:${m.id ?? m.nodeId}`,
      facts,
    };

    // A Thread router is found by its IPv6 address.
    const onMesh = m.ipAddress ? byIp.get(m.ipAddress.toLowerCase()) : undefined;
    if (onMesh !== undefined && onMesh !== 0) {
      const node = byAddr.get(onMesh) as GraphNode;
      Object.assign(node, details, { note: undefined, facts: [...facts, ...(node.facts ?? []).filter((f) => f.label !== 'Thread role' || !thread?.routingRole)] });
    }

    // A sleepy device isn't in the topology by address; its diagnostics name its
    // parent, and it takes over one of that parent's unnamed children.
    let id = onMesh;
    const parentEntry = !onMesh && thread?.neighborTable?.length === 1 ? thread.neighborTable[0] : undefined;
    const parentId = parentEntry ? neighbourId(parentEntry) : undefined;
    if (id === undefined && parentId !== undefined) {
      const free = [...byAddr.values()].filter((n) => n.type === 'enddevice' && !claimed.has(n.addr)
        && !n.ownerUri && edges.has(parentId, n.addr));
      const [child] = free;
      if (child) {
        id = child.addr;
        claimed.add(id);
        Object.assign(child, details, {
          facts: thread?.routingRole ? facts : [...facts, { label: 'Thread role', value: 'Child' }],
          // A sleepy device doesn't report its own RLOC16, only its parent's.
          note: free.length > 1 ? `Its parent has ${free.length} children Homey can't tell apart, so its address is a guess.` : undefined,
        });
      }
    }

    if (id === undefined) {
      id = spare;
      spare += 1;
      const node: GraphNode = {
        ...blankNode(id, name, medium === 'thread' ? 'enddevice' : 'device'),
        ...details,
        addrLabel: ({ wifi: 'Wi-Fi', ethernet: 'Ethernet' } as Record<string, string>)[medium] ?? '—',
      };
      if (medium === 'thread' && parentId === undefined) {
        node.note = 'A sleepy Thread device that didn\'t answer Homey\'s diagnostics, so its parent isn\'t known.';
      } else if (medium === 'unknown') {
        node.note = 'Homey doesn\'t know which network this device is on.';
      }
      byAddr.set(id, node);
      if (medium === 'wifi' || medium === 'ethernet') {
        edges.add(0, id, 3, { rssi: diag?.wifi?.rssi || undefined });
      }
    }
    if (parentId !== undefined && parentEntry) {
      edges.add(parentId, id, parentEntry.lqi ?? 0, { rssi: parentEntry.averageRssi, errorRate: parentEntry.frameErrorRate });
    }

    // A router's diagnostics give its links to every router it hears.
    if (thread && onMesh !== undefined) {
      const rssiOf = new Map<number, NeighborEntry>();
      (thread.neighborTable ?? []).forEach((n) => {
        const to = neighbourId(n);
        if (to !== undefined) rssiOf.set(to, n);
      });
      (thread.routeTable ?? []).forEach((r) => {
        const to = neighbourId(r);
        if (to === undefined || !r.linkEstablished) return;
        const neighbour = rssiOf.get(to);
        edges.add(onMesh, to, Math.min(r.LQIIn ?? 0, r.LQIOut ?? 0), {
          rssi: neighbour?.averageRssi, errorRate: neighbour?.frameErrorRate,
        });
      });
      // A router without a route table still has a neighbour table.
      if (!thread.routeTable?.length) {
        rssiOf.forEach((n, to) => edges.add(onMesh, to, n.lqi ?? 0, { rssi: n.averageRssi, errorRate: n.frameErrorRate }));
      }
    }
  });

  // Only where the diagnostics say nothing about a pair of routers does the topology's own link count.
  topology.forEach((t) => {
    if (t.rloc == null || t.type !== 'router') return;
    (t.links ?? []).forEach((l) => {
      if (l.rloc == null) return;
      const other = topology.find((o) => o.rloc === l.rloc);
      if (other?.type !== 'router') return;
      if (!edges.has(idOf(t.rloc as number), idOf(l.rloc))) edges.add(idOf(t.rloc as number), idOf(l.rloc), l.quality ?? 0);
    });
  });

  // ---- routes -------------------------------------------------------------
  const paths = shortestPaths(0, edges, [...byAddr.keys()]);
  byAddr.forEach((node) => {
    if (node.isCoordinator) return;
    const path = paths.get(node.addr);
    if (!path) return;
    node.path = path;
    node.hops = path.length - 1;
    node.hasRoute = true;
  });

  const gradeLink = (link: GraphLink, child: GraphNode) => {
    const edge = edges.get(link.source, link.target);
    const isWifi = child.facts?.some((f) => f.label === 'Network' && f.value === 'Wi-Fi');
    const isEthernet = child.facts?.some((f) => f.label === 'Network' && f.value === 'Ethernet');
    if (isEthernet) {
      Object.assign(link, {
        medium: 'ethernet', grade: 'good', score: 1, label: 'wired', summary: 'Ethernet: wired to the network, no mesh involved',
      });
      return;
    }
    if (isWifi) {
      const rssi = edge?.rssi;
      Object.assign(link, {
        medium: 'wifi',
        grade: wifiGrade(rssi),
        score: rssi != null ? Math.max(0, Math.min(1, (rssi + 100) / 60)) : null,
        label: rssi != null ? dbm(rssi) : '—',
        summary: `Wi-Fi · ${rssi != null ? `signal ${dbm(rssi)}` : 'signal unknown'} · straight to the network, no mesh involved`,
      });
      return;
    }
    const lq = edge?.lq;
    const grade = lqGrade(lq);
    const parts = [`Link quality ${lq ?? '?'} of 3`];
    if (edge?.rssi != null) parts.push(`signal ${dbm(edge.rssi)}`);
    if (edge?.errorRate) parts.push(`${edge.errorRate}% frame errors`);
    Object.assign(link, {
      medium: 'thread',
      grade,
      score: lq == null ? null : lq / 3,
      label: edge?.rssi != null ? dbm(edge.rssi) : `LQ ${lq ?? '?'}`,
      summary: `${grade.charAt(0).toUpperCase()}${grade.slice(1)} link · ${parts.join(' · ')}`,
    });
  };

  const facts: Fact[] = [];
  const anyDiag = Object.values(diagnostics).map((d) => d.thread).find((d) => d && isHomeyNetwork(d));
  if (anyDiag?.networkName) facts.push({ label: 'Network name', value: anyDiag.networkName });
  if (anyDiag?.channel) facts.push({ label: 'Channel', value: String(anyDiag.channel) });
  if (anyDiag?.panId != null) facts.push({ label: 'PAN ID', value: hex(anyDiag.panId) });
  if (input.state?.extPanId) facts.push({ label: 'Extended PAN ID', value: input.state.extPanId });
  if (homeyRloc != null) facts.push({ label: 'Homey RLOC16', value: hex(homeyRloc) });
  facts.push({ label: 'Thread routers', value: String(routers.length) });

  return finishGraph('thread', byAddr, gradeLink, {
    controller: {
      channel: anyDiag?.channel,
      extendedPanId: input.state?.extPanId,
      facts,
    },
    meta: {
      ready: input.state?.ready,
      error: input.error ?? null,
      notice: topology.length ? undefined : 'Homey reported no Thread network.',
    },
  });
}

/**
 * The input cut down to the fields buildThreadGraph() reads, for keeping in the
 * history: a Matter node carries its whole endpoint and subscription tree,
 * which makes a snapshot many times the size it needs to be.
 */
export function trimThreadInput(input: ThreadInput): ThreadInput {
  const nodes = matterList(input.matterNodes).map((m) => ({
    id: m.id,
    nodeId: m.nodeId,
    bridgeDeviceId: m.bridgeDeviceId,
    basicInformation: {
      vendorName: m.basicInformation?.vendorName,
      productName: m.basicInformation?.productName,
      softwareVersionString: m.basicInformation?.softwareVersionString,
    },
    network: m.network,
    ipAddress: m.ipAddress,
    devices: (m.devices ?? []).map((d) => ({ homeyDeviceId: d.homeyDeviceId })),
    hasLeftFabric: m.hasLeftFabric,
  }));

  const diagnostics: NonNullable<ThreadInput['diagnostics']> = {};
  Object.entries(input.diagnostics ?? {}).forEach(([id, d]) => {
    const t = d.thread;
    diagnostics[id] = {
      thread: t ? {
        networkName: t.networkName,
        panId: t.panId,
        extendedPanId: t.extendedPanId,
        channel: t.channel,
        routingRole: t.routingRole,
        neighborTable: (t.neighborTable ?? []).map((n) => ({
          extAddress: n.extAddress,
          rloc16: n.rloc16,
          lqi: n.lqi,
          averageRssi: n.averageRssi,
          frameErrorRate: n.frameErrorRate,
        })),
        routeTable: (t.routeTable ?? []).map((r) => ({
          rloc16: r.rloc16, LQIIn: r.LQIIn, LQIOut: r.LQIOut, linkEstablished: r.linkEstablished,
        })),
      } : null,
      wifi: d.wifi ? { channel: d.wifi.channel, rssi: d.wifi.rssi } : null,
    };
  });

  // Only the names of the Matter devices: the rest of the Homey's devices never show up here.
  const deviceNames: Record<string, string> = {};
  nodes.forEach((m) => m.devices.forEach(({ homeyDeviceId }) => {
    const name = homeyDeviceId && input.deviceNames?.[homeyDeviceId];
    if (name) deviceNames[homeyDeviceId as string] = name;
  }));

  return {
    state: input.state,
    topology: input.topology,
    matterNodes: nodes,
    diagnostics,
    deviceNames,
    error: input.error,
  };
}
