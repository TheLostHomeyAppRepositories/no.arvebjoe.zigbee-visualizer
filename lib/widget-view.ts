'use strict';

import type { Grade, Graph, GraphNode } from './zigbee-graph';

/**
 * The dashboard widget's view of the network: the graph from buildGraph(),
 * already laid out, and cut down to what a small read-only map draws.
 *
 * The layout is the settings page's radial tree. The routing table really is a
 * tree — every device has exactly one parent relay — so each device gets an
 * angular slice in proportion to how many leaves hang off it, and each hop
 * level sits on its own ring. Positions are in layout units centred on (0,0);
 * the widget scales them to whatever size the dashboard gives it.
 */

/** Distance between two hop rings, in layout units. */
const RING_GAP = 100;

/** How a device is drawn: the controller as a star, routers as squares, the rest as circles. */
export type WidgetShape = 'controller' | 'router' | 'device';

export type WidgetNode = {
  addr: number;
  name: string;
  shape: WidgetShape;
  /** Hop count for the colour, capped at 4; null for a device without a route. */
  hops: number | null;
  isGhost: boolean;
  /** How many devices route through this one, for its size. */
  relays: number;
  /** The grade of the hop to its parent. */
  grade: Grade;
  /** That hop's TX success rate, 0–1. */
  rate: number | null;
  /** The route from the controller (addr 0) to this device, inclusive. */
  path: number[] | null;
  x: number;
  y: number;
};

export type WidgetLink = {
  source: number;
  target: number;
  grade: Grade;
  /** TX count behind the grade, for the stroke width. */
  sample: number;
};

export type WidgetView = {
  generatedAt: number;
  error: string | null;
  channel: number | null;
  /** Radii of the hop rings, innermost first. */
  rings: number[];
  nodes: WidgetNode[];
  links: WidgetLink[];
  /** Route links per grade. */
  grades: Record<Grade, number>;
  deviceCount: number;
  ghostCount: number;
  unreachableCount: number;
};

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * Places every node of `nodes` on the radial tree. Devices with no route in
 * view are hung off the controller on a ring of their own, so they stay in the
 * picture instead of dropping out of it.
 */
function layout(nodes: GraphNode[], maxHops: number): Map<number, { x: number; y: number }> {
  const present = new Map(nodes.map((n) => [n.addr, n]));
  const children = new Map<number, GraphNode[]>();
  let rootNode: GraphNode | undefined;
  nodes.forEach((n) => {
    if (n.isCoordinator) {
      rootNode = n;
      return;
    }
    const parent = n.parent != null && present.has(n.parent) ? n.parent : 0;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  });

  const placed = new Map<number, { x: number; y: number }>();
  if (!rootNode) return placed;

  const unrouted = maxHops + 0.5;
  const ringOf = (n: GraphNode) => {
    if (n.isCoordinator) return 0;
    return (n.hops == null ? unrouted : Math.min(n.hops, maxHops)) * RING_GAP;
  };

  const leafCache = new Map<number, number>();
  const leaves = (n: GraphNode): number => {
    const cached = leafCache.get(n.addr);
    if (cached != null) return cached;
    const kids = children.get(n.addr) ?? [];
    const count = kids.length ? kids.reduce((sum, c) => sum + leaves(c), 0) : 1;
    leafCache.set(n.addr, count);
    return count;
  };

  const assign = (n: GraphNode, a0: number, a1: number) => {
    const angle = (a0 + a1) / 2;
    const r = ringOf(n);
    placed.set(n.addr, {
      x: round(r * Math.cos(angle - Math.PI / 2)),
      y: round(r * Math.sin(angle - Math.PI / 2)),
    });

    const kids = children.get(n.addr) ?? [];
    const total = kids.reduce((sum, c) => sum + leaves(c), 0) || 1;
    let a = a0;
    kids.forEach((c) => {
      const span = (a1 - a0) * (leaves(c) / total);
      assign(c, a, a + span);
      a += span;
    });
  };

  assign(rootNode, 0, 2 * Math.PI);
  return placed;
}

export function buildWidgetView(graph: Graph, options: { ghosts: boolean }): WidgetView {
  const nodes = graph.nodes.filter((n) => options.ghosts || !n.isGhost);
  const inView = new Set(nodes.map((n) => n.addr));
  const maxHops = Math.max(graph.meta.maxHops, 1);
  const positions = layout(nodes, maxHops);

  const routeLinks = graph.links.filter((l) => l.kind === 'route');
  const grades: Record<Grade, number> = {
    good: 0, fair: 0, weak: 0, bad: 0, unknown: 0,
  };
  routeLinks.forEach((l) => {
    grades[l.grade ?? 'unknown'] += 1;
  });

  const shapeOf = (n: GraphNode): WidgetShape => {
    if (n.isCoordinator) return 'controller';
    return n.type === 'router' ? 'router' : 'device';
  };

  return {
    generatedAt: graph.meta.generatedAt,
    error: graph.meta.error ?? null,
    channel: graph.controller.channel ?? null,
    rings: Array.from({ length: maxHops }, (_, i) => (i + 1) * RING_GAP),
    nodes: nodes
      .filter((n) => positions.has(n.addr))
      .map((n) => {
        const at = positions.get(n.addr) as { x: number; y: number };
        return {
          addr: n.addr,
          name: n.name,
          shape: shapeOf(n),
          hops: n.hops == null ? null : Math.min(n.hops, 4),
          isGhost: n.isGhost,
          relays: n.descendantCount,
          grade: n.uplinkGrade,
          rate: n.uplinkRate,
          path: n.path,
          x: at.x,
          y: at.y,
        };
      }),
    links: routeLinks
      .filter((l) => inView.has(l.source) && inView.has(l.target))
      .map((l) => ({
        source: l.source,
        target: l.target,
        grade: l.grade ?? 'unknown',
        sample: l.sample ?? 0,
      })),
    grades,
    deviceCount: graph.meta.deviceCount,
    ghostCount: graph.meta.ghostCount,
    unreachableCount: graph.meta.unreachableCount,
  };
}
