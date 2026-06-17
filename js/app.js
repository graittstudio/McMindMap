"use strict";

const PALETTE = [
  "#d83b32", "#e08a16", "#2f9e44", "#1c7ed6",
  "#7048e8", "#c2255c", "#0c8599", "#e8590c",
];
const STORAGE_KEY = "mcmindmap.doc.v1";

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const svg = $("canvas");
const gViewport = $("viewport");
const gBranches = $("branches");
const gNodes = $("nodes");
const editor = $("editor");

// ---- State ----------------------------------------------------------------

let state = null;          // { nodes: {id:node}, rootId }
let selectedId = null;
let readOnly = false;       // shared-with-me view: block all edit operations
let cam = { x: 0, y: 0, scale: 1 };
let nextId = 1;

let rootSize = { rx: 70, ry: 48 };     // bounds (ellipse / image + title) for fit
let rootAttach = { rx: 70, ry: 48 };   // where branches attach (just inside a central image)
const labelWorld = {};     // id -> {x,y} anchor used by the inline editor

function newNode(text, parentId, x, y, color) {
  return { id: "n" + nextId++, text, parentId, x, y, color: color || null, image: null };
}

function freshDoc() {
  nextId = 1;
  const root = newNode("Central topic", null, 0, 0, null);
  state = { nodes: { [root.id]: root }, rootId: root.id };
  selectedId = root.id;
}

function children(id) {
  return Object.values(state.nodes).filter((n) => n.parentId === id);
}

function depthOf(node) {
  let d = 0, n = node;
  while (n.parentId) { d++; n = state.nodes[n.parentId]; }
  return d;
}

// Top-level branch colour, inherited by the whole sub-tree.
function resolvedColor(node) {
  let n = node;
  while (n.parentId && state.nodes[n.parentId].parentId) {
    n = state.nodes[n.parentId];
  }
  if (!n.parentId) return "#666";          // root itself
  if (!n.color) {
    const idx = children(state.rootId).indexOf(n);
    n.color = PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
  }
  return n.color;
}

// ---- Persistence ----------------------------------------------------------

const changeListeners = [];
function notifyChange() { changeListeners.forEach((cb) => { try { cb(); } catch (e) {} }); }

// Drop any node not reachable from the root through valid parent links
// (orphans left behind by older bugs, cycles, dangling parentIds). Without
// this a single orphan makes render() throw and the whole UI never finishes.
function sanitizeState() {
  if (!state || !state.nodes || !state.rootId || !state.nodes[state.rootId]) return;
  const keep = new Set([state.rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of Object.values(state.nodes)) {
      if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) { keep.add(n.id); grew = true; }
    }
  }
  for (const id of Object.keys(state.nodes)) if (!keep.has(id)) delete state.nodes[id];
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      nodes: state.nodes, rootId: state.rootId, nextId, cam,
    }));
  } catch (e) { /* storage may be unavailable */ }
  pushHistory();
  notifyChange();
}

// ---- Undo history ---------------------------------------------------------

let undoStack = [];
function snapshotDoc() { return JSON.stringify({ nodes: state.nodes, rootId: state.rootId, nextId }); }
function resetHistory() { undoStack = [snapshotDoc()]; }
function pushHistory() {
  const s = snapshotDoc();
  if (undoStack.length && undoStack[undoStack.length - 1] === s) return;  // skip no-ops (pan/zoom)
  undoStack.push(s);
  if (undoStack.length > 120) undoStack.shift();
}
function undo() {
  if (readOnly) return;
  if (undoStack.length < 2) return;
  undoStack.pop();                                   // drop current state
  const prev = JSON.parse(undoStack[undoStack.length - 1]);
  state = { nodes: prev.nodes, rootId: prev.rootId };
  nextId = prev.nextId;
  if (!state.nodes[selectedId]) selectedId = state.rootId;
  render();
  notifyChange();                                    // persist the undone state
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (!raw) return false;
  try {
    const doc = JSON.parse(raw);
    if (!doc.nodes || !doc.rootId) return false;
    state = { nodes: doc.nodes, rootId: doc.rootId };
    nextId = doc.nextId || (Object.keys(doc.nodes).length + 1);
    if (doc.cam) cam = doc.cam;
    selectedId = state.rootId;
    sanitizeState();
    return true;
  } catch (e) { return false; }
}

// ---- Colour helpers -------------------------------------------------------

function parseHex(hex) {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}
function darken(hex, f) {
  const [r, g, b] = parseHex(hex);
  return `rgb(${Math.round(r * (1 - f))}, ${Math.round(g * (1 - f))}, ${Math.round(b * (1 - f))})`;
}
function tint(hex, f) {
  const [r, g, b] = parseHex(hex);
  const mix = (v) => Math.round(v + (255 - v) * f);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// ---- Geometry: organic tapering branch ------------------------------------

function bezier(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}
function bezierTangent(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return {
    x: a * (c1.x - p0.x) + b * (c2.x - c1.x) + c * (p1.x - c2.x),
    y: a * (c1.y - p0.y) + b * (c2.y - c1.y) + c * (p1.y - c2.y),
  };
}

// Control points give branches a hand-drawn S-curve. Horizontal tangents make
// the curve follow the actual geometry of each branch, so every branch curves
// differently depending on its direction (dynamic, organic).
function controls(p0, p1) {
  const dx = p1.x - p0.x;
  return [
    { x: p0.x + dx * 0.45, y: p0.y },
    { x: p1.x - dx * 0.45, y: p1.y },
  ];
}

function branchPath(p0, p1, w0, w1) {
  const [c1, c2] = controls(p0, p1);
  const N = 28;
  const left = [], right = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const pt = bezier(p0, c1, c2, p1, t);
    const tan = bezierTangent(p0, c1, c2, p1, t);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len, ny = tan.x / len;
    const w = (w0 + (w1 - w0) * Math.pow(t, 1.25)) / 2;
    left.push({ x: pt.x + nx * w, y: pt.y + ny * w });
    right.push({ x: pt.x - nx * w, y: pt.y - ny * w });
  }
  let d = `M ${left[0].x.toFixed(1)} ${left[0].y.toFixed(1)}`;
  for (let i = 1; i <= N; i++) d += ` L ${left[i].x.toFixed(1)} ${left[i].y.toFixed(1)}`;
  for (let i = N; i >= 0; i--) d += ` L ${right[i].x.toFixed(1)} ${right[i].y.toFixed(1)}`;
  return d + " Z";
}

function widthForDepth(d) { return Math.max(4, 20 - d * 5); }
function fontForDepth(d) { return Math.max(12, 18 - (d - 1) * 2); }

// Where a child branch starts on its parent. For the root it starts on the
// `rootAttach` ellipse — for a central image that ellipse sits just inside the
// picture so branches emerge from under it (no gap/frame around the image).
function attachStart(parent, child) {
  if (parent.parentId) return { x: parent.x, y: parent.y };  // chain tip-to-tip
  const ang = Math.atan2(child.y - parent.y, child.x - parent.x);
  return { x: parent.x + Math.cos(ang) * rootAttach.rx, y: parent.y + Math.sin(ang) * rootAttach.ry };
}

// ---- Rendering ------------------------------------------------------------

function applyCamera() {
  gViewport.setAttribute("transform", `translate(${cam.x} ${cam.y}) scale(${cam.scale})`);
}

function render() {
  applyCamera();
  gNodes.textContent = "";
  gBranches.textContent = "";

  drawRoot(state.nodes[state.rootId]);

  for (const node of Object.values(state.nodes)) {
    if (!node.parentId) continue;
    const parent = state.nodes[node.parentId];
    if (!parent) continue;                 // skip orphans defensively (also pruned on load)
    const start = attachStart(parent, node);
    const end = { x: node.x, y: node.y };
    const depth = depthOf(node);
    const color = resolvedColor(node);
    const w0 = widthForDepth(depth);
    const w1 = Math.max(2.5, widthForDepth(depth + 1) * 0.7);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "branch" + (node.id === selectedId ? " selected" : ""));
    path.setAttribute("d", branchPath(start, end, w0, w1));
    path.setAttribute("fill", color);
    path.dataset.id = node.id;
    gBranches.appendChild(path);

    if (node.image) drawImage(node);          // image IS the node, centred on its point
    drawLabel(node, start, end, color, depth); // label on top, lifted past the image
    drawHandle(node, color);                  // grab handle on top — the ONLY drag target
  }

  const sel = state.nodes[selectedId];        // inline + buttons on the selected node
  if (sel) drawAddButtons(sel);
}

function drawRoot(node) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "node root" + (node.id === selectedId ? " selected" : ""));
  g.dataset.id = node.id;

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "root-text");
  text.setAttribute("x", node.x);
  text.setAttribute("y", node.y);
  text.textContent = node.text || " ";
  g.appendChild(text);
  gNodes.appendChild(g);
  const bb = text.getBBox();

  if (node.image) {
    // Central image IS the node: drawn centred on the node point, the title
    // just below it. Branches attach on a small ellipse INSIDE the image, so
    // they emerge from under the picture instead of from a frame around it.
    const iw = 170, ih = 130;
    const img = document.createElementNS(SVG_NS, "image");
    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", node.image);
    img.setAttribute("href", node.image);
    img.setAttribute("x", node.x - iw / 2);
    img.setAttribute("y", node.y - ih / 2);
    img.setAttribute("width", iw);
    img.setAttribute("height", ih);
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    img.dataset.id = node.id;
    g.insertBefore(img, text);                                     // image behind the title
    const titleY = node.y + ih / 2 + bb.height * 0.55;
    text.setAttribute("y", titleY);
    rootAttach = { rx: iw * 0.34, ry: ih * 0.34 };                 // branches start under the image
    rootSize = { rx: iw / 2, ry: (titleY - node.y) + bb.height / 2 + 6 };
    labelWorld[node.id] = { x: node.x, y: titleY };
    return;
  }

  const ell = document.createElementNS(SVG_NS, "ellipse");
  rootSize = { rx: Math.max(64, bb.width / 2 + 30), ry: Math.max(40, bb.height / 2 + 22) };
  rootAttach = rootSize;
  ell.setAttribute("cx", node.x);
  ell.setAttribute("cy", node.y);
  ell.setAttribute("rx", rootSize.rx);
  ell.setAttribute("ry", rootSize.ry);
  g.insertBefore(ell, text);
  labelWorld[node.id] = { x: node.x, y: node.y };
}

// Label runs ALONG the branch curve (textPath) and ends at the tip, so it
// follows the branch shape and stacked siblings don't overlap (their tips are
// spread out). A hidden reference centre-line is built left-to-right (text
// stays upright) and extended on the parent side so long words never clip.
function drawLabel(node, start, end, color, depth) {
  const S = start, E = end;
  const [c1, c2] = controls(S, E);
  const tipRight = E.x >= S.x;
  const fs = fontForDepth(depth);
  const half = (widthForDepth(depth) + widthForDepth(depth + 1)) / 4;
  const EXT = 1000;
  const pathId = "lbl-" + node.id;

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "label" + (node.id === selectedId ? " selected" : ""));
  g.dataset.id = node.id;

  const cp = document.createElementNS(SVG_NS, "path");
  let d, anchor, offset;
  if (tipRight) {                                  // tip is the right end → word ENDS there
    d = `M ${(S.x - EXT).toFixed(1)} ${S.y.toFixed(1)} L ${S.x.toFixed(1)} ${S.y.toFixed(1)} ` +
        `C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${E.x.toFixed(1)} ${E.y.toFixed(1)}`;
    anchor = "end"; offset = "100%";
  } else {                                         // tip is the left end → word STARTS there
    d = `M ${E.x.toFixed(1)} ${E.y.toFixed(1)} C ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${S.x.toFixed(1)} ${S.y.toFixed(1)} ` +
        `L ${(S.x + EXT).toFixed(1)} ${S.y.toFixed(1)}`;
    anchor = "start"; offset = "0";
  }
  cp.setAttribute("d", d);
  cp.setAttribute("fill", "none");
  cp.setAttribute("stroke", "none");
  cp.setAttribute("id", pathId);
  cp.setAttribute("pointer-events", "none");
  g.appendChild(cp);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "branch-text");
  text.setAttribute("font-size", fs);
  text.setAttribute("fill", darken(color, 0.45));
  text.style.textAnchor = anchor;                  // inline style beats the .branch-text CSS
  text.setAttribute("dy", -(half + 5));            // float just above the branch
  const tp = document.createElementNS(SVG_NS, "textPath");
  tp.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#" + pathId);
  tp.setAttribute("href", "#" + pathId);
  tp.setAttribute("startOffset", offset);
  tp.textContent = node.text || " ";
  text.appendChild(tp);
  g.appendChild(text);
  gNodes.appendChild(g);

  const anchorPt = bezier(S, c1, c2, E, 0.78);      // editor opens near the tip
  labelWorld[node.id] = { x: anchorPt.x, y: anchorPt.y };
}

// The picture becomes the node: centred on the node's point so the incoming
// branch (which ends there) and any child branches (which start there) connect
// seamlessly underneath it, rather than dangling as a separate icon.
function drawImage(node) {
  const baseW = 120, baseH = 90;
  const s   = node.imageScale  || 1;
  const iw  = baseW * s, ih = baseH * s;
  // Default placement: image sits ABOVE the branch tip with a small gap, so
  // the label stays on the branch and the picture floats above it. Once the
  // user drags the image, that offset overrides the default for that node.
  const ox  = (node.imageOffsetX != null) ? node.imageOffsetX : 0;
  const oy  = (node.imageOffsetY != null) ? node.imageOffsetY : -(ih / 2 + 22);
  const cx  = node.x + ox, cy = node.y + oy;
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("href", node.image);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", node.image);
  img.setAttribute("x", cx - iw / 2);
  img.setAttribute("y", cy - ih / 2);
  img.setAttribute("width", iw);
  img.setAttribute("height", ih);
  img.setAttribute("preserveAspectRatio", "xMidYMid meet");
  img.dataset.id = node.id;
  img.setAttribute("class", "node-image" + (node.id === selectedId ? " selected" : ""));
  gNodes.appendChild(img);
  if (node.id === selectedId && !readOnly) drawImageControls(node, cx, cy, iw, ih);
}

// Small resize-handle (bottom-right) and delete-button (top-right) on top
// of the selected node's image. Both have a 1-class dataset.action so the
// pointerdown router can dispatch by action without further lookups.
function drawImageControls(node, cx, cy, iw, ih) {
  const r = 10;
  const rx = cx + iw / 2, ry = cy + ih / 2;
  const dx = cx + iw / 2, dy = cy - ih / 2;

  const resize = document.createElementNS(SVG_NS, "rect");
  resize.setAttribute("x", rx - r); resize.setAttribute("y", ry - r);
  resize.setAttribute("width", r * 2); resize.setAttribute("height", r * 2);
  resize.setAttribute("rx", 3);
  resize.setAttribute("class", "image-handle image-resize");
  resize.dataset.id = node.id;
  resize.dataset.action = "image-resize";
  gNodes.appendChild(resize);

  const del = document.createElementNS(SVG_NS, "circle");
  del.setAttribute("cx", dx); del.setAttribute("cy", dy);
  del.setAttribute("r", r);
  del.setAttribute("class", "image-handle image-delete");
  del.dataset.id = node.id;
  del.dataset.action = "image-delete";
  gNodes.appendChild(del);

  const cross = document.createElementNS(SVG_NS, "text");
  cross.setAttribute("x", dx); cross.setAttribute("y", dy + 1);
  cross.setAttribute("class", "image-delete-x");
  cross.textContent = "✕";
  gNodes.appendChild(cross);
}

// Inline "+" affordances on the selected node: add a child branch (outward
// from the tip) and, for non-root nodes, a following sibling branch.
function drawAddButtons(node) {
  const color = node.parentId ? resolvedColor(node) : "#b8860b";
  let childP, sibP = null;
  if (!node.parentId) {
    childP = { x: node.x + rootSize.rx + 26, y: node.y };
  } else {
    const start = attachStart(state.nodes[node.parentId], node);
    let ux = node.x - start.x, uy = node.y - start.y;
    const len = Math.hypot(ux, uy) || 1; ux /= len; uy /= len;
    childP = { x: node.x + ux * 40, y: node.y + uy * 40 };          // outward = new branch
    sibP = { x: node.x - uy * 40, y: node.y + ux * 40 };            // perpendicular = sibling
  }
  addBtn(childP.x, childP.y, node.id, "child", color, true);
  if (sibP) addBtn(sibP.x, sibP.y, node.id, "sibling", color, false);
}

function addBtn(x, y, id, action, color, filled) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "add-btn add-" + action);
  g.setAttribute("transform", `translate(${x} ${y})`);
  g.dataset.id = id;
  g.dataset.action = action;
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("r", filled ? 11 : 9);
  c.setAttribute("fill", filled ? color : "#fff");
  c.setAttribute("stroke", filled ? "#fff" : color);
  c.setAttribute("stroke-width", filled ? 2 : 2);
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("class", "add-plus");
  t.setAttribute("x", 0);
  t.setAttribute("y", 1);
  t.setAttribute("font-size", filled ? 16 : 13);
  t.setAttribute("fill", filled ? "#fff" : color);
  t.textContent = "+";
  g.appendChild(c); g.appendChild(t);
  gNodes.appendChild(g);
}

function drawHandle(node, color) {
  // Larger transparent hit area + a visible dot, so it is easy to grab.
  // The hit-circle gets ONLY .handle-hit (no .handle) so it doesn't inherit
  // the visible white stroke -- otherwise every node draws a 26px ring.
  const hit = document.createElementNS(SVG_NS, "circle");
  hit.setAttribute("class", "handle-hit");
  hit.setAttribute("cx", node.x);
  hit.setAttribute("cy", node.y);
  hit.setAttribute("r", 13);
  hit.setAttribute("fill", "transparent");
  hit.setAttribute("stroke", "none");
  hit.dataset.id = node.id;
  gNodes.appendChild(hit);

  const h = document.createElementNS(SVG_NS, "circle");
  h.setAttribute("class", "handle");
  h.setAttribute("cx", node.x);
  h.setAttribute("cy", node.y);
  h.setAttribute("r", 5);
  h.setAttribute("fill", color);
  h.dataset.id = node.id;
  gNodes.appendChild(h);
}

// ---- Coordinate helpers ---------------------------------------------------

function screenToWorld(sx, sy) {
  const rect = svg.getBoundingClientRect();
  return { x: (sx - rect.left - cam.x) / cam.scale, y: (sy - rect.top - cam.y) / cam.scale };
}

// ---- Node operations ------------------------------------------------------

// Lightweight selection: toggle classes in place. Rebuilding the whole DOM on
// every click detaches the clicked element, which (a) breaks native dblclick
// detection (the two clicks land on different nodes) and (b) made stray micro-
// movements feel like jumps. So selection must NOT call render().
function updateSelection() {
  document.querySelectorAll("#nodes [data-id], #branches [data-id]").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === selectedId);
  });
  // Refresh the inline "+" buttons in place (do NOT rebuild nodes/labels, or
  // native double-click would break again).
  document.querySelectorAll(".add-btn").forEach((el) => el.remove());
  const sel = state.nodes[selectedId];
  if (sel) drawAddButtons(sel);
}
function select(id) { selectedId = id; updateSelection(); }

function addChild(parentId) {
  if (readOnly) return;
  const parent = state.nodes[parentId];
  if (!parent) return;
  const sibs = children(parentId);
  if (!parent.parentId) {
    // Main branches radiate around the centre and stay where the user puts them.
    const ang = (sibs.length * 49) % 360 * Math.PI / 180;
    const r = 220;
    const node = newNode("idea", parentId, parent.x + Math.cos(ang) * r, parent.y + Math.sin(ang) * r, null);
    state.nodes[node.id] = node;
    selectedId = node.id; render(); save(); beginEdit(node.id); return;
  }
  // Place the new sub-branch in the parent's outward direction (grandparent →
  // parent), fanning siblings around that heading. Free to drag afterwards.
  const gp = state.nodes[parent.parentId];
  const baseAng = Math.atan2(parent.y - gp.y, parent.x - gp.x);
  const n = sibs.length;
  const off = (n === 0) ? 0 : (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * 24 * Math.PI / 180;
  const ang = baseAng + off;
  const node = newNode("idea", parentId, parent.x + Math.cos(ang) * 160, parent.y + Math.sin(ang) * 160, null);
  state.nodes[node.id] = node;
  selectedId = node.id; render(); save(); beginEdit(node.id);
}

function addSibling(id) {
  if (readOnly) return;
  const node = state.nodes[id];
  if (!node || !node.parentId) { addChild(id); return; }
  addChild(node.parentId);
}

function removeSubtree(id) {
  if (readOnly) return;
  if (!state.nodes[id] || !state.nodes[id].parentId) return;  // never delete root
  const toDelete = [];
  const collect = (nid) => { toDelete.push(nid); children(nid).forEach((c) => collect(c.id)); };
  collect(id);
  const parentId = state.nodes[id].parentId;
  toDelete.forEach((nid) => delete state.nodes[nid]);
  selectedId = parentId || state.rootId;
  save(); render();
}

// Drag a node and everything hanging off it as one piece (free translation),
// so the sub-tree keeps its organic hand-made shape.
function moveSubtree(id, dx, dy) {
  const move = (nid) => {
    state.nodes[nid].x += dx; state.nodes[nid].y += dy;
    children(nid).forEach((c) => move(c.id));   // children() returns node objects, not ids
  };
  move(id);
}

function descendantsOf(id) {
  const out = [];
  const walk = (nid) => children(nid).forEach((c) => { out.push(c); walk(c.id); });
  walk(id);
  return out;
}

// Drag handler: translate the node + its sub-tree, but the moment the node
// crosses to the other horizontal side of its parent, mirror the sub-tree
// left↔right so the side-branches flip to follow the branch's new direction.
function dragNode(id, dx, dy) {
  if (readOnly) return;
  const node = state.nodes[id];
  if (!node) return;
  const parent = node.parentId ? state.nodes[node.parentId] : null;
  const oldSide = parent ? Math.sign(node.x - parent.x) : 0;
  moveSubtree(id, dx, dy);
  if (parent) {
    const newSide = Math.sign(node.x - parent.x);
    if (oldSide && newSide && oldSide !== newSide) {
      descendantsOf(id).forEach((d) => { d.x = 2 * node.x - d.x; });   // mirror about node.x
    }
  }
}

function setColor(id, color) {
  if (readOnly) return;
  let n = state.nodes[id];
  if (!n || !n.parentId) return;
  while (state.nodes[n.parentId].parentId) n = state.nodes[n.parentId];
  n.color = color; save(); render();
}

function attachImage(id, dataUrl) {
  if (readOnly) return;
  const n = state.nodes[id];
  if (!n) return;
  n.image = dataUrl;
  // Fresh attach -> reset offset/scale so the picture lands in the default
  // "above the branch tip" spot regardless of what was there before.
  delete n.imageScale; delete n.imageOffsetX; delete n.imageOffsetY;
  save(); render();
}

function deleteImage(id) {
  if (readOnly) return;
  const n = state.nodes[id];
  if (!n || !n.image) return;
  delete n.image;
  delete n.imageScale; delete n.imageOffsetX; delete n.imageOffsetY;
  save(); render();
}

function moveImage(id, dx, dy) {
  if (readOnly) return;
  const n = state.nodes[id];
  if (!n || !n.image) return;
  const baseH = 90, ih = baseH * (n.imageScale || 1);
  const ox = (n.imageOffsetX != null) ? n.imageOffsetX : 0;
  const oy = (n.imageOffsetY != null) ? n.imageOffsetY : -(ih / 2 + 22);
  n.imageOffsetX = ox + dx;
  n.imageOffsetY = oy + dy;
}

function resizeImage(id, factor) {
  if (readOnly) return;
  const n = state.nodes[id];
  if (!n || !n.image) return;
  const next = Math.max(0.4, Math.min(3.5, (n.imageScale || 1) * factor));
  n.imageScale = next;
}

// ---- Inline editor --------------------------------------------------------

let editingId = null;

function beginEdit(id) {
  if (readOnly) return;
  const node = state.nodes[id];
  if (!node) return;
  editingId = id;
  const anchor = labelWorld[id] || { x: node.x, y: node.y };
  const r = svg.getBoundingClientRect();
  editor.value = node.text;
  editor.hidden = false;
  editor.style.left = (anchor.x * cam.scale + cam.x + r.left) + "px";
  editor.style.top = (anchor.y * cam.scale + cam.y + r.top) + "px";
  editor.style.transform = "translate(-50%, -50%)";
  editor.focus(); editor.select();
}

function commitEdit() {
  if (editingId == null) return;
  const node = state.nodes[editingId];
  if (node) node.text = editor.value.trim() || "idea";
  editingId = null; editor.hidden = true; save(); render();
}

editor.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
  else if (e.key === "Escape") { editingId = null; editor.hidden = true; render(); }
  e.stopPropagation();
});
editor.addEventListener("blur", commitEdit);

// ---- Pointer interaction --------------------------------------------------

let drag = null;

// Pointer Events + pointer capture: this guarantees we receive pointerup even
// when the pointer is released outside the window, so a drag can never get
// "stuck" and make a branch follow the cursor and shoot off screen.
function endDrag(e) {
  if (drag) {
    if (drag.pan && !drag.moved) select(null);   // tap on empty canvas = deselect
    else if (drag.moved && !drag.pan) save();    // node-drag / image-drag / image-resize committed
    svg.classList.remove("panning");
  }
  document.querySelectorAll(".handle.dragging").forEach((el) => el.classList.remove("dragging"));
  drag = null;
  if (e) { try { svg.releasePointerCapture(e.pointerId); } catch (_) {} }
}

svg.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.pointerType === "mouse") return;   // left button / touch / pen only
  const addEl = e.target.closest(".add-btn");          // inline + : add child / sibling
  if (addEl) {
    e.preventDefault();
    if (addEl.dataset.action === "sibling") addSibling(addEl.dataset.id);
    else addChild(addEl.dataset.id);
    return;
  }
  // Image controls (only rendered for the SELECTED node, so the node is
  // implicitly the right one). Delete is a click; resize starts a drag.
  const imgCtl = e.target.closest(".image-handle");
  if (imgCtl) {
    e.preventDefault();
    const id = imgCtl.dataset.id;
    if (imgCtl.dataset.action === "image-delete") { deleteImage(id); return; }
    if (imgCtl.dataset.action === "image-resize") {
      if (readOnly) return;
      const world = screenToWorld(e.clientX, e.clientY);
      drag = { kind: "image-resize", id, startSX: e.clientX, startSY: e.clientY,
               startDist: Math.hypot(world.x - state.nodes[id].x, world.y - state.nodes[id].y) || 1,
               startScale: state.nodes[id].imageScale || 1, moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
  }
  const handle = e.target.closest(".handle, .handle-hit"); // hit-area OR visible dot
  const imageEl = e.target.closest(".node-image");
  const idEl = e.target.closest("[data-id]");
  const world = screenToWorld(e.clientX, e.clientY);
  // An already-selected image becomes its own drag target so the picture
  // can be repositioned independently of the node it belongs to.
  if (imageEl && imageEl.dataset.id === selectedId && !readOnly) {
    drag = { kind: "image-move", id: imageEl.dataset.id, startSX: e.clientX, startSY: e.clientY,
             lastX: world.x, lastY: world.y, moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (handle) {
    select(handle.dataset.id);
    if (readOnly) return;                              // viewer: select-only, no drag
    // Reveal the matching visible handle dot only while the drag lasts.
    document.querySelectorAll(`.handle[data-id="${handle.dataset.id}"]`)
      .forEach((el) => el.classList.add("dragging"));
    drag = { id: handle.dataset.id, startSX: e.clientX, startSY: e.clientY, lastX: world.x, lastY: world.y, moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  } else if (idEl) {
    select(idEl.dataset.id);                            // click text/branch/image = select only
  } else {
    drag = { pan: true, startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    svg.classList.add("panning");
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  }
});

svg.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (e.buttons === 0) { endDrag(e); return; }          // button no longer held
  if (drag.pan) {
    cam.x = drag.camX + (e.clientX - drag.startX);
    cam.y = drag.camY + (e.clientY - drag.startY);
    applyCamera(); return;
  }
  // Ignore sub-threshold jitter so a click never nudges/stretches a branch.
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startSX, e.clientY - drag.startSY) < 4) return;
    drag.moved = true;   // cross threshold, then track the cursor from the grab point
  }
  const world = screenToWorld(e.clientX, e.clientY);
  if (drag.kind === "image-resize") {
    const node = state.nodes[drag.id]; if (!node) return;
    const dist = Math.hypot(world.x - node.x, world.y - node.y) || 1;
    node.imageScale = Math.max(0.4, Math.min(3.5, drag.startScale * (dist / drag.startDist)));
    render(); return;
  }
  const dx = world.x - drag.lastX, dy = world.y - drag.lastY;
  if (Math.abs(dx) > 4000 || Math.abs(dy) > 4000) return; // reject an implausible jump
  if (drag.kind === "image-move") {
    moveImage(drag.id, dx, dy);
  } else {
    dragNode(drag.id, dx, dy);
  }
  drag.lastX = world.x; drag.lastY = world.y;
  render();
});

svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

svg.addEventListener("dblclick", (e) => {
  const t = e.target.closest("[data-id]");
  if (t) { beginEdit(t.dataset.id); return; }
  const parent = state.nodes[selectedId] || state.nodes[state.rootId];
  const world = screenToWorld(e.clientX, e.clientY);
  const node = newNode("idea", parent.id, world.x, world.y, null);
  state.nodes[node.id] = node;
  selectedId = node.id; render(); save(); beginEdit(node.id);
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const wx = (mx - cam.x) / cam.scale, wy = (my - cam.y) / cam.scale;
  cam.scale = Math.min(3, Math.max(0.2, cam.scale * factor));
  cam.x = mx - wx * cam.scale; cam.y = my - wy * cam.scale;
  applyCamera(); save();
}, { passive: false });

// ---- Keyboard -------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (editingId != null) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
  if (e.key === "Tab") { e.preventDefault(); if (selectedId) addChild(selectedId); }
  else if (e.key === "Enter") { e.preventDefault(); if (selectedId) addSibling(selectedId); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (selectedId) removeSubtree(selectedId); }
  else if (e.key === "F2") { if (selectedId) beginEdit(selectedId); }
});

// ---- Fit to screen --------------------------------------------------------

function fit() {
  if (!Object.keys(state.nodes).length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of Object.values(state.nodes)) {
    const m = !n.parentId ? Math.max(rootSize.rx, rootSize.ry) + 20 : 70;
    minX = Math.min(minX, n.x - m); maxX = Math.max(maxX, n.x + m);
    minY = Math.min(minY, n.y - m); maxY = Math.max(maxY, n.y + m);
  }
  const rect = svg.getBoundingClientRect();
  const pad = 50;
  const sx = rect.width / (maxX - minX + pad * 2);
  const sy = rect.height / (maxY - minY + pad * 2);
  cam.scale = Math.min(2, Math.max(0.2, Math.min(sx, sy)));
  cam.x = rect.width / 2 - ((minX + maxX) / 2) * cam.scale;
  cam.y = rect.height / 2 - ((minY + maxY) / 2) * cam.scale;
  applyCamera(); save();
}

// ---- Toolbar --------------------------------------------------------------

function buildSwatches() {
  const host = $("swatches");
  host.textContent = "";
  PALETTE.forEach((col) => {
    const s = document.createElement("span");
    s.className = "swatch";
    s.style.background = col;
    s.title = col;
    s.addEventListener("click", () => { if (selectedId) setColor(selectedId, col); });
    host.appendChild(s);
  });
  // Custom colour: stack the native <input type=color> on top of a rainbow
  // swatch with opacity 0. iOS Safari won't open the picker for a hidden
  // input via .click(); putting a real, sized input above the visual swatch
  // makes tapping the rainbow IS a tap on the input, so the picker opens
  // natively on every platform.
  const wrap = document.createElement("span");
  wrap.className = "swatch-wrap";
  wrap.title = "Custom colour — opens the system picker (with eyedropper)";
  const face = document.createElement("span");
  face.className = "swatch custom";
  wrap.appendChild(face);
  wrap.appendChild($("custom-color"));
  host.appendChild(wrap);
}

$("custom-color").addEventListener("input", (e) => {
  if (selectedId) setColor(selectedId, e.target.value);
});

function activeId() { return (selectedId && state.nodes[selectedId]) ? selectedId : state.rootId; }
$("btn-add-child").addEventListener("click", () => addChild(activeId()));
$("btn-add-sibling").addEventListener("click", () => addSibling(activeId()));
$("btn-delete").addEventListener("click", () => removeSubtree(activeId()));
$("btn-image").addEventListener("click", () => selectedId && $("image-input").click());
$("btn-undo").addEventListener("click", undo);
$("btn-fit").addEventListener("click", fit);
$("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ nodes: state.nodes, rootId: state.rootId, nextId }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mcmindmap.json";
  a.click(); URL.revokeObjectURL(a.href);
});
$("btn-import").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = JSON.parse(reader.result);
      if (!doc.nodes || !doc.rootId) throw new Error("bad doc");
      state = { nodes: doc.nodes, rootId: doc.rootId };
      nextId = doc.nextId || (Object.keys(doc.nodes).length + 1);
      selectedId = state.rootId;
      render(); fit(); resetHistory();
    } catch (err) { alert("Could not import: invalid mindmap file."); }
  };
  reader.readAsText(file); e.target.value = "";
});
$("image-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file || !selectedId) return;
  const reader = new FileReader();
  reader.onload = () => attachImage(selectedId, reader.result);
  reader.readAsDataURL(file); e.target.value = "";
});

// ---- Boot -----------------------------------------------------------------

function centerRoot() {
  const rect = svg.getBoundingClientRect();
  const root = state.nodes[state.rootId];
  cam.scale = 1;
  cam.x = rect.width / 2 - root.x; cam.y = rect.height / 2 - root.y;
}

function boot() {
  buildSwatches();
  const had = load();
  if (!had) freshDoc();
  render();
  if (!had) { centerRoot(); }
  applyCamera();
  resetHistory();
}

// External control surface for the shell (auth / server persistence).
window.MindMap = {
  boot,
  fit,
  undo,
  newDoc() { freshDoc(); render(); centerRoot(); render(); resetHistory(); },
  getDoc() { return { nodes: state.nodes, rootId: state.rootId, nextId }; },
  loadDoc(doc) {
    if (!doc || !doc.nodes || !doc.rootId || !doc.nodes[doc.rootId]) { this.newDoc(); return; }
    state = { nodes: doc.nodes, rootId: doc.rootId };
    nextId = doc.nextId || (Object.keys(doc.nodes).length + 1);
    selectedId = state.rootId;
    sanitizeState();
    render(); fit(); resetHistory();
  },
  onChange(cb) { changeListeners.push(cb); },
  setReadOnly(v) { readOnly = !!v; document.body.classList.toggle("readonly", readOnly); },
};

window.addEventListener("resize", applyCamera);
if (!window.__MCM_DEFER_BOOT__) boot();
