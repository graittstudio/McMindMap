"use strict";

const API = "api/index.php";
const $ = (id) => document.getElementById(id);

let csrf = "";

async function api(action, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.body && csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`${API}?action=${action}`, {
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

function showChangeForm() {
  $("login-form").hidden = true;
  $("change-form").hidden = false;
  $("new-pw").focus();
}

// If already signed in (and not forced to change), skip straight to the app.
(async () => {
  try {
    const me = await api("me");
    if (me.user) {
      csrf = me.csrf || "";
      if (me.user.must_change) showChangeForm();
      else location.replace("index.html");
    }
  } catch (e) { /* not logged in */ }
})();

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn"), msg = $("login-msg");
  msg.textContent = ""; msg.classList.remove("ok");
  btn.disabled = true;
  try {
    const r = await api("login", { body: { username: $("username").value, password: $("password").value } });
    csrf = r.csrf || "";
    if (r.user.must_change) showChangeForm();
    else location.replace("index.html");
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
});

$("login-show").addEventListener("change", (e) => {
  $("password").type = e.target.checked ? "text" : "password";
});
$("change-show").addEventListener("change", (e) => {
  const t = e.target.checked ? "text" : "password";
  $("new-pw").type = t; $("new-pw2").type = t;
});

$("change-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("change-btn"), msg = $("change-msg");
  msg.textContent = ""; msg.classList.remove("ok");
  const pw = $("new-pw").value, pw2 = $("new-pw2").value;
  if (pw.length < 8) { msg.textContent = "Password must be at least 8 characters."; return; }
  if (pw !== pw2) { msg.textContent = "Passwords do not match."; return; }
  btn.disabled = true;
  try {
    await api("change_password", { body: { current: "", new: pw } });
    msg.classList.add("ok");
    msg.textContent = "Password updated — entering…";
    setTimeout(() => location.replace("index.html"), 600);
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
});
