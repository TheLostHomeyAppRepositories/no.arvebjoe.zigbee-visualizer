'use strict';

const HOP_COLORS = ['#f0f6fc', '#4dd4ac', '#58a6ff', '#bc8cff', '#ff8fab'];
const GHOST_COLOR = '#6e7681';

// Link quality, derived from the TX success counters of the device at the far
// end of each hop. The Homey grades them, in lib/zigbee-graph.ts.
const GRADE_LABEL = {
  good: 'Good', fair: 'Fair', weak: 'Weak', bad: 'Bad', unknown: 'Too little traffic',
};
const GRADE_ORDER = ['bad', 'weak', 'fair', 'good', 'unknown'];

// Cluster ids we are likely to meet in a Homey network, for readable endpoints.
const CLUSTERS = {
  0: 'Basic',
  1: 'Power Config',
  3: 'Identify',
  4: 'Groups',
  5: 'Scenes',
  6: 'On/Off',
  8: 'Level Control',
  10: 'Time',
  25: 'OTA Upgrade',
  32: 'Poll Control',
  257: 'Door Lock',
  258: 'Window Covering',
  512: 'Pump Config',
  513: 'Thermostat',
  514: 'Fan Control',
  516: 'Thermostat UI',
  768: 'Color Control',
  769: 'Ballast Config',
  1024: 'Illuminance',
  1026: 'Temperature',
  1027: 'Pressure',
  1028: 'Flow',
  1029: 'Humidity',
  1030: 'Occupancy',
  1280: 'IAS Zone',
  1281: 'IAS ACE',
  1282: 'IAS WD',
  1794: 'Metering',
  2820: 'Electrical Meas.',
  2821: 'Diagnostics',
  4096: 'Touchlink',
  64513: 'Manufacturer',
  64514: 'Manufacturer',
};

const state = {
  graph: null,
  byAddr: new Map(),
  selected: null,
  query: '',
  showBindings: false,
  showGhosts: true,
  showLabels: false,
  layout: 'tree',
  loaderPinned: false,
  panelTab: 'quality',
  trafficScale: 'tx',
  changes: null, // what moved since the snapshot before the one on screen (see diffGraphs)
  keepView: false, // true while a snapshot is swapped in: keep the current zoom and position
};

const svg = d3.select('#canvas');
const root = svg.append('g');
const ringLayer = root.append('g').attr('class', 'rings');
const linkLayer = root.append('g').attr('class', 'links');
const nodeLayer = root.append('g').attr('class', 'nodes');
const tooltip = d3.select('#graph').append('div').attr('class', 'tooltip');

let simulation;
let width = 0;
let height = 0;

const zoom = d3.zoom()
  .scaleExtent([0.2, 5])
  .on('zoom', (event) => root.attr('transform', event.transform));
svg.call(zoom).on('dblclick.zoom', null);

// ---------------------------------------------------------------- data ----

const REMEMBER_KEY = 'zigbee-visualizer.remember';
const rememberBox = document.getElementById('remember');

// A loaded dump used to be kept in this browser; it is kept on the Homey now.
try {
  localStorage.removeItem('zigbee-visualizer.dump.v1');
} catch { /* nothing to do */ }

/** The JSON answer to a request, or a rejection carrying the server's own message. */
function getJson(url, options) {
  return fetch(url, options).then((res) => (res.ok
    ? res.json()
    : res.text().then((text) => Promise.reject(new Error(text || `HTTP ${res.status}`)))));
}

/**
 * Checks the text of a dump, then has the Homey strip its secrets and build its
 * graph, with the same code that draws the live network. With Remember ticked
 * the Homey keeps it beside the snapshots, stripped, for any browser to reopen.
 */
function ingest(text, sourceName) {
  let dump;
  try {
    dump = JSON.parse(text);
  } catch (err) {
    return Promise.reject(new Error(`That is not valid JSON — ${err.message}`));
  }
  if (!dump || typeof dump !== 'object' || (!dump.nodes && !dump.controllerState)) {
    return Promise.reject(new Error('No "nodes" or "controllerState" in there — that does not look like a Homey Zigbee dump.'));
  }

  const remember = rememberBox.checked;
  return getJson(`api/imports${remember ? '?remember=1' : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
  }).then(({ graph, stripped, id }) => {
    graph.meta.source = sourceName;
    showImport(graph, id);
    const storeError = remember && !id ? 'The Homey could not keep it, so you will have to load it again after a refresh.' : null;
    return { stripped, storeError };
  });
}

/** Hands a freshly parsed graph to the rest of the app. */
function show(graph) {
  // Keep positions across reloads so the layout does not jump around.
  const prev = state.byAddr;
  state.graph = graph;
  state.byAddr = new Map();
  for (const node of graph.nodes) {
    const old = prev.get(node.addr);
    if (old) {
      Object.assign(node, {
        x: old.x, y: old.y, vx: 0, vy: 0,
      });
    }
    state.byAddr.set(node.addr, node);
  }

  document.getElementById('source').textContent = graph.meta.source || '';

  renderStats();
  render();
  if (state.selected && state.byAddr.has(state.selected)) select(state.selected);
  else renderOverview();
}

// ------------------------------------------------------------- imports ----
// Dumps loaded with Remember ticked are kept on the Homey, beside the snapshots,
// already stripped of their secrets. They are listed in the loader card.

const importLabel = (it) => `Imported ${new Date(it.takenAt).toLocaleString()}`;

/** Draws one kept import; resolves to false when it can't be read. */
function openImport(it) {
  return getJson(`api/imports/${encodeURIComponent(it.id)}`)
    .then((graph) => {
      graph.meta.source = importLabel(it);
      showImport(graph, it.id);
      return true;
    })
    .catch(() => false);
}

/** Falls back to the newest kept import when the live state can't be read. */
function restore() {
  return getJson('api/imports')
    .then((list) => (list.length ? openImport(list[list.length - 1]) : false))
    .catch(() => false);
}

/** Lists the kept imports in the loader card, newest first. */
function renderImports() {
  const box = document.getElementById('imports');
  getJson('api/imports')
    .then((list) => {
      box.hidden = !list.length;
      box.innerHTML = `<div class="imports-title">Kept on this Homey</div>${list.slice().reverse().map((it) => `
        <div class="import-row">
          <button type="button" class="import-open" data-import="${escapeHtml(it.id)}"
            data-taken="${escapeHtml(it.takenAt)}">${escapeHtml(importLabel(it))}</button>
          <button type="button" class="ghost-btn" data-delete="${escapeHtml(it.id)}" title="Delete from the Homey">&times;</button>
        </div>`).join('')}`;
    })
    .catch(() => {
      box.hidden = true;
    });
}

// -------------------------------------------------------------- loading ----

const loader = document.getElementById('loader');
const dropzone = document.getElementById('dropzone');
const pasteBox = document.getElementById('pasteBox');
const loaderMsg = document.getElementById('loaderMsg');

/** `pinned` = opened deliberately, so a passing drag cannot close it again. */
function openLoader(pinned) {
  if (pinned) state.loaderPinned = true;
  loader.hidden = false;
  document.getElementById('loaderClose').hidden = !state.graph;
  renderImports();
}

function closeLoader() {
  if (!state.graph) return; // nothing to go back to yet
  state.loaderPinned = false;
  loader.hidden = true;
  dropzone.classList.remove('over');
  note('');
}

/** A message inside the loader card — errors and warnings live here. */
function note(text, kind) {
  loaderMsg.textContent = text || '';
  loaderMsg.className = `loader-msg ${kind || ''}`;
  loaderMsg.hidden = !text;
}

/** A passing message over the graph, reusing the hint bar. */
const HINT_TEXT = document.getElementById('hint').textContent;
let hintTimer;
function toast(text, kind) {
  const hint = document.getElementById('hint');
  clearTimeout(hintTimer);
  hint.textContent = text;
  hint.className = `hint ${kind || ''}`;
  hintTimer = setTimeout(() => {
    hint.textContent = HINT_TEXT; hint.className = 'hint';
  }, 8000);
}

function submit(text, sourceName) {
  if (!String(text || '').trim()) return note('Nothing to read there yet.', 'bad');
  note('Reading…');
  return ingest(text, sourceName).then(
    (result) => {
      pasteBox.value = '';
      closeLoader();
      if (result.storeError) toast(result.storeError, 'warn');
      else if (result.stripped.length) toast(`Network key removed from ${sourceName} — it is never stored or drawn.`, 'ok');
    },
    (err) => {
      openLoader(true);
      note(err.message, 'bad');
    },
  );
}

function readFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => submit(String(reader.result), file.name);
  reader.onerror = () => {
    openLoader(true); note(`Could not read ${file.name}.`, 'bad');
  };
  reader.readAsText(file);
}

function renderStats() {
  const m = state.graph.meta;
  const c = state.graph.controller;
  const items = [
    ['Devices', m.deviceCount],
    ['Routers', m.routerCount],
    ['End devices', m.endDeviceCount],
    ['Max hops', m.maxHops],
    ['Channel', c.channel],
    ['PAN', c.panId],
  ];
  if (m.weakLinkCount) items.push(['Weak links', `<span class="stat-warn">${m.weakLinkCount}</span>`]);
  if (m.ghostCount) items.push(['Stale', m.ghostCount]);
  const conflicts = sharedAddresses().length;
  if (conflicts) {
    items.push(['Conflicts', `<button type="button" class="stat-link stat-warn" id="conflictsStat"
      title="Show the devices that share a network address">${conflicts}</button>`]);
  }
  document.getElementById('netstats').innerHTML = items
    .map(([k, v]) => `<div class="netstat"><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join('');
}

// -------------------------------------------------------------- helpers ----

const hopColor = (n) => (n.isGhost ? GHOST_COLOR : HOP_COLORS[Math.min(n.hops ?? 4, 4)]);
const radius = (n) => (n.isCoordinator ? 16 : 6 + Math.min(Math.sqrt(n.descendantCount || 0) * 3.2, 9));
const linkId = (l) => `${typeof l.source === 'object' ? l.source.addr : l.source}->${typeof l.target === 'object' ? l.target.addr : l.target}`;

function visibleNodes() {
  return state.graph.nodes.filter((n) => state.showGhosts || !n.isGhost);
}

function visibleLinks() {
  return state.graph.links.filter((l) => {
    if (l.kind === 'binding' && !state.showBindings) return false;
    if (!state.showGhosts) {
      const s = state.byAddr.get(l.source.addr ?? l.source);
      const t = state.byAddr.get(l.target.addr ?? l.target);
      if (s?.isGhost || t?.isGhost) return false;
    }
    return true;
  });
}

function pathLinkSet(node) {
  const set = new Set();
  if (!node?.path) return set;
  for (let i = 0; i < node.path.length - 1; i++) set.add(`${node.path[i]}->${node.path[i + 1]}`);
  return set;
}

function matches(node) {
  if (!state.query) return false;
  const q = state.query.toLowerCase();
  return [node.name, node.modelId, node.manufacturerName, node.ieeeAddr, String(node.nwkAddr), `0x${node.nwkAddr.toString(16)}`]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

// --------------------------------------------------------------- render ----

function render() {
  const nodes = visibleNodes();
  const links = visibleLinks().map((l) => ({ ...l }));

  linkLayer.selectAll('g.lnk')
    .data(links, (d) => d.id)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'lnk');
      g.append('line').attr('class', 'hit');
      g.append('line');
      return g;
    })
    .on('mouseenter', showLinkTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip)
    .select('line:last-child')
    .attr('class', (d) => `link ${d.kind} q-${d.grade || 'unknown'}`)
    .attr('stroke-width', (d) => linkWidth(d));

  const node = nodeLayer.selectAll('g.node')
    .data(nodes, (d) => d.addr)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'node');
      // Generous invisible hit area — several devices draw as 5px dots.
      g.append('circle').attr('class', 'hit').attr('r', 14).attr('fill', 'transparent');
      g.append('circle').attr('class', 'halo');
      g.append('circle').attr('class', 'change');
      g.append('path').attr('class', 'body');
      g.append('text');
      return g;
    })
    .attr('class', (d) => `node${d.isGhost ? ' ghost' : ''}`)
    .on('click', (event, d) => {
      event.stopPropagation(); select(d.addr);
    })
    .on('mouseenter', showTooltip)
    .on('mousemove', moveTooltip)
    .on('mouseleave', hideTooltip)
    .call(d3.drag().filter(() => state.layout === 'force')
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x; d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      }));

  node.select('circle.hit').attr('r', (d) => radius(d) + 9);

  // A ring around devices whose own uplink is struggling, so problem corners of
  // the mesh are visible without reading a single label.
  node.select('circle.halo')
    .attr('r', (d) => radius(d) + 5)
    .attr('class', (d) => `halo q-${d.uplinkGrade || 'unknown'}`);

  node.select('circle.change').attr('r', (d) => radius(d) + 9);

  node.select('path.body')
    .attr('d', (d) => shapeFor(d))
    .attr('fill', (d) => hopColor(d));

  node.select('text')
    .attr('dy', (d) => radius(d) + 11)
    .attr('class', (d) => (d.isCoordinator || d.type === 'router' ? 'major' : 'minor'))
    .text((d) => (d.isCoordinator ? d.name : shortName(d.name)));

  resolveLinks(links, nodes);
  layout(nodes, links);
  applyHighlight();
}

/**
 * A hop that carries a lot of traffic and fails matters more than a quiet one,
 * so traffic volume sets the stroke width and quality sets the colour.
 */
function linkWidth(l) {
  if (l.kind === 'binding') return 1;
  if (!l.sample) return 1.2;
  return Math.min(0.8 + Math.log10(l.sample + 1), 6);
}

/** forceLink() does this for us; the tree layout needs it done by hand. */
function resolveLinks(links, nodes) {
  const byAddr = new Map(nodes.map((n) => [n.addr, n]));
  for (const l of links) {
    l.source = byAddr.get(l.source.addr ?? l.source) || l.source;
    l.target = byAddr.get(l.target.addr ?? l.target) || l.target;
  }
}

function shapeFor(d) {
  const r = radius(d);
  if (d.isCoordinator) return d3.symbol(d3.symbolStar, r * r * 2.6)();
  if (d.type === 'router') return d3.symbol(d3.symbolSquare, r * r * 3.1)();
  return d3.symbol(d3.symbolCircle, r * r * 3.1)();
}

function shortName(name) {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

/**
 * Two ways to look at the same data:
 *
 *  - "tree"  : the routing table is a real tree (every device has exactly one
 *              parent relay), so a radial tree draws it without overlap and
 *              makes the hop rings obvious. Deterministic and stable.
 *  - "force" : classic physics mesh, nodes can be dragged around.
 */
function layout(nodes, links) {
  const box = document.getElementById('graph').getBoundingClientRect();
  width = box.width; height = box.height;

  // One ring per hop level. Angular spacing is handled by the tree layout, so
  // the rings only need to be far enough apart to keep labels apart; the view
  // is zoomed to fit afterwards.
  const maxHops = Math.max(state.graph.meta.maxHops, 1);
  const unrouted = maxHops + 1;
  const gap = Math.max(90, Math.min(150, (Math.min(width, height) / 2 - 50) / (maxHops + 0.5)));
  const ringRadius = [0];
  for (let k = 1; k <= maxHops; k++) ringRadius[k] = k * gap;
  // Devices with no route sit just outside the last ring.
  ringRadius[unrouted] = (maxHops + 0.5) * gap;
  const ringOf = (d) => ringRadius[d.isCoordinator ? 0 : Math.min(d.hops ?? unrouted, unrouted)];

  if (state.layout === 'tree') treeLayout(nodes, ringRadius, unrouted);
  else forceLayout(nodes, links, ringOf, ringRadius[1]);
  drawRings(ringRadius, maxHops);
}

/**
 * Faint guide rings so you can read the hop level straight off the picture.
 * Only the tree layout earns them: there a node's ring *is* its hop count. The
 * force layout only pulls towards those radii, so the rings would be drawing
 * lines the nodes do not actually sit on — clutter behind the mesh.
 */
function drawRings(ringRadius, maxHops) {
  if (state.layout !== 'tree') {
    ringLayer.selectAll('*').remove();
    return;
  }
  const cx = width / 2;
  const cy = height / 2;
  const stretch = stretchFactor();
  const data = d3.range(1, maxHops + 1).map((k) => ({ k, r: ringRadius[k] }));

  ringLayer.selectAll('ellipse').data(data, (d) => d.k).join('ellipse')
    .attr('cx', cx)
    .attr('cy', cy)
    .attr('rx', (d) => d.r * stretch)
    .attr('ry', (d) => d.r)
    .attr('class', 'ring');

  ringLayer.selectAll('text').data(data, (d) => d.k).join('text')
    .attr('x', cx)
    .attr('y', (d) => cy - d.r - 5)
    .attr('class', 'ring-label')
    .text((d) => `${d.k} hop${d.k === 1 ? '' : 's'}`);
}

function stretchFactor() {
  // The canvas is wider than it is tall, so widen the rings into an ellipse
  // instead of leaving empty space left and right.
  return Math.max(1, Math.min(1.35, width / Math.max(height, 1)));
}

function treeLayout(nodes, ringRadius, unrouted) {
  if (simulation) simulation.stop();

  const present = new Set(nodes.map((n) => n.addr));
  const root = d3.stratify()
    .id((d) => d.addr)
    // Devices the controller has no route for are hung off the controller so
    // they stay visible instead of disappearing from the picture.
    .parentId((d) => {
      if (d.isCoordinator) return null;
      return present.has(d.parent) ? d.parent : 0;
    })(nodes);

  const outer = ringRadius[unrouted];
  d3.tree()
    .size([2 * Math.PI, outer])
    .separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(a.depth, 1))(root);

  const cx = width / 2;
  const cy = height / 2;
  const stretch = stretchFactor();
  for (const point of root.descendants()) {
    const node = point.data;
    const angle = point.x - Math.PI / 2;
    const r = ringRadius[Math.min(node.isCoordinator ? 0 : node.hops ?? unrouted, unrouted)];
    node.x = cx + r * stretch * Math.cos(angle);
    node.y = cy + r * Math.sin(angle);
    node.angle = point.x;
    node.fx = node.x;
    node.fy = node.y;
  }
  tick();
  if (!state.keepView) fitToView();
}

function forceLayout(nodes, links, ringOf, ringGap) {
  const cx = width / 2;
  const cy = height / 2;
  for (const n of nodes) {
    n.fx = null; n.fy = null; n.angle = null;
  }

  // The controller is the anchor of the whole picture, so it stays put.
  const coordinator = nodes.find((n) => n.isCoordinator);
  if (coordinator) {
    coordinator.fx = cx; coordinator.fy = cy;
  }

  if (!simulation) {
    simulation = d3.forceSimulation().on('tick', tick).on('end', fitToView);
  }
  simulation
    .nodes(nodes)
    .force('link', d3.forceLink(links).id((d) => d.addr)
      .distance((l) => (l.kind === 'binding' ? 160 : ringGap * 0.8))
      .strength((l) => (l.kind === 'binding' ? 0.03 : 0.2)))
    .force('charge', d3.forceManyBody().strength(-260).distanceMax(500))
    .force('collide', d3.forceCollide().radius((d) => radius(d) + 22).strength(0.9))
    .force('r', d3.forceRadial(ringOf, cx, cy).strength(0.85))
    .velocityDecay(0.45)
    .alpha(0.9)
    .alphaDecay(0.03)
    .restart();
}

/** Pan/zoom so the whole network is comfortably inside the viewport. */
function fitToView() {
  const nodes = visibleNodes().filter((n) => Number.isFinite(n.x));
  if (!nodes.length) return;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const pad = 50;
  const minX = Math.min(...xs) - pad; const
    maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad; const
    maxY = Math.max(...ys) + pad;
  const scale = Math.min(2, Math.min(width / (maxX - minX), height / (maxY - minY)));
  const tx = width / 2 - (scale * (minX + maxX)) / 2;
  const ty = height / 2 - (scale * (minY + maxY)) / 2;
  svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

function tick() {
  linkLayer.selectAll('g.lnk line')
    .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
    .attr('x2', (d) => d.target.x)
    .attr('y2', (d) => d.target.y);
  nodeLayer.selectAll('g.node').attr('transform', (d) => `translate(${d.x},${d.y})`);
}

// ------------------------------------------------------------ highlight ----

function applyHighlight() {
  const sel = state.selected != null ? state.byAddr.get(state.selected) : null;
  const onPath = new Set(sel?.path || []);
  const pathLinks = pathLinkSet(sel);
  // A search with nothing selected fades everything that does not match, so a
  // couple of hits stand out in a mesh of sixty rather than being two slightly
  // differently outlined dots.
  const searching = Boolean(state.query) && !sel;

  nodeLayer.selectAll('g.node')
    .classed('selected', (d) => sel && d.addr === sel.addr)
    .classed('onpath', (d) => onPath.has(d.addr))
    .classed('match', (d) => matches(d))
    .classed('changed', (d) => Boolean(state.changes?.has(nodeKey(d))))
    .classed('dim', (d) => (sel ? !onPath.has(d.addr) && !isNeighbor(sel, d) : searching && !matches(d)))
    .select('text')
    .attr('display', (d) => (labelVisible(d, sel, onPath) ? null : 'none'));

  linkLayer.selectAll('g.lnk line:last-child')
    .classed('path', (d) => pathLinks.has(linkId(d)))
    .classed('dim', (d) => (sel ? !pathLinks.has(linkId(d)) : searching));
}

/**
 * Showing 62 labels at once is unreadable, so by default only the nodes that
 * carry traffic (controller + routers) are named. "All labels" opts into the
 * rest; selection, path and search always win.
 */
function labelVisible(d, sel, onPath) {
  if (state.showLabels) return true;
  if (onPath.has(d.addr) || matches(d)) return true;
  return d.isCoordinator || d.type === 'router' || Boolean(d.probablyWas);
}

function isNeighbor(sel, d) {
  return d.parent === sel.addr || sel.parent === d.addr;
}

// -------------------------------------------------------------- tooltip ----

function showTooltip(event, d) {
  tooltip.html(`
    <div class="t-name">${escapeHtml(d.name)}</div>
    <div class="t-meta">${escapeHtml(d.modelId || 'unknown model')}<br>
    0x${d.nwkAddr.toString(16)} · ${d.type}${d.hops != null ? ` · ${d.hops} hop${d.hops === 1 ? '' : 's'}` : ' · no route'}</div>
  `).style('opacity', 1);
  moveTooltip(event);
}
function showLinkTooltip(event, d) {
  if (d.kind === 'binding') {
    tooltip.html(`<div class="t-name">Binding</div>
      <div class="t-meta">${escapeHtml(d.source.name)} → ${escapeHtml(d.target.name)}<br>
      ${(d.clusters || []).length} cluster binding(s)</div>`).style('opacity', 1);
  } else {
    tooltip.html(`<div class="t-name">${escapeHtml(d.source.name)} → ${escapeHtml(d.target.name)}</div>
      <div class="t-meta">${qualityLine(d)}</div>`).style('opacity', 1);
  }
  moveTooltip(event);
}

function qualityLine(l) {
  if (l.grade === 'unknown') {
    return `Link quality unknown · only ${l.sample || 0} transmissions`;
  }
  return `${GRADE_LABEL[l.grade]} link · ${Math.round(l.rate * 100)}% of ${l.sample.toLocaleString()} transmissions got through`;
}

function moveTooltip(event) {
  const box = document.getElementById('graph').getBoundingClientRect();
  tooltip.style('left', `${event.clientX - box.left + 14}px`).style('top', `${event.clientY - box.top + 14}px`);
}
function hideTooltip() {
  tooltip.style('opacity', 0);
}

// ---------------------------------------------------------------- panel ----

function select(addr) {
  state.selected = addr;
  document.getElementById('hint').style.opacity = 0;
  applyHighlight();
  renderPanel(state.byAddr.get(addr));
}

function clearSelection() {
  state.selected = null;
  applyHighlight();
  renderOverview();
}

const PANEL_TABS = [['quality', 'Link quality'], ['traffic', 'Traffic'], ['changes', 'Changes']];

/** With nothing selected, the panel shows a tab bar over the active tab. */
function renderOverview() {
  if (state.panelTab === 'traffic') renderTrafficTab();
  else if (state.panelTab === 'changes') renderChangesTab();
  else renderQualityTab();
  document.getElementById('panel').insertAdjacentHTML('afterbegin', `
    <div class="tabs">${PANEL_TABS.map(([id, label]) => `<button type="button"
      class="tab${state.panelTab === id ? ' active' : ''}" data-tab="${id}">${label}${id === 'changes' && state.changes?.size
  ? ` (${state.changes.size})` : ''}</button>`).join('')}</div>`);
}

/**
 * With nothing selected the panel is more useful as a worst-first list of
 * links than as an empty placeholder — that is where a mesh problem lives.
 */
function renderQualityTab() {
  const links = state.graph.links
    .filter((l) => l.kind === 'route' && l.grade !== 'unknown')
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 12);

  const rows = links.map((l) => {
    const child = state.byAddr.get(l.target.addr ?? l.target);
    const parent = state.byAddr.get(l.source.addr ?? l.source);
    return `<li data-addr="${child.addr}">
      <span class="q-dot q-${l.grade}"></span>
      <span class="wl-name">${escapeHtml(shortName(child.name))}
        <span class="wl-via">via ${escapeHtml(shortName(parent.name))} · ${(l.sample || 0).toLocaleString()} tx</span></span>
      <span class="wl-rate q-text-${l.grade}">${Math.round(l.rate * 100)}%</span>
    </li>`;
  }).join('');

  const counts = countGrades();
  const summary = GRADE_ORDER.map((g) => (counts[g]
    ? `<span class="badge"><i class="q-dot q-${g}"></i> ${counts[g]} ${GRADE_LABEL[g].toLowerCase()}</span>`
    : '')).join('');

  document.getElementById('panel').innerHTML = `
    <div class="p-head">
      <h2>Link quality</h2>
      <div class="sub">Every hop, ranked worst first. Click one to trace it.</div>
    </div>
    <div class="badges">${summary}</div>
    ${section('Weakest links', `<ul class="weaklinks">${rows}</ul>`)}
    ${section('How this is measured', `<p class="note">The dump carries no LQI or signal
      strength. Each device does report how many of its transmissions succeeded, and because
      every device has exactly one parent relay, that success rate describes its link to that
      parent. A router's counters also include traffic it forwards to its own children, so
      read a router's grade as "this branch is struggling" rather than one exact hop.</p>`)}`;

  document.getElementById('panel').querySelectorAll('[data-addr]').forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.addr)));
  });
}

/**
 * The twelve busiest devices by messages sent. All bars share one scale — the
 * highest TX or RX in the list, whichever state.trafficScale picks — so they
 * compare across rows; a bar past that scale stops at the edge.
 */
function renderTrafficTab() {
  const top = state.graph.nodes
    .filter((n) => !n.isCoordinator && n.stats?.tx > 0)
    .sort((a, b) => b.stats.tx - a.stats.tx)
    .slice(0, 12);
  const max = Math.max(1, ...top.map((n) => n.stats[state.trafficScale]));
  const width = (v) => Math.min(100, (v / max) * 100);

  const rows = top.map((n) => {
    const s = n.stats;
    const pct = s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`;
    const errPct = Math.min(100, (s.txError / s.tx) * 100);
    return `<li data-addr="${n.addr}">
      <span class="tr-name">${escapeHtml(shortName(n.name))}</span>
      <span class="tr-bar tr-tx"><span style="width:${width(s.tx)}%"><span class="tr-err" style="width:${errPct}%"></span></span>
        <span class="tr-val">${s.tx.toLocaleString()} / ${s.txError.toLocaleString()}</span></span>
      <span class="tr-pct">(${pct})</span>
      <span class="tr-bar tr-rx"><span style="width:${width(s.rx)}%"></span>
        <span class="tr-val">${s.rx.toLocaleString()}</span></span>
    </li>`;
  }).join('');

  const scaleBtn = (id) => `<button type="button" data-scale="${id}"
    class="${state.trafficScale === id ? 'active' : ''}">${id.toUpperCase()}</button>`;

  document.getElementById('panel').innerHTML = `
    <div class="p-head">
      <h2>Traffic</h2>
      <div class="sub">The twelve busiest devices by messages sent. Click one to trace it.</div>
    </div>
    <div class="tr-scale">Scale to highest ${scaleBtn('tx')} / ${scaleBtn('rx')}</div>
    ${section('Top 12 by TX', `<ul class="traffic">${rows}</ul>`)}
    ${section('How to read this', `<p class="note">Green is TX with its errors in red,
      blue is RX. All bars share the scale of the highest TX or RX in the list, as picked
      above; a bar past that scale stops at the edge.</p>`)}`;

  document.getElementById('panel').querySelectorAll('[data-addr]').forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.addr)));
  });
}

function countGrades() {
  const counts = {};
  for (const l of state.graph.links) {
    if (l.kind !== 'route') continue;
    counts[l.grade] = (counts[l.grade] || 0) + 1;
  }
  return counts;
}

function renderPanel(n) {
  if (!n) return;
  const panel = document.getElementById('panel');
  const sections = [];

  // --- header
  let typeLabel = n.type;
  if (n.isCoordinator) typeLabel = 'coordinator';
  else if (n.isGhost) typeLabel = 'unknown device';
  const badges = [`<span class="badge type">${typeLabel}</span>`];
  if (n.hops != null) badges.push(`<span class="badge">${n.hops} hop${n.hops === 1 ? '' : 's'}</span>`);
  if (n.receiveWhenIdle === false) badges.push('<span class="badge">sleepy</span>');
  if (n.descendantCount) badges.push(`<span class="badge">relays ${n.descendantCount}</span>`);
  if (n.isGhost) badges.push('<span class="badge warn">stale route entry</span>');
  if (!n.hasRoute && !n.isCoordinator && !n.isGhost) badges.push('<span class="badge danger">no route</span>');
  if (n.sharedWith) badges.push(`<span class="badge warn">address shared with ${escapeHtml(n.sharedWith.join(', '))}</span>`);

  sections.push(`
    <div class="p-head">
      <h2>${escapeHtml(n.name)}</h2>
      <div class="sub">${escapeHtml([n.manufacturerName, n.modelId].filter(Boolean).join(' · ') || 'Unknown device')}</div>
    </div>
    <div class="badges">${badges.join('')}</div>`);

  // --- a stale entry and the device it most likely belongs to
  const notice = staleNotice(n);
  if (notice) sections.push(notice);

  // --- route back to the controller
  sections.push(routeSection(n));

  // --- link quality
  sections.push(uplinkSection(n));
  const downlinks = downlinkSection(n);
  if (downlinks) sections.push(downlinks);

  // --- route history, filled in once /api/routes answers
  sections.push('<div id="routeHistory"></div>');

  // --- identity
  const rows = [
    ['Network addr', `<span class="mono">0x${n.nwkAddr.toString(16).padStart(4, '0')} (${n.nwkAddr})</span>`],
    ['IEEE addr', n.ieeeAddr ? `<span class="mono">${n.ieeeAddr}</span>` : '—'],
    ['Device type', n.isCoordinator ? 'coordinator' : n.type],
    ['Firmware', n.swBuildId || '—'],
    ['Homey app', n.ownerUri ? `<span class="mono">${escapeHtml(n.ownerUri.replace('homey:app:', ''))}</span>` : '—'],
    ['Last seen', n.lastSeen ? `${new Date(n.lastSeen).toLocaleString()}<br><span class="mono">${ago(n.lastSeen)}</span>` : '—'],
  ];
  sections.push(section('Device', `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`));

  // --- radio stats
  if (n.stats && (n.stats.tx || n.stats.rx)) {
    const s = n.stats;
    const pct = s.successRate == null ? null : Math.round(s.successRate * 100);
    let cls = '';
    if (pct != null && pct < 70) cls = 'danger';
    else if (pct != null && pct < 90) cls = 'warn';
    sections.push(section('Radio statistics', `
      <dl class="kv">
        <dt>TX success</dt><dd>${pct == null ? '—' : `${pct}%`}
          <div class="bar ${cls}"><span style="width:${pct ?? 0}%"></span></div></dd>
        <dt>TX total</dt><dd>${s.tx.toLocaleString()}</dd>
        <dt>TX errors</dt><dd>${s.txError.toLocaleString()}</dd>
        <dt>RX total</dt><dd>${s.rx.toLocaleString()}</dd>
      </dl>`));
  }

  // --- capabilities
  if (n.capabilities) {
    const caps = Object.entries(n.capabilities).filter(([, v]) => v).map(([k]) => `<span class="chip">${k}</span>`);
    sections.push(section('Capabilities', `<div class="chips">${caps.join('') || '<span class="chip">none</span>'}</div>`));
  }

  // --- endpoints
  if (n.endpoints?.length) {
    sections.push(section('Endpoints', n.endpoints.map((ep) => `
      <div class="ep">
        <h4>Endpoint ${ep.endpointId} · profile ${ep.profileId} · device ${ep.deviceId}</h4>
        <div class="ep-label">Input clusters</div>
        <div class="chips">${clusterChips(ep.inputClusters)}</div>
        <div class="ep-label">Output clusters</div>
        <div class="chips">${clusterChips(ep.outputClusters)}</div>
      </div>`).join('')));
  }

  // --- bindings
  if (n.bindings && Object.keys(n.bindings).length) {
    const items = Object.entries(n.bindings).map(([ieee, list]) => {
      const target = state.graph.nodes.find((x) => x.ieeeAddr === ieee);
      const clusters = list.map((entry) => {
        const [ep, cid] = String(entry).split(':');
        return `<span class="chip">ep${ep} · ${CLUSTERS[Number(cid)] || `cluster ${cid}`}</span>`;
      }).join('');
      return `<div class="ep"><h4>→ ${escapeHtml(target ? target.name : ieee)}</h4><div class="chips">${clusters}</div></div>`;
    });
    sections.push(section('Bindings', items.join('')));
  }

  panel.innerHTML = sections.join('');
  panel.scrollTop = 0;
  panel.querySelectorAll('[data-addr]').forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.addr)));
  });
  loadRouteHistory(n);
}

/** How well this device reaches its parent relay. */
function uplinkSection(n) {
  if (n.isCoordinator || n.parent === undefined) return '';
  const link = state.graph.links.find((l) => l.kind === 'route'
    && (l.target.addr ?? l.target) === n.addr);
  if (!link) return '';
  const parent = state.byAddr.get(n.parent);
  const pct = link.rate == null ? null : Math.round(link.rate * 100);

  return section('Link to parent', `
    <div class="qhead">
      <span class="q-dot q-${link.grade}"></span>
      <span class="q-text-${link.grade}">${GRADE_LABEL[link.grade]}</span>
      ${pct == null ? '' : `<span class="qpct">${pct}%</span>`}
    </div>
    <div class="bar q-bar-${link.grade}"><span style="width:${pct ?? 0}%"></span></div>
    <dl class="kv">
      <dt>Parent</dt><dd class="linkish" data-addr="${parent.addr}">${escapeHtml(parent.name)}</dd>
      <dt>Transmissions</dt><dd>${(link.sample || 0).toLocaleString()}</dd>
      <dt>Failed</dt><dd>${(link.txError || 0).toLocaleString()}</dd>
    </dl>
    ${link.grade === 'unknown'
    ? '<p class="note">Too few transmissions to judge this link yet.</p>'
    : ''}`);
}

/** How well the devices hanging off this one are doing. */
function downlinkSection(n) {
  const links = state.graph.links
    .filter((l) => l.kind === 'route' && (l.source.addr ?? l.source) === n.addr)
    .sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2));
  if (!links.length) return '';

  const rows = links.map((l) => {
    const child = state.byAddr.get(l.target.addr ?? l.target);
    return `<li data-addr="${child.addr}">
      <span class="q-dot q-${l.grade}"></span>
      <span class="wl-name">${escapeHtml(shortName(child.name))}</span>
      <span class="wl-rate q-text-${l.grade}">${l.rate == null ? '—' : `${Math.round(l.rate * 100)}%`}</span>
    </li>`;
  }).join('');
  return section(`Links to children (${links.length})`, `<ul class="weaklinks">${rows}</ul>`);
}

/**
 * Points out the link between a stale entry and the device that most likely left
 * it behind: harmless when that device has a route at its new address, a sign of
 * an out-of-date record in Homey when it has none.
 */
function staleNotice(n) {
  const hex = (a) => `0x${a.toString(16).padStart(4, '0')}`;
  const link = (d, text) => `<span class="linkish" data-addr="${d.addr}">${escapeHtml(text)}</span>`;
  if (n.isGhost && n.probablyWas) {
    const owners = n.probablyWas.map((a) => state.byAddr.get(a)).filter(Boolean);
    const names = owners.map((d) => link(d, d.name)).join(' / ');
    if (owners.every((d) => d.hasRoute)) {
      return `<p class="notice info">This was the address of ${names} when Homey paired it. It has a route at
        its new address too, so this is a leftover from before it rejoined: harmless.</p>`;
    }
    const listed = owners.map((d) => `${escapeHtml(d.name)} is listed at ${hex(d.nwkAddr)}`
      + `${d.sharedWith ? `, shared with ${escapeHtml(d.sharedWith.join(', '))}` : ''}`).join('; ');
    return `<p class="notice">This was the address of ${names} when Homey paired it, and the controller still has a
      route to it: the device is probably still here. ${listed}, so Homey's record of it is probably out of date.</p>`;
  }
  if (n.staleAddr != null) {
    const ghost = state.byAddr.get(n.staleAddr);
    const old = ghost ? link(ghost, hex(n.staleAddr)) : hex(n.staleAddr);
    if (n.hasRoute) {
      return `<p class="notice info">Its pairing address ${old} is still in the routing table: a leftover from
        before it rejoined at ${hex(n.nwkAddr)}. Harmless.</p>`;
    }
    return `<p class="notice">Its pairing address ${old} still has a route in the controller's table, while Homey
      lists this device at ${hex(n.nwkAddr)} without one: Homey's record of it is probably out of date.</p>`;
  }
  return '';
}

function routeSection(n) {
  if (n.isCoordinator) {
    const c = state.graph.controller;
    return section('Controller', `
      <dl class="kv">
        <dt>Channel</dt><dd>${c.channel}</dd>
        <dt>PAN ID</dt><dd class="mono">${c.panId}</dd>
        <dt>Ext. PAN ID</dt><dd class="mono">${c.extendedPanId || '—'}</dd>
        <dt>Firmware</dt><dd>${c.softwareVersion || '—'}</dd>
        <dt>State</dt><dd>${c.currentCommand || '—'}</dd>
      </dl>`);
  }
  if (!n.path) {
    return section('Path to controller', `<p style="font-size:12px;color:var(--text-dim);margin:0">
      No route in the controller's routing table — the device is unreachable or has not been contacted since the last restart.</p>`);
  }
  const items = n.path.map((addr, i) => {
    const hop = state.byAddr.get(addr);
    const color = hop ? hopColor(hop) : GHOST_COLOR;
    const label = i === 0 ? 'C' : i;
    const grade = i === 0 ? null : hop?.uplinkGrade || 'unknown';
    const rate = i === 0 || hop?.uplinkRate == null ? '' : `${Math.round(hop.uplinkRate * 100)}%`;
    return `<li>
      <span class="step" style="background:${color}">${label}</span>
      <span class="rname" data-addr="${addr}">${escapeHtml(hop ? shortName(hop.name) : `0x${addr.toString(16)}`)}</span>
      ${grade ? `<span class="wl-rate q-text-${grade}" title="quality of the hop into this device">${rate}</span>` : ''}
      <span class="raddr">0x${addr.toString(16)}</span>
    </li>`;
  });
  return section(`Path to controller (${n.hops} hop${n.hops === 1 ? '' : 's'})`, `<ul class="route">${items.join('')}</ul>`);
}

function section(title, body) {
  return `<div class="section"><h3>${title}</h3>${body}</div>`;
}

function clusterChips(ids) {
  if (!ids.length) return '<span class="chip">none</span>';
  return ids.map((id) => `<span class="chip">${CLUSTERS[id] || id}</span>`).join('');
}

function ago(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------------------------------------------------------------ interaction --

svg.on('click', () => {
  clearSelection();
  clearConflictSearch();
});

document.getElementById('panel').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  const scale = e.target.closest('[data-scale]');
  if (tab && tab.dataset.tab !== state.panelTab) {
    state.panelTab = tab.dataset.tab;
    renderOverview();
  } else if (scale && scale.dataset.scale !== state.trafficScale) {
    state.trafficScale = scale.dataset.scale;
    renderOverview();
  }
});

document.getElementById('search').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  applyHighlight();
});

/** The network addresses more than one device reports, in the graph on screen. */
function sharedAddresses() {
  return [...new Set(state.graph.nodes.filter((n) => n.sharedWith).map((n) => n.nwkAddr))];
}

// Clicking the Conflicts counter searches for the next shared address, so the
// devices that report it light up together.
let conflictIndex = 0;
let conflictQuery = null; // what the counter put in the search box, until it is cleared
document.getElementById('netstats').addEventListener('click', (e) => {
  if (!e.target.closest('#conflictsStat')) return;
  const shared = sharedAddresses();
  if (!shared.length) return;
  if (state.selected != null) clearSelection();
  const search = document.getElementById('search');
  search.value = String(shared[conflictIndex % shared.length]);
  conflictQuery = search.value;
  conflictIndex += 1;
  search.dispatchEvent(new Event('input'));
});

/** Empties the search again, but only while it still holds what the Conflicts counter put there. */
function clearConflictSearch() {
  const search = document.getElementById('search');
  if (conflictQuery === null || search.value !== conflictQuery) return;
  conflictQuery = null;
  search.value = '';
  search.dispatchEvent(new Event('input'));
}

document.getElementById('showBindings').addEventListener('change', (e) => {
  state.showBindings = e.target.checked; render();
});
document.getElementById('showGhosts').addEventListener('change', (e) => {
  state.showGhosts = e.target.checked; render();
});
document.getElementById('showLabels').addEventListener('change', (e) => {
  state.showLabels = e.target.checked; applyHighlight();
});
document.getElementById('layout').addEventListener('change', (e) => {
  state.layout = e.target.value;
  state.graph.nodes.forEach((n) => {
    n.x = undefined; n.y = undefined; n.fx = null; n.fy = null;
  });
  render();
});
document.getElementById('fit').addEventListener('click', fitToView);
document.getElementById('open').addEventListener('click', () => openLoader(true));

// Panes marked .collapsible fold down to their .collapse-keep part (e.g. the
// title). data-collapse says which way they fold; the state is remembered per id.
const COLLAPSE_KEY = 'zigbee-visualizer.collapsed';
const COLLAPSE_ICONS = {
  up: ['▲', '▼'], down: ['▼', '▲'], left: ['<<', '>>'], right: ['>>', '<<'],
};

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {};
  } catch {
    return {};
  }
}

function setCollapsed(pane, collapsed) {
  // A direction without arrows (e.g. "icon") keeps the toggle's own content.
  const icons = COLLAPSE_ICONS[pane.dataset.collapse];
  const toggle = pane.querySelector('.collapse-toggle');
  pane.classList.toggle('collapsed', collapsed);
  if (icons) toggle.textContent = collapsed ? icons[1] : icons[0];
  toggle.title = collapsed ? 'Show' : 'Hide';
  toggle.setAttribute('aria-expanded', String(!collapsed));
}

document.querySelectorAll('.collapsible').forEach((pane) => {
  setCollapsed(pane, !!readCollapsed()[pane.id]);
  pane.querySelector('.collapse-toggle').addEventListener('click', () => {
    const collapsed = !pane.classList.contains('collapsed');
    setCollapsed(pane, collapsed);
    if (state.graph && ['left', 'right'].includes(pane.dataset.collapse)) render();
    const saved = readCollapsed();
    saved[pane.id] = collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(saved));
    } catch { /* ignore */ }
  });
});

window.addEventListener('resize', () => {
  if (state.graph) render();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!loader.hidden) closeLoader();
  else {
    clearSelection();
    clearConflictSearch();
  }
});

// ------------------------------------------------------- loading the dump --

document.getElementById('loaderClose').addEventListener('click', closeLoader);
loader.addEventListener('click', (e) => {
  if (e.target === loader) closeLoader();
});

const fileInput = document.getElementById('fileInput');
document.getElementById('pickFile').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  readFile(fileInput.files[0]);
  fileInput.value = ''; // so picking the same file twice still fires
});

document.getElementById('usePaste').addEventListener('click', () => submit(pasteBox.value, 'pasted JSON'));
pasteBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(pasteBox.value, 'pasted JSON');
});
pasteBox.addEventListener('input', () => note(''));

rememberBox.addEventListener('change', () => {
  try {
    localStorage.setItem(REMEMBER_KEY, rememberBox.checked ? 'yes' : 'no');
  } catch { /* ignore */ }
});

document.getElementById('imports').addEventListener('click', (e) => {
  const open = e.target.closest('[data-import]');
  const del = e.target.closest('[data-delete]');
  if (open) {
    openImport({ id: open.dataset.import, takenAt: open.dataset.taken }).then((shown) => {
      if (shown) closeLoader();
      else note('Could not read that import.', 'bad');
    });
  } else if (del) {
    fetch(`api/imports/${encodeURIComponent(del.dataset.delete)}`, { method: 'DELETE' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        note('Deleted from the Homey.', 'ok');
      })
      .catch((err) => note(`Could not delete it: ${err.message}`, 'bad'))
      .finally(renderImports);
  }
});

// Dragging a file anywhere over the window opens the drop zone; letting go
// outside of a drop closes it again, unless it was opened on purpose.
const dragHasFile = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  dragDepth++;
  openLoader();
  dropzone.classList.add('over');
});
window.addEventListener('dragover', (e) => {
  if (dragHasFile(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!dragHasFile(e) || --dragDepth > 0) return;
  dragDepth = 0;
  dropzone.classList.remove('over');
  if (!state.loaderPinned) closeLoader();
});
window.addEventListener('drop', (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault(); // otherwise the browser navigates away to the file
  dragDepth = 0;
  dropzone.classList.remove('over');
  openLoader(true);
  readFile(e.dataTransfer.files[0]);
});

// ----------------------------------------------------------------- boot ----

try {
  rememberBox.checked = localStorage.getItem(REMEMBER_KEY) !== 'no';
} catch { /* ignore */ }
// Served by the Homey app: load the live network straight away. The newest kept
// import and the loader are the fallback for when the Zigbee state can't be read.
getJson('api/graph')
  .then((graph) => {
    graph.meta.source = 'Homey (live)';
    show(graph);
    compareShown();
  })
  .catch(() => restore().then((shown) => {
    if (!shown) openLoader(true);
  }));

// ----------------------------------------------------------- history ----

// The history pane: ● is the live state, then every snapshot, newest first,
// labelled by how many hours back it is, in steps of the snapshot interval.
const historyList = document.getElementById('historyList');
let historyActive = ''; // '' is live, otherwise the id of the snapshot on screen

let historySnapshots = null; // every snapshot, oldest first, as last reported by the app

let historySettings = null; // the snapshot settings, as last reported by the app

/** Draws an imported dump. It is not part of the history, so there is nothing to compare it with. */
function showImport(graph, id) {
  historyActive = id || 'import';
  show(graph);
  compareShown();
  loadHistory();
}

function renderHistory({
  enabled, intervalHours, keep, hourMs, snapshots,
}, routes) {
  historySettings = { enabled, intervalHours, keep };
  const first = historySnapshots === null;
  historySnapshots = snapshots;
  if (first) compareShown();
  const step = intervalHours * hourMs;
  const moved = routeChanges(routes);
  const items = [{ id: '', label: '●', when: 'Live' }].concat(snapshots.slice().reverse().map((s) => {
    const back = Math.max(1, Math.ceil((Date.now() - Date.parse(s.takenAt)) / step)) * intervalHours;
    return {
      id: s.id, label: `-${back}`, when: new Date(s.takenAt).toLocaleString(), moved: moved.get(s.id),
    };
  }));
  historyList.innerHTML = items.map((it) => {
    const title = it.moved ? `${it.when} · ${it.moved} route change${it.moved === 1 ? '' : 's'}` : it.when;
    return `<button type="button" data-snap="${it.id}" data-when="${escapeHtml(it.when)}"
      class="history-item${it.id === historyActive ? ' active' : ''}${it.moved ? ' moved' : ''}"
      title="${escapeHtml(title)}">${it.label}</button>`;
  }).join('');
}

/** How many devices changed parent, joined or left in each snapshot, against the one before it. */
function routeChanges(routes) {
  const counts = new Map();
  routes.forEach((r, i) => {
    if (i === 0) return;
    const before = routes[i - 1].parents;
    const devices = new Set([...Object.keys(before), ...Object.keys(r.parents)]);
    const n = [...devices].filter((d) => before[d] !== r.parents[d]).length;
    if (n) counts.set(r.id, n);
  });
  return counts;
}

function loadHistory() {
  const json = (res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)));
  Promise.all([
    fetch('api/snapshots').then(json),
    // Without the routes the pane still works, just without the change markers.
    fetch('api/routes').then(json).catch(() => []),
  ])
    .then(([overview, routes]) => renderHistory(overview, routes))
    .catch(() => { /* no history to show; the live view works without it */ });
}

historyList.addEventListener('click', (e) => {
  const item = e.target.closest('[data-snap]');
  if (!item) return;
  const id = item.dataset.snap;
  getJson(id ? `api/snapshots/${id}` : 'api/graph')
    .then((graph) => {
      historyActive = id;
      graph.meta.source = id ? `Snapshot ${item.dataset.when} (${item.textContent} h)` : 'Homey (live)';
      // Only while this one snapshot is drawn, so Fit, resizing and the rest still refit.
      state.keepView = true;
      show(graph);
      state.keepView = false;
      compareShown();
      loadHistory();
    })
    .catch((err) => toast(`Could not load that snapshot: ${err.message}`, 'warn'));
});

// New snapshots arrive on the interval, and the labels age with the clock.
loadHistory();
setInterval(loadHistory, 60 * 1000);

// ------------------------------------------------------ history settings ----

const hsPanel = document.getElementById('historySettingsPanel');
const hsEnabled = document.getElementById('hsEnabled');
const hsInterval = document.getElementById('hsInterval');
const hsKeep = document.getElementById('hsKeep');
const hsWarn = document.getElementById('hsWarn');

// The gear opens the panel with the settings as they are now, and closes it again.
document.getElementById('historySettings').addEventListener('click', () => {
  if (!hsPanel.hidden || !historySettings) {
    hsPanel.hidden = true;
    return;
  }
  hsEnabled.checked = historySettings.enabled;
  hsInterval.value = String(historySettings.intervalHours);
  hsKeep.value = String(historySettings.keep);
  hsWarn.hidden = true;
  hsPanel.hidden = false;
});

hsInterval.addEventListener('change', () => {
  hsWarn.hidden = Number(hsInterval.value) === historySettings.intervalHours;
});

document.getElementById('hsCancel').addEventListener('click', () => {
  hsPanel.hidden = true;
});

// The server answers /api/export as a file to save, so the page itself stays where it is.
document.getElementById('historyDownload').addEventListener('click', () => {
  window.location.assign('api/export');
});

document.getElementById('hsSave').addEventListener('click', () => {
  fetch('api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: hsEnabled.checked, intervalHours: Number(hsInterval.value), keep: Number(hsKeep.value),
    }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(res.status === 400 ? 'keep must be a whole number from 2 to 24' : `HTTP ${res.status}`);
      hsPanel.hidden = true;
      toast('Snapshot settings saved', 'ok');
      loadHistory();
    })
    .catch((err) => toast(`Could not save the settings: ${err.message}`, 'warn'));
});

// ------------------------------------------------------------- changes ----

/** Devices are matched on IEEE address: a network address can change on rejoin. */
function nodeKey(n) {
  return n.ieeeAddr || `nwk:${n.addr}`;
}

/** Every device that moved to another parent, joined or left between two graphs. */
function diffGraphs(before, now) {
  const index = (graph) => ({
    byAddr: new Map(graph.nodes.map((n) => [n.addr, n])),
    byKey: new Map(graph.nodes.filter((n) => !n.isGhost && !n.isCoordinator).map((n) => [nodeKey(n), n])),
  });
  const a = index(before);
  const b = index(now);
  const parentOf = (ix, n) => ix.byAddr.get(n.parent);
  const parentName = (ix, n) => parentOf(ix, n)?.name ?? 'no route';

  const changes = new Map();
  for (const [key, n] of b.byKey) {
    const old = a.byKey.get(key);
    if (!old) {
      changes.set(key, { kind: 'joined', node: n });
    } else {
      const was = parentOf(a, old);
      const is = parentOf(b, n);
      if ((was && nodeKey(was)) !== (is && nodeKey(is))) {
        changes.set(key, {
          kind: 'moved', node: n, from: parentName(a, old), to: parentName(b, n),
        });
      }
    }
  }
  for (const [key, old] of a.byKey) {
    if (!b.byKey.has(key)) changes.set(key, { kind: 'left', node: old });
  }
  return changes;
}

/** The snapshot one step older than what is on screen: for live, the newest one. */
function olderThan(id) {
  if (!historySnapshots?.length) return null;
  if (!id) return historySnapshots[historySnapshots.length - 1].id;
  const i = historySnapshots.findIndex((s) => s.id === id);
  return i > 0 ? historySnapshots[i - 1].id : null;
}

/** Compares the graph on screen with the snapshot before it, and marks what changed. */
function compareShown() {
  // At startup the snapshot list can arrive before the graph; the boot code calls this again then.
  const shown = state.graph;
  if (!shown) return;
  state.changes = null;
  applyHighlight();
  if (!state.selected) renderOverview();
  const olderId = olderThan(historyActive);
  if (!olderId) return;

  getJson(`api/snapshots/${olderId}`)
    .then((older) => {
      if (state.graph !== shown) return; // another snapshot was picked meanwhile
      state.changes = diffGraphs(older, shown);
      applyHighlight();
      if (!state.selected) renderOverview();
    })
    .catch(() => { /* nothing to compare with; the graph itself is fine */ });
}

function renderChangesTab() {
  const order = { moved: 0, joined: 1, left: 2 };
  const list = [...(state.changes?.values() ?? [])]
    .sort((a, b) => order[a.kind] - order[b.kind] || a.node.name.localeCompare(b.node.name));

  const rows = list.map((c) => {
    let detail = 'no longer in the network';
    if (c.kind === 'moved') detail = `${escapeHtml(shortName(c.from))} → ${escapeHtml(shortName(c.to))}`;
    else if (c.kind === 'joined') detail = 'joined the network';
    const addr = c.kind === 'left' ? '' : ` data-addr="${c.node.addr}"`;
    return `<li${addr}><span class="change-dot ${c.kind}"></span>
      <span class="wl-name">${escapeHtml(shortName(c.node.name))}
        <span class="wl-via">${detail}</span></span></li>`;
  }).join('');

  const empty = olderThan(historyActive) ? 'No routes changed.' : 'There is no older snapshot to compare with.';
  document.getElementById('panel').innerHTML = `
    <div class="p-head">
      <h2>Changes</h2>
      <div class="sub">What differs from the snapshot before this one. Click a device to trace it.</div>
    </div>
    <div class="changes-body">
      ${section('Since the snapshot before', list.length ? `<ul class="weaklinks">${rows}</ul>` : `<p class="note">${empty}</p>`)}
    </div>`;

  document.getElementById('panel').querySelectorAll('[data-addr]').forEach((el) => {
    el.addEventListener('click', () => select(Number(el.dataset.addr)));
  });
}

// ------------------------------------------------------- route history ----

// One colour per parent in a device's history, handed out in order of appearance.
const ROUTE_COLORS = ['#4dd4ac', '#58a6ff', '#bc8cff', '#e3b341', '#ff8fab', '#39c5cf', '#e8883a'];
// From this many parent changes on, a device is flagged: once is normal, repeatedly is not.
const FLAP_THRESHOLD = 3;

/** Fills the Route history section of a device's panel, once /api/routes answers. */
function loadRouteHistory(n) {
  const box = document.getElementById('routeHistory');
  if (!box) return;
  if (!n.ieeeAddr || n.isCoordinator || n.isGhost) {
    box.remove();
    return;
  }
  fetch('api/routes')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((snapshots) => {
      if (state.selected !== n.addr || !box.isConnected) return; // another device was picked meanwhile
      box.innerHTML = routeHistoryHtml(n, snapshots);
    })
    .catch(() => box.remove());
}

function routeHistoryHtml(n, snapshots) {
  const names = {};
  snapshots.forEach((s) => Object.assign(names, s.names));

  // A parent is an IEEE address, null for "no route", or undefined for "not in the network".
  const points = snapshots.map((s) => ({
    id: s.id, takenAt: s.takenAt, parent: n.ieeeAddr in s.parents ? s.parents[n.ieeeAddr] : undefined,
  }));
  if (historyActive === '') {
    // On the live view, what is on screen now counts as the newest point.
    const p = state.byAddr.get(n.parent);
    points.push({ id: '', takenAt: new Date().toISOString(), parent: p ? p.ieeeAddr : null });
    if (p) names[p.ieeeAddr] = p.name;
  }
  if (points.length < 2) return section('Route history', '<p class="note">Not enough snapshots yet to show a history.</p>');

  const keyOf = (parent) => (parent === undefined ? '~gone' : parent ?? '~none');
  const FIXED_LABELS = { '~gone': 'Not in the network', '~none': 'No route' };
  const label = (k) => FIXED_LABELS[k] ?? names[k] ?? k;
  const counts = new Map();
  points.forEach((p) => counts.set(keyOf(p.parent), (counts.get(keyOf(p.parent)) ?? 0) + 1));
  const colors = new Map();
  const FIXED_COLORS = { '~gone': 'var(--q-unknown)', '~none': 'var(--q-bad)' };
  [...counts.keys()].forEach((k, i) => colors.set(k, FIXED_COLORS[k] ?? ROUTE_COLORS[i % ROUTE_COLORS.length]));

  const timeline = points.map((p) => {
    const when = p.id ? new Date(p.takenAt).toLocaleString() : 'Live';
    return `<span class="rh-block${p.id === historyActive ? ' current' : ''}" style="background:${colors.get(keyOf(p.parent))}"
      title="${escapeHtml(`${when}: ${label(keyOf(p.parent))}`)}"></span>`;
  }).join('');

  const rows = [...counts].map(([k, count]) => `<li>
      <span class="rh-name">${escapeHtml(shortName(label(k)))}</span>
      <span class="rh-bar"><span style="width:${(count / points.length) * 100}%;background:${colors.get(k)}"></span></span>
      <span class="rh-count">${count}×</span>
    </li>`).join('');

  const changes = points.filter((p, i) => i > 0 && keyOf(p.parent) !== keyOf(points[i - 1].parent)).length;
  const verdict = changes >= FLAP_THRESHOLD
    ? `<p class="rh-warn">⚠ Changed parent ${changes} times over ${points.length} snapshots: a sign of a weak link.</p>`
    : `<p class="note">${changes ? `Changed parent ${changes} time${changes === 1 ? '' : 's'}.` : 'Always the same parent.'}</p>`;

  return section(`Route history (${points.length} snapshots)`,
    `<div class="rh-timeline">${timeline}</div><ul class="rh-rows">${rows}</ul>${verdict}`);
}
