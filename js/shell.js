"use strict";

// Authentication + server persistence shell around the McMindMap editor.
// Wrapped in an IIFE: app.js and shell.js are classic scripts sharing the
// global scope, so top-level `const`s here must NOT leak (both files declare
// `$`, which would be a fatal redeclaration SyntaxError otherwise).
(function () {

const APP_VERSION = "v37 · 2026-06-17";
const API = "api/index.php";
const $ = (id) => document.getElementById(id);

let user = null;
let csrf = "";
let currentMapId = null;
let currentTitle = "Untitled";
let currentAccess = "owner";    // 'owner' | 'write' | 'read' for the open map
let currentShareMapId = null;   // map_id whose Share modal is currently open
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
  if (currentAccess === "read") return;   // viewer never persists local edits
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
  currentAccess = r.map.access || "owner";
  setTitle(r.map.title);
  applyAccess(r.map.owner_name);
  lastSavedJson = JSON.stringify(window.MindMap.getDoc());
  setSaveState(currentAccess === "read" ? "" : "saved");
  savePrefs({ lastMapId: id }).catch(() => {});
  closeDrawer();
}

// Toggle the read-only UI when the open map is shared-with-me (read access).
// The map-title click-to-rename is owner-only too.
function applyAccess(ownerName) {
  const ro = currentAccess === "read";
  window.MindMap.setReadOnly(ro);
  const banner = $("readonly-banner");
  if (ro && ownerName) {
    $("readonly-owner").textContent = ownerName;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  $("map-title").style.cursor = (currentAccess === "owner") ? "" : "default";
  // Share button: only the owner gets it -- a writer/viewer can't share on
  // somebody else's behalf.
  $("btn-share").hidden = (currentAccess !== "owner");
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
    const fallback = (list.maps && list.maps[0]) || (list.shared && list.shared[0]) || null;
    if (fallback) await loadMap(fallback.id);
    else await newMap();
  }
  await refreshMaps();
}

async function leaveShare(id, title) {
  if (!confirm(`Leave "${title}"? You can be re-added with a new link.`)) return;
  await api("share_leave", { body: { map_id: id } });
  if (id === currentMapId) {
    const list = await api("maps");
    const fallback = (list.maps && list.maps[0]) || (list.shared && list.shared[0]) || null;
    if (fallback) await loadMap(fallback.id);
    else await newMap();
  }
  await refreshMaps();
}

async function refreshMaps() {
  const r = await api("maps");
  const ul = $("maps-list");
  ul.innerHTML = "";
  const own = r.maps || [], shared = r.shared || [];
  if (!own.length && !shared.length) {
    ul.innerHTML = '<li class="empty">No mindmaps yet.</li>'; return;
  }
  for (const m of own) ul.appendChild(renderOwnItem(m));
  if (shared.length) {
    const head = document.createElement("li");
    head.className = "section-head";
    head.textContent = "Shared with me";
    ul.appendChild(head);
    for (const m of shared) ul.appendChild(renderSharedItem(m));
  }
}

function renderOwnItem(m) {
  const li = document.createElement("li");
  if (m.id === currentMapId) li.classList.add("current");
  const open = document.createElement("button");
  open.className = "map-open";
  open.innerHTML = `<span class="t">${escapeHtml(m.title)}</span><span class="d">${m.updated_at}</span>`;
  open.addEventListener("click", () => loadMap(m.id));
  const share = document.createElement("button");
  share.className = "map-share icon"; share.textContent = "↗"; share.title = "Share";
  share.addEventListener("click", (e) => { e.stopPropagation(); openShareModal(m.id, m.title); });
  const del = document.createElement("button");
  del.className = "map-del icon"; del.textContent = "🗑"; del.title = "Delete";
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteMap(m.id, m.title); });
  li.append(open, share, del);
  return li;
}

function renderSharedItem(m) {
  const li = document.createElement("li");
  if (m.id === currentMapId) li.classList.add("current");
  const badge = m.rights === "write"
    ? '<span class="badge edit">edit</span>'
    : '<span class="badge view">view</span>';
  const open = document.createElement("button");
  open.className = "map-open";
  open.innerHTML = `<span class="t">${escapeHtml(m.title)}${badge}</span>` +
                   `<span class="d">by ${escapeHtml(m.owner_name)} · ${m.updated_at}</span>`;
  open.addEventListener("click", () => loadMap(m.id));
  const leave = document.createElement("button");
  leave.className = "map-del icon"; leave.textContent = "✕"; leave.title = "Leave";
  leave.addEventListener("click", (e) => { e.stopPropagation(); leaveShare(m.id, m.title); });
  li.append(open, leave);
  return li;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---- Drawer / modals ------------------------------------------------------

function openDrawer() { refreshMaps(); $("maps-drawer").hidden = false; $("overlay").hidden = false; }
function closeDrawer() { $("maps-drawer").hidden = true; if (allClosed()) $("overlay").hidden = true; }
function allClosed() { return $("maps-drawer").hidden && $("prefs-modal").hidden && $("admin-modal").hidden && $("share-modal").hidden; }
function closeAll() { $("maps-drawer").hidden = $("prefs-modal").hidden = $("admin-modal").hidden = $("share-modal").hidden = $("overlay").hidden = true; $("user-menu").hidden = true; }

function openPrefs() {
  $("pref-name").value = displayName();
  $("pref-email").value = (user && user.email) || "";
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
    const email = $("pref-email").value.trim();
    user.prefs = Object.assign({}, prefs(), { display_name: $("pref-name").value.trim(), theme: $("pref-theme").value });
    await api("save_prefs", { body: { prefs: user.prefs, email } });
    user.email = email;
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
    tr.innerHTML = `<td>${escapeHtml(u.username)}</td><td>${u.role}</td>` +
      `<td>${escapeHtml(u.display_name)}${u.email ? '<br><span class="dim">' + escapeHtml(u.email) + '</span>' : ''}</td>`;
    const td = document.createElement("td"); td.className = "actions";
    const setEmail = document.createElement("button"); setEmail.textContent = "Email"; setEmail.className = "ghost sm";
    setEmail.addEventListener("click", () => editEmail(u));
    td.appendChild(setEmail);
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

async function editEmail(u) {
  const email = prompt(`Email address for "${u.username}" (used for password reset; leave blank to clear):`, u.email || "");
  if (email === null) return;
  try { await api("set_email", { body: { id: u.id, email: email.trim() } }); await refreshUsers(); flashAdmin(`Email updated for ${u.username}.`, true); }
  catch (e) { flashAdmin(e.message, false); }
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
      email: $("nu-email").value.trim(),
      password: $("nu-pw").value,
    } });
    $("nu-username").value = $("nu-name").value = $("nu-email").value = $("nu-pw").value = "";
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

  // Open: ?map=N (e.g. landing from share.html), else last opened, else most
  // recent own map, else first shared map, else a fresh one.
  const list = await api("maps");
  const all = (list.maps || []).concat(list.shared || []);
  const fromUrl = parseInt(new URLSearchParams(location.search).get("map") || "0", 10);
  const last = prefs().lastMapId;
  let target = null;
  if (fromUrl && all.find((m) => m.id === fromUrl)) target = fromUrl;
  else if (last && all.find((m) => m.id === last)) target = last;
  else if (list.maps && list.maps[0]) target = list.maps[0].id;
  else if (list.shared && list.shared[0]) target = list.shared[0].id;
  if (target) await loadMap(target);
  else await newMap();

  wireChrome();
}

function wireChrome() {
  $("btn-maps").addEventListener("click", openDrawer);
  $("drawer-close").addEventListener("click", closeDrawer);
  $("btn-new-map").addEventListener("click", newMap);
  $("btn-share").addEventListener("click", () => {
    if (currentAccess !== "owner" || !currentMapId) return;
    openShareModal(currentMapId, currentTitle);
  });
  $("overlay").addEventListener("click", closeAll);

  $("map-title").addEventListener("click", () => {
    if (currentAccess !== "owner") return;        // only the owner can rename
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
  wireShareModal();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
}

// ---- Share modal ----------------------------------------------------------

async function openShareModal(mapId, title) {
  currentShareMapId = mapId;
  $("share-modal").querySelector("h2").textContent = `Share "${title}"`;
  $("share-msg").textContent = ""; $("share-msg").className = "msg";
  await refreshShareState();
  $("share-modal").hidden = false; $("overlay").hidden = false; $("user-menu").hidden = true;
}

async function refreshShareState() {
  const r = await api(`share_state&map_id=${currentShareMapId}`);
  if (r.share) {
    $("share-link-input").value = r.share.link;
    $("share-rights").value = r.share.rights;
    $("share-revoked-note").hidden = r.share.active;
    $("share-revoke").textContent = r.share.active ? "Stop accepting new people" : "Reactivate link";
    $("share-revoke").dataset.action = r.share.active ? "revoke" : "activate";
  } else {
    $("share-link-input").value = "";
    $("share-revoked-note").hidden = true;
    $("share-revoke").textContent = "Stop accepting new people";
    $("share-revoke").dataset.action = "revoke";
  }
  renderShareClaims(r.claims || []);
}

async function ensureShareLink() {
  const rights = $("share-rights").value;
  const r = await api("share_link", { body: { map_id: currentShareMapId, rights } });
  $("share-link-input").value = r.link;
  $("share-rights").value = r.rights;
  $("share-revoked-note").hidden = r.active;
  $("share-revoke").textContent = r.active ? "Stop accepting new people" : "Reactivate link";
  $("share-revoke").dataset.action = r.active ? "revoke" : "activate";
  return r;
}

function renderShareClaims(claims) {
  const ul = $("share-claims-list");
  ul.innerHTML = "";
  if (!claims.length) {
    ul.innerHTML = '<li class="empty">No one yet.</li>'; return;
  }
  for (const c of claims) {
    const li = document.createElement("li");
    const tier = c.rights === "write" ? "edit" : "view";
    li.innerHTML = `<span class="claim-name">${escapeHtml(c.name)}</span>` +
                   `<span class="badge ${tier}">${tier}</span>`;
    const rev = document.createElement("button");
    rev.className = "icon"; rev.textContent = "✕"; rev.title = "Revoke access";
    rev.addEventListener("click", async () => {
      if (!confirm(`Stop sharing with ${c.name}?`)) return;
      await api("share_revoke_claim", { body: { claim_id: c.id } });
      await refreshShareState();
    });
    li.appendChild(rev);
    ul.appendChild(li);
  }
}

function wireShareModal() {
  $("share-copy").addEventListener("click", async () => {
    try {
      let link = $("share-link-input").value;
      if (!link) link = (await ensureShareLink()).link;
      await navigator.clipboard.writeText(link);
      flashShare("Link copied to clipboard.", true);
    } catch (e) { flashShare(e.message, false); }
  });
  $("share-rights").addEventListener("change", async () => {
    try { await ensureShareLink(); flashShare("Permission saved for new accepters.", true); }
    catch (e) { flashShare(e.message, false); }
  });
  $("share-revoke").addEventListener("click", async () => {
    try {
      const a = $("share-revoke").dataset.action;
      if (a === "revoke") {
        if (!confirm("Stop accepting NEW people via this link?\nPeople already on the list keep their access.")) return;
        await api("share_revoke_link", { body: { map_id: currentShareMapId } });
      } else {
        await ensureShareLink();
      }
      await refreshShareState();
    } catch (e) { flashShare(e.message, false); }
  });
  $("share-regenerate").addEventListener("click", async () => {
    try {
      if (!confirm("Generate a new link?\nThe old URL stops working immediately. People already on the list keep their access.")) return;
      const rights = $("share-rights").value;
      await api("share_regenerate", { body: { map_id: currentShareMapId, rights } });
      await refreshShareState();
      flashShare("New link generated.", true);
    } catch (e) { flashShare(e.message, false); }
  });
}

function flashShare(text, ok) {
  const m = $("share-msg"); m.textContent = text; m.className = "msg " + (ok ? "ok" : "");
}

async function logout() {
  try { await api("logout", { body: {} }); } catch (e) {}
  location.replace("login.html");
}

boot();

})();
