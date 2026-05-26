"use strict";

// Authentication + server persistence shell around the McMindMap editor.
// Wrapped in an IIFE: app.js and shell.js are classic scripts sharing the
// global scope, so top-level `const`s here must NOT leak (both files declare
// `$`, which would be a fatal redeclaration SyntaxError otherwise).
(function () {

const APP_VERSION = "v19 · 2026-05-26";
const API = "api/index.php";
const $ = (id) => document.getElementById(id);

let user = null;
let csrf = "";
let currentMapId = null;
let currentTitle = "Untitled";
let lastSavedJson = "";
let saveTimer = null;

async function api(action, opts = {}) {
  const headers = {};
  if (opts.body) { headers["Content-Type"] = "application/json"; if (csrf) headers["X-CSRF-Token"] = csrf; }
  const res = await fetch(`${API}?action=${action}`, {
    method: opts.body ? "POST" : "GET",
    headers, credentials: "same-origin",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) { location.replace("login.html"); throw new Error("not authenticated"); }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// ---- Preferences / theme --------------------------------------------------

function prefs() { return (user && user.prefs) || {}; }
function displayName() { return prefs().display_name || (user && user.display_name) || (user && user.username) || "user"; }

function applyTheme(theme) {
  document.body.dataset.theme = theme || "paper";
}

async function savePrefs(patch) {
  user.prefs = Object.assign({}, prefs(), patch);
  await api("save_prefs", { body: { prefs: user.prefs } });
}

// ---- Save flow ------------------------------------------------------------

function setSaveState(s) {
  const el = $("save-state");
  el.textContent = s === "saving" ? "saving…" : s === "saved" ? "✓ saved" : s === "error" ? "save failed" : "";
  el.className = "save-state " + (s || "");
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 900);
}

async function doSave() {
  const doc = window.MindMap.getDoc();
  const json = JSON.stringify(doc);
  if (json === lastSavedJson) return;
  setSaveState("saving");
  try {
    const r = await api("save_map", { body: { id: currentMapId || undefined, title: currentTitle, data: doc } });
    currentMapId = r.map.id;
    lastSavedJson = json;
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
  }
}

// ---- Maps -----------------------------------------------------------------

function setTitle(t) {
  currentTitle = (t || "Untitled").trim() || "Untitled";
  $("map-title").textContent = currentTitle;
}

async function loadMap(id) {
  const r = await api(`map&id=${id}`);
  window.MindMap.loadDoc(r.map.data);
  currentMapId = r.map.id;
  setTitle(r.map.title);
  lastSavedJson = JSON.stringify(window.MindMap.getDoc());
  setSaveState("saved");
  savePrefs({ lastMapId: id }).catch(() => {});
  closeDrawer();
}

async function newMap() {
  window.MindMap.newDoc();
  currentMapId = null;
  setTitle("Untitled");
  lastSavedJson = "";
  await doSave();                 // creates the record so it shows in the list
  savePrefs({ lastMapId: currentMapId }).catch(() => {});
  await refreshMaps();
  closeDrawer();
}

async function deleteMap(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  await api("delete_map", { body: { id } });
  if (id === currentMapId) {
    const list = await api("maps");
    if (list.maps.length) await loadMap(list.maps[0].id);
    else await newMap();
  }
  await refreshMaps();
}

async function refreshMaps() {
  const r = await api("maps");
  const ul = $("maps-list");
  ul.innerHTML = "";
  if (!r.maps.length) { ul.innerHTML = '<li class="empty">No mindmaps yet.</li>'; return; }
  for (const m of r.maps) {
    const li = document.createElement("li");
    if (m.id === currentMapId) li.classList.add("current");
    const open = document.createElement("button");
    open.className = "map-open";
    open.innerHTML = `<span class="t">${escapeHtml(m.title)}</span><span class="d">${m.updated_at}</span>`;
    open.addEventListener("click", () => loadMap(m.id));
    const del = document.createElement("button");
    del.className = "map-del icon"; del.textContent = "🗑"; del.title = "Delete";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteMap(m.id, m.title); });
    li.append(open, del);
    ul.appendChild(li);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- Drawer / modals ------------------------------------------------------

function openDrawer() { refreshMaps(); $("maps-drawer").hidden = false; $("overlay").hidden = false; }
function closeDrawer() { $("maps-drawer").hidden = true; if (allClosed()) $("overlay").hidden = true; }
function allClosed() { return $("maps-drawer").hidden && $("prefs-modal").hidden && $("admin-modal").hidden; }
function closeAll() { $("maps-drawer").hidden = $("prefs-modal").hidden = $("admin-modal").hidden = $("overlay").hidden = true; $("user-menu").hidden = true; }

function openPrefs() {
  $("pref-name").value = displayName();
  $("pref-theme").value = prefs().theme || "paper";
  $("pref-current").value = ""; $("pref-newpw").value = ""; $("pref-newpw2").value = "";
  $("pref-show").checked = false;
  ["pref-current", "pref-newpw", "pref-newpw2"].forEach((id) => { $(id).type = "password"; });
  $("prefs-msg").textContent = "";
  $("prefs-modal").hidden = false; $("overlay").hidden = false; $("user-menu").hidden = true;
}

async function savePrefsModal() {
  const msg = $("prefs-msg"); msg.textContent = ""; msg.className = "msg";
  const newpw = $("pref-newpw").value;
  try {
    if (newpw) {
      if (newpw.length < 8) { msg.textContent = "New password must be at least 8 characters."; return; }
      if (newpw !== $("pref-newpw2").value) { msg.textContent = "The two new passwords do not match."; return; }
      await api("change_password", { body: { current: $("pref-current").value, new: newpw } });
    }
    await savePrefs({ display_name: $("pref-name").value.trim(), theme: $("pref-theme").value });
    applyTheme(prefs().theme);
    renderUser();
    msg.className = "msg ok"; msg.textContent = "Saved.";
    setTimeout(closeAll, 500);
  } catch (e) { msg.textContent = e.message; }
}

// ---- Admin ----------------------------------------------------------------

async function openAdmin() {
  $("admin-msg").textContent = "";
  await refreshUsers();
  $("admin-modal").hidden = false; $("overlay").hidden = false; $("user-menu").hidden = true;
}

async function refreshUsers() {
  const r = await api("users");
  const tb = $("users-table").querySelector("tbody");
  tb.innerHTML = "";
  for (const u of r.users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(u.username)}</td><td>${u.role}</td><td>${escapeHtml(u.display_name)}</td>`;
    const td = document.createElement("td"); td.className = "actions";
    const reset = document.createElement("button"); reset.textContent = "Reset pw"; reset.className = "ghost sm";
    reset.addEventListener("click", () => resetPw(u));
    td.appendChild(reset);
    if (u.id !== user.id) {
      const del = document.createElement("button"); del.textContent = "Delete"; del.className = "ghost sm danger";
      del.addEventListener("click", () => delUser(u));
      td.appendChild(del);
    }
    tr.appendChild(td); tb.appendChild(tr);
  }
}

async function resetPw(u) {
  const pw = prompt(`New temporary password for "${u.username}" (min 8 chars):`);
  if (!pw) return;
  try { await api("reset_password", { body: { id: u.id, password: pw } }); flashAdmin(`Password reset for ${u.username}.`, true); }
  catch (e) { flashAdmin(e.message, false); }
}

async function delUser(u) {
  if (!confirm(`Delete user "${u.username}" and all their mindmaps?`)) return;
  try { await api("delete_user", { body: { id: u.id } }); await refreshUsers(); flashAdmin(`Deleted ${u.username}.`, true); }
  catch (e) { flashAdmin(e.message, false); }
}

async function addUser() {
  try {
    await api("create_user", { body: {
      username: $("nu-username").value.trim(),
      role: $("nu-role").value,
      display_name: $("nu-name").value.trim(),
      password: $("nu-pw").value,
    } });
    $("nu-username").value = $("nu-name").value = $("nu-pw").value = "";
    await refreshUsers();
    flashAdmin("User created.", true);
  } catch (e) { flashAdmin(e.message, false); }
}

function flashAdmin(text, ok) {
  const m = $("admin-msg"); m.textContent = text; m.className = "msg " + (ok ? "ok" : "");
}

// ---- User chrome ----------------------------------------------------------

function renderUser() {
  $("user-name").textContent = displayName();
  $("user-avatar").textContent = (displayName()[0] || "?").toUpperCase();
  $("menu-admin").hidden = user.role !== "admin";
}

// ---- Boot -----------------------------------------------------------------

async function boot() {
  const verEl = $("app-version"); if (verEl) verEl.textContent = APP_VERSION;
  const mverEl = $("menu-version"); if (mverEl) mverEl.textContent = "McMindMap " + APP_VERSION;
  let me;
  try { me = await api("me"); } catch (e) { location.replace("login.html"); return; }
  if (!me || !me.user) { location.replace("login.html"); return; }
  if (me.user.must_change) { location.replace("login.html"); return; }
  user = me.user; csrf = me.csrf || "";

  applyTheme(prefs().theme);
  renderUser();

  window.MindMap.boot();
  window.MindMap.onChange(scheduleSave);

  // open last map, or most recent, or a fresh one
  const list = await api("maps");
  const last = prefs().lastMapId;
  const target = (last && list.maps.find((m) => m.id === last)) ? last
               : (list.maps[0] ? list.maps[0].id : null);
  if (target) await loadMap(target);
  else await newMap();

  wireChrome();
}

function wireChrome() {
  $("btn-maps").addEventListener("click", openDrawer);
  $("drawer-close").addEventListener("click", closeDrawer);
  $("btn-new-map").addEventListener("click", newMap);
  $("overlay").addEventListener("click", closeAll);

  $("map-title").addEventListener("click", () => {
    const t = prompt("Mindmap title:", currentTitle);
    if (t == null) return;
    setTitle(t); lastSavedJson = ""; doSave();
  });

  $("user-btn").addEventListener("click", (e) => { e.stopPropagation(); $("user-menu").hidden = !$("user-menu").hidden; });
  document.addEventListener("click", () => { $("user-menu").hidden = true; });
  $("user-menu").addEventListener("click", (e) => e.stopPropagation());
  $("user-menu").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.act;
    if (a === "prefs") openPrefs();
    else if (a === "admin") openAdmin();
    else if (a === "logout") logout();
  }));

  document.querySelectorAll(".modal .close").forEach((b) => b.addEventListener("click", closeAll));
  $("prefs-save").addEventListener("click", savePrefsModal);
  $("pref-show").addEventListener("change", (e) => {
    const t = e.target.checked ? "text" : "password";
    ["pref-current", "pref-newpw", "pref-newpw2"].forEach((id) => { $(id).type = t; });
  });
  $("nu-add").addEventListener("click", addUser);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
}

async function logout() {
  try { await api("logout", { body: {} }); } catch (e) {}
  location.replace("login.html");
}

boot();

})();
