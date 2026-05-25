"use strict";

const PALETTE = [
  "#e8453c", "#f4a900", "#3aa655", "#1d9bf0",
  "#8a4fc7", "#e0529c", "#16b3a7", "#f06a2e",
];
const STORAGE_KEY = "mindmap.doc.v1";

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
let cam = { x: 0, y: 0, scale: 1 };
let nextId = 1;

function newNode(text, parentId, x, y, color) {
  return { id: "n" + nextId++, text, parentId, x, y, color: color || null };
}

function freshDoc() {
  nextId = 1;
  const root = newNode("Central idea", null, 0, 0, null);
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

// Resolve the colour of a node: top-level branch colour, inherited downward.
function resolvedColor(node) {
  let n = node;
  while (n.parentId && state.nodes[n.parentId].parentId) {
    n = state.nodes[n.parentId];
  }
  if (!n.parentId) return "#888";          // root itself
  if (!n.color) {
    const idx = children(state.rootId).indexOf(n);
    n.color = PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
  }
  return n.color;
}

// ---- Persistence ----------------------------------------------------------

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      nodes: state.nodes, rootId: state.rootId, nextId, cam,
    }));
  } catch (e) { /* storage may be unavailable */ }
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
    return true;
  } catch (e) { return false; }
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

function branchPath(p0, p1, w0, w1) {
  const dx = p1.x - p0.x;
  const c1 = { x: p0.x + dx * 0.5, y: p0.y };
  const c2 = { x: p1.x - dx * 0.5, y: p1.y };
  const N = 26;
  const left = [], right = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const pt = bezier(p0, c1, c2, p1, t);
    const tan = bezierTangent(p0, c1, c2, p1, t);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len, ny = tan.x / len;
    const w = (w0 + (w1 - w0) * Math.pow(t, 1.3)) / 2;
    left.push({ x: pt.x + nx * w, y: pt.y + ny * w });
    right.push({ x: pt.x - nx * w, y: pt.y - ny * w });
  }
  let d = `M ${left[0].x.toFixed(1)} ${left[0].y.toFixed(1)}`;
  for (let i = 1; i <= N; i++) d += ` L ${left[i].x.toFixed(1)} ${left[i].y.toFixed(1)}`;
  for (let i = N; i >= 0; i--) d += ` L ${right[i].x.toFixed(1)} ${right[i].y.toFixed(1)}`;
  return d + " Z";
}

function widthForDepth(d) {
  return Math.max(5, 19 - d * 4);
}

// ---- Rendering ------------------------------------------------------------

const sizeCache = {};   // id -> {w,h} measured

function applyCamera() {
  gViewport.setAttribute("transform",
    `translate(${cam.x} ${cam.y}) scale(${cam.scale})`);
}

function render() {
  applyCamera();
  gNodes.textContent = "";
  gBranches.textContent = "";

  // First pass: draw node boxes (and measure), so we know sizes.
  for (const node of Object.values(state.nodes)) {
    drawNode(node);
  }
  // Second pass: branches behind nodes.
  for (const node of Object.values(state.nodes)) {
    if (!node.parentId) continue;
    const parent = state.nodes[node.parentId];
    const p0 = { x: parent.x, y: parent.y };
    const p1 = { x: node.x, y: node.y };
    const dp = depthOf(parent);
    const w0 = widthForDepth(dp + 1);
    const w1 = Math.max(2.5, w0 * 0.4);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "branch");
    path.setAttribute("d", branchPath(p0, p1, w0, w1));
    path.setAttribute("fill", resolvedColor(node));
    gBranches.appendChild(path);
  }
}

function drawNode(node) {
  const isRoot = !node.parentId;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "node" + (isRoot ? " root" : "") +
    (node.id === selectedId ? " selected" : ""));
  g.dataset.id = node.id;

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "node-rect");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "node-text");
  text.textContent = node.text || " ";

  g.appendChild(rect);
  g.appendChild(text);
  gNodes.appendChild(g);

  // measure text now that it is in the DOM
  const bb = text.getBBox();
  const padX = isRoot ? 22 : 14;
  const padY = isRoot ? 14 : 9;
  const w = Math.max(isRoot ? 90 : 40, bb.width + padX * 2);
  const h = bb.height + padY * 2;
  sizeCache[node.id] = { w, h };

  rect.setAttribute("x", node.x - w / 2);
  rect.setAttribute("y", node.y - h / 2);
  rect.setAttribute("width", w);
  rect.setAttribute("height", h);
  rect.setAttribute("rx", isRoot ? 22 : 16);
  rect.setAttribute("ry", isRoot ? 22 : 16);
  rect.setAttribute("fill", isRoot ? "var(--root-fill)" : tint(resolvedColor(node)));

  text.setAttribute("x", node.x);
  text.setAttribute("y", node.y);
}

// Lighten a branch colour for the node fill.
function tint(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  const mix = (v) => Math.round(v + (255 - v) * 0.82);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// ---- Coordinate helpers ---------------------------------------------------

function screenToWorld(sx, sy) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (sx - rect.left - cam.x) / cam.scale,
    y: (sy - rect.top - cam.y) / cam.scale,
  };
}

// ---- Node operations ------------------------------------------------------

function select(id) {
  selectedId = id;
  render();
}

function addChild(parentId) {
  const parent = state.nodes[parentId];
  if (!parent) return;
  const sibs = children(parentId);
  let dir;
  if (!parent.parentId) {
    dir = sibs.length % 2 === 0 ? 1 : -1;     // alternate sides off the root
  } else {
    dir = parent.x >= state.nodes[state.rootId].x ? 1 : -1;
  }
  const pw = (sizeCache[parentId] || { w: 80 }).w;
  const x = parent.x + dir * (pw / 2 + 150);
  const spread = 78;
  const y = parent.y + sibs.length * spread - (sibs.length * spread) / 2;
  const node = newNode("New idea", parentId, x, y, null);
  state.nodes[node.id] = node;
  select(node.id);
  save();
  beginEdit(node.id);
}

function addSibling(id) {
  const node = state.nodes[id];
  if (!node || !node.parentId) { addChild(id); return; }
  addChild(node.parentId);
}

function removeSubtree(id) {
  if (!state.nodes[id] || !state.nodes[id].parentId) return;  // never delete root
  const toDelete = [];
  const collect = (nid) => { toDelete.push(nid); children(nid).forEach(collect); };
  collect(id);
  const parentId = state.nodes[id].parentId;
  toDelete.forEach((nid) => delete state.nodes[nid]);
  selectedId = parentId || state.rootId;
  save();
  render();
}

function moveSubtree(id, dx, dy) {
  const move = (nid) => {
    state.nodes[nid].x += dx;
    state.nodes[nid].y += dy;
    children(nid).forEach(move);
  };
  move(id);
}

function setColor(id, color) {
  // colour applies to the top-level branch containing this node
  let n = state.nodes[id];
  if (!n || !n.parentId) return;
  while (state.nodes[n.parentId].parentId) n = state.nodes[n.parentId];
  n.color = color;
  save();
  render();
}

// ---- Inline editor --------------------------------------------------------

let editingId = null;

function beginEdit(id) {
  const node = state.nodes[id];
  if (!node) return;
  editingId = id;
  const sx = node.x * cam.scale + cam.x + svg.getBoundingClientRect().left;
  const sy = node.y * cam.scale + cam.y + svg.getBoundingClientRect().top;
  editor.value = node.text;
  editor.hidden = false;
  editor.style.left = sx + "px";
  editor.style.top = sy + "px";
  editor.style.transform = "translate(-50%, -50%)";
  editor.style.minWidth = "80px";
  editor.focus();
  editor.select();
}

function commitEdit() {
  if (editingId == null) return;
  const node = state.nodes[editingId];
  if (node) node.text = editor.value.trim() || "Untitled";
  editingId = null;
  editor.hidden = true;
  save();
  render();
}

editor.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
  else if (e.key === "Escape") { editingId = null; editor.hidden = true; render(); }
  e.stopPropagation();
});
editor.addEventListener("blur", commitEdit);

// ---- Pointer interaction --------------------------------------------------

let drag = null;   // {id, startWorld, moved} or {pan, startX, startY, camX, camY}

svg.addEventListener("mousedown", (e) => {
  const g = e.target.closest(".node");
  const world = screenToWorld(e.clientX, e.clientY);
  if (g) {
    const id = g.dataset.id;
    select(id);
    drag = { id, lastX: world.x, lastY: world.y, moved: false };
  } else {
    drag = { pan: true, startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    svg.classList.add("panning");
  }
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  if (drag.pan) {
    cam.x = drag.camX + (e.clientX - drag.startX);
    cam.y = drag.camY + (e.clientY - drag.startY);
    applyCamera();
    return;
  }
  const world = screenToWorld(e.clientX, e.clientY);
  const dx = world.x - drag.lastX, dy = world.y - drag.lastY;
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) drag.moved = true;
  moveSubtree(drag.id, dx, dy);
  drag.lastX = world.x; drag.lastY = world.y;
  render();
});

window.addEventListener("mouseup", () => {
  if (drag) {
    if (drag.pan) { cam.x = cam.x; save(); }
    else if (drag.moved) save();
    svg.classList.remove("panning");
  }
  drag = null;
});

svg.addEventListener("dblclick", (e) => {
  const g = e.target.closest(".node");
  if (g) {
    beginEdit(g.dataset.id);
  } else {
    // add a child to the currently selected node at the cursor
    const parent = state.nodes[selectedId] || state.nodes[state.rootId];
    const world = screenToWorld(e.clientX, e.clientY);
    const node = newNode("New idea", parent.id, world.x, world.y, null);
    state.nodes[node.id] = node;
    select(node.id);
    save();
    beginEdit(node.id);
  }
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const wx = (mx - cam.x) / cam.scale, wy = (my - cam.y) / cam.scale;
  cam.scale = Math.min(3, Math.max(0.2, cam.scale * factor));
  cam.x = mx - wx * cam.scale;
  cam.y = my - wy * cam.scale;
  applyCamera();
  save();
}, { passive: false });

// ---- Keyboard -------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  if (editingId != null) return;
  if (e.key === "Tab") { e.preventDefault(); if (selectedId) addChild(selectedId); }
  else if (e.key === "Enter") { e.preventDefault(); if (selectedId) addSibling(selectedId); }
  else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault(); if (selectedId) removeSubtree(selectedId);
  } else if (e.key === "F2") { if (selectedId) beginEdit(selectedId); }
});

// ---- Fit to screen --------------------------------------------------------

function fit() {
  const ids = Object.keys(state.nodes);
  if (!ids.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of Object.values(state.nodes)) {
    const s = sizeCache[n.id] || { w: 80, h: 40 };
    minX = Math.min(minX, n.x - s.w / 2); maxX = Math.max(maxX, n.x + s.w / 2);
    minY = Math.min(minY, n.y - s.h / 2); maxY = Math.max(maxY, n.y + s.h / 2);
  }
  const rect = svg.getBoundingClientRect();
  const pad = 60;
  const sx = rect.width / (maxX - minX + pad * 2);
  const sy = rect.height / (maxY - minY + pad * 2);
  cam.scale = Math.min(3, Math.max(0.2, Math.min(sx, sy)));
  cam.x = rect.width / 2 - ((minX + maxX) / 2) * cam.scale;
  cam.y = rect.height / 2 - ((minY + maxY) / 2) * cam.scale;
  applyCamera();
  save();
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
}

$("btn-add-child").addEventListener("click", () => selectedId && addChild(selectedId));
$("btn-add-sibling").addEventListener("click", () => selectedId && addSibling(selectedId));
$("btn-delete").addEventListener("click", () => selectedId && removeSubtree(selectedId));
$("btn-fit").addEventListener("click", fit);
$("btn-new").addEventListener("click", () => {
  if (!confirm("Discard the current mindmap and start a new one?")) return;
  freshDoc(); centerRoot(); render(); save();
});
$("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ nodes: state.nodes, rootId: state.rootId, nextId }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mindmap.json";
  a.click();
  URL.revokeObjectURL(a.href);
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
      fit(); render(); save();
    } catch (err) { alert("Could not import: invalid mindmap file."); }
  };
  reader.readAsText(file);
  e.target.value = "";
});

// ---- Boot -----------------------------------------------------------------

function centerRoot() {
  const rect = svg.getBoundingClientRect();
  const root = state.nodes[state.rootId];
  cam.scale = 1;
  cam.x = rect.width / 2 - root.x * cam.scale;
  cam.y = rect.height / 2 - root.y * cam.scale;
}

function boot() {
  buildSwatches();
  if (!load()) { freshDoc(); render(); centerRoot(); }
  render();
  applyCamera();
}

window.addEventListener("resize", applyCamera);
boot();
