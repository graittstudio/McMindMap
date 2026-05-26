"use strict";

const API = "api/index.php";
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token") || "";

$("reset-show").addEventListener("change", (e) => {
  const t = e.target.checked ? "text" : "password";
  $("new-pw").type = t; $("new-pw2").type = t;
});

if (!token) {
  $("reset-msg").textContent = "This reset link is missing or invalid. Request a new one from the sign-in page.";
  $("reset-btn").disabled = true;
}

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("reset-btn"), msg = $("reset-msg");
  msg.textContent = ""; msg.classList.remove("ok");
  const pw = $("new-pw").value, pw2 = $("new-pw2").value;
  if (pw.length < 8) { msg.textContent = "Password must be at least 8 characters."; return; }
  if (pw !== pw2) { msg.textContent = "The two passwords do not match."; return; }
  btn.disabled = true;
  try {
    const res = await fetch(`${API}?action=reset_with_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token, new: pw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "could not reset password");
    msg.classList.add("ok");
    msg.textContent = "Password updated — taking you to sign in…";
    setTimeout(() => location.replace("login.html"), 900);
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
});
