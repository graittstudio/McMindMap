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
let cam = { x: 0, y: 0, scale: 1 };
let nextId = 1;

let rootSize = { rx: 70, ry: 48 };
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

// Control points give branches a gentle S-curve like a hand-drawn map.
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

// Where a child branch starts on its parent.
function attachStart(parent, child) {
  if (parent.parentId) return { x: parent.x, y: parent.y };  // chain tip-to-tip
  const ang = Math.atan2(child.y - parent.y, child.x - parent.x);
  return { x: parent.x + Math.cos(ang) * rootSize.rx, y: parent.y + Math.sin(ang) * rootSize.ry };
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

    if (node.image) drawImage(node, start, end);
    drawLabel(node, start, end, color, depth);
    drawHandle(node, color);
  }
}

function drawRoot(node) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "node root" + (node.id === selectedId ? " selected" : ""));
  g.dataset.id = node.id;

  const ell = document.createElementNS(SVG_NS, "ellipse");
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "root-text");
  text.setAttribute("x", node.x);
  text.setAttribute("y", node.y);
  text.textContent = node.text || " ";
  g.appendChild(ell);
  if (node.image) {
    // root image sits behind the text
  }
  g.appendChild(text);
  gNodes.appendChild(g);

  const bb = text.getBBox();
  rootSize = { rx: Math.max(64, bb.width / 2 + 30), ry: Math.max(40, bb.height / 2 + 22) };
  ell.setAttribute("cx", node.x);
  ell.setAttribute("cy", node.y);
  ell.setAttribute("rx", rootSize.rx);
  ell.setAttribute("ry", rootSize.ry);

  if (node.image) {
    const img = document.createElementNS(SVG_NS, "image");
    const iw = rootSize.rx * 1.6, ih = rootSize.ry * 1.6;
    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", node.image);
    img.setAttribute("href", node.image);
    img.setAttribute("x", node.x - iw / 2);
    img.setAttribute("y", node.y - ih / 2 - rootSize.ry - 8);
    img.setAttribute("width", iw);
    img.setAttribute("height", ih);
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    img.dataset.id = node.id;
    g.insertBefore(img, text);
  }
  labelWorld[node.id] = { x: node.x, y: node.y };
}

function drawLabel(node, start, end, color, depth) {
  const [c1, c2] = controls(start, end);
  const mid = bezier(start, c1, c2, end, 0.5);
  const tan = bezierTangent(start, c1, c2, end, 0.5);
  let ang = Math.atan2(tan.y, tan.x) * 180 / Math.PI;
  if (ang > 90 || ang < -90) ang += 180;            // keep text upright
  const fs = fontForDepth(depth);
  const half = (widthForDepth(depth) + widthForDepth(depth + 1)) / 4;

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "label" + (node.id === selectedId ? " selected" : ""));
  g.setAttribute("transform", `translate(${mid.x} ${mid.y}) rotate(${ang})`);
  g.dataset.id = node.id;

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "branch-text");
  text.setAttribute("x", 0);
  text.setAttribute("y", -(half + 5));
  text.setAttribute("font-size", fs);
  text.setAttribute("fill", darken(color, 0.45));
  text.textContent = node.text || " ";
  g.appendChild(text);
  gNodes.appendChild(g);

  labelWorld[node.id] = { x: mid.x, y: mid.y };
}

function drawImage(node, start, end) {
  const ang = Math.atan2(end.y - start.y, end.x - start.x);
  const iw = 84, ih = 64;
  const cx = end.x + Math.cos(ang) * 8;
  const cy = end.y + Math.sin(ang) * 8 + ih / 2 + 14;
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("href", node.image);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", node.image);
  img.setAttribute("x", cx - iw / 2);
  img.setAttribute("y", cy - ih / 2);
  img.setAttribute("width", iw);
  img.setAttribute("height", ih);
  img.setAttribute("preserveAspectRatio", "xMidYMid meet");
  img.dataset.id = node.id;
  img.setAttribute("class", "node-image");
  gNodes.appendChild(img);
}

function drawHandle(node, color) {
  const h = document.createElementNS(SVG_NS, "circle");
  h.setAttribute("class", "handle" + (node.id === selectedId ? " selected" : ""));
  h.setAttribute("cx", node.x);
  h.setAttribute("cy", node.y);
  h.setAttribute("r", node.id === selectedId ? 6 : 4);
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

function select(id) { selectedId = id; render(); }

function addChild(parentId) {
  const parent = state.nodes[parentId];
  if (!parent) return;
  const sibs = children(parentId);
  let dir;
  if (!parent.parentId) {
    const ang = (sibs.length * 49) % 360 * Math.PI / 180;   // fan around the centre
    const r = 220;
    const node = newNode("idea", parentId, parent.x + Math.cos(ang) * r, parent.y + Math.sin(ang) * r, null);
    state.nodes[node.id] = node;
    select(node.id); save(); beginEdit(node.id); return;
  }
  dir = parent.x >= state.nodes[state.rootId].x ? 1 : -1;
  const x = parent.x + dir * 170;
  const y = parent.y + sibs.length * 70 - (sibs.length * 70) / 2;
  const node = newNode("idea", parentId, x, y, null);
  state.nodes[node.id] = node;
  select(node.id); save(); beginEdit(node.id);
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
  save(); render();
}

function moveSubtree(id, dx, dy) {
  const move = (nid) => {
    state.nodes[nid].x += dx; state.nodes[nid].y += dy;
    children(nid).forEach(move);
  };
  move(id);
}

function setColor(id, color) {
  let n = state.nodes[id];
  if (!n || !n.parentId) return;
  while (state.nodes[n.parentId].parentId) n = state.nodes[n.parentId];
  n.color = color; save(); render();
}

function attachImage(id, dataUrl) {
  const n = state.nodes[id];
  if (!n) return;
  n.image = dataUrl; save(); render();
}

// ---- Inline editor --------------------------------------------------------

let editingId = null;

function beginEdit(id) {
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

svg.addEventListener("mousedown", (e) => {
  const t = e.target.closest("[data-id]");
  const world = screenToWorld(e.clientX, e.clientY);
  if (t) {
    const id = t.dataset.id;
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
    applyCamera(); return;
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
    if (!drag.pan && drag.moved) save();
    svg.classList.remove("panning");
  }
  drag = null;
});

svg.addEventListener("dblclick", (e) => {
  const t = e.target.closest("[data-id]");
  if (t) { beginEdit(t.dataset.id); return; }
  const parent = state.nodes[selectedId] || state.nodes[state.rootId];
  const world = screenToWorld(e.clientX, e.clientY);
  const node = newNode("idea", parent.id, world.x, world.y, null);
  state.nodes[node.id] = node;
  select(node.id); save(); beginEdit(node.id);
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
}

$("btn-add-child").addEventListener("click", () => selectedId && addChild(selectedId));
$("btn-add-sibling").addEventListener("click", () => selectedId && addSibling(selectedId));
$("btn-delete").addEventListener("click", () => selectedId && removeSubtree(selectedId));
$("btn-image").addEventListener("click", () => selectedId && $("image-input").click());
$("btn-fit").addEventListener("click", fit);
$("btn-new").addEventListener("click", () => {
  if (!confirm("Discard the current mindmap and start a new one?")) return;
  freshDoc(); render(); centerRoot(); render(); save();
});
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
      render(); fit();
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
}

window.addEventListener("resize", applyCamera);
boot();
