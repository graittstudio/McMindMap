"use strict";

const API = "api/index.php";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get("t") || "";
let csrf = "";

async function call(action, opts = {}) {
  const url = `${API}?action=${action}` + (opts.query || "");
  const headers = {};
  if (opts.body) {
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(url, {
    method: opts.body ? "POST" : "GET",
    headers,
    credentials: "same-origin",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function showError(msg) {
  $("share-loading").hidden = true;
  $("share-accept").hidden = true;
  $("share-error").hidden = false;
  $("share-error-msg").textContent = msg;
}

function showAccept(info) {
  $("share-loading").hidden = true;
  $("share-accept").hidden = false;
  $("share-title-text").textContent = info.title;
  $("share-owner").textContent = info.owner;
  $("share-rights").textContent = info.rights === "write" ? "can edit" : "read only";
}

(async () => {
  if (!token) { showError("This link is missing a token."); return; }

  // 1. Are we signed in? If not, bounce through login with a next= so we
  //    come back here after authenticating.
  let me;
  try { me = await call("me"); }
  catch (e) { showError("Unable to reach the server."); return; }
  if (!me.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`login.html?next=${next}`);
    return;
  }
  csrf = me.csrf || "";

  // 2. Peek at the share. Errors here are friendly text on the card.
  let info;
  try { info = await call("share_info", { query: "&token=" + encodeURIComponent(token) }); }
  catch (e) { showError(e.message); return; }

  // Owner clicking their own link, or already accepted -> just open the map.
  if (info.is_owner || info.already_claimed) {
    location.replace(`index.html?map=${info.map_id}`);
    return;
  }
  if (!info.active) {
    showError("This share link is no longer active.");
    return;
  }

  // 3. Show the accept card.
  showAccept(info);

  $("share-accept-btn").addEventListener("click", async () => {
    const btn = $("share-accept-btn");
    btn.disabled = true;
    $("share-msg").textContent = "";
    try {
      const r = await call("share_claim", { body: { token } });
      location.replace(`index.html?map=${r.map_id}`);
    } catch (e) {
      $("share-msg").textContent = e.message;
      btn.disabled = false;
    }
  });

  $("share-decline").addEventListener("click", () => {
    location.replace("index.html");
  });
})();
