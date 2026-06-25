// ============================================================
// SNKRS Bot – Admin Panel
// Manages the RSA key pair, generates/revokes license keys.
// Requires license.js to be loaded first.
// ============================================================

const S_PUB     = "snkrsAdminPubKey";   // public key JWK (plain)
const S_PRIV    = "snkrsAdminPrivEnc";  // encrypted private key blob
const S_PINHASH = "snkrsAdminPinHash";  // SHA-256 of PIN
const S_KEYS    = "snkrsAdminKeys";     // [{id,user,exp,note,keyString,revoked,iat}]
const S_REVOKED = "snkrsRevoked";       // [id,...] — also read by dashboard for validation

let _privJwk    = null; // decrypted in-session private key JWK
let _pubJwk     = null; // public key JWK

// ── Storage helpers ───────────────────────────────────────────
async function sg(key) { const d = await chrome.storage.local.get(key); return d[key]; }
async function ss(obj) { await chrome.storage.local.set(obj); }

// ── Small DOM helpers ─────────────────────────────────────────
const $ = id => document.getElementById(id);
function flash(id, msg, color) {
  const n = $(id); if (!n) return;
  n.style.color = color || "#1db954";
  n.textContent = msg;
}
function flashTemp(id, msg, color, ms = 3000) {
  flash(id, msg, color);
  setTimeout(() => { const n = $(id); if (n) n.textContent = ""; }, ms);
}

// ── Initialise page ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const hasSetup = !!(await sg(S_PUB));
  if (hasSetup) {
    $("loginSection").style.display = "";
    $("loginPin").focus();
  } else {
    $("setupSection").style.display = "";
    $("setupPin").focus();
  }

  // Setup
  $("setupBtn").addEventListener("click", doSetup);
  $("setupPin").addEventListener("keydown", e => { if (e.key === "Enter") $("setupPin2").focus(); });
  $("setupPin2").addEventListener("keydown", e => { if (e.key === "Enter") doSetup(); });

  // Login
  $("loginBtn").addEventListener("click", doLogin);
  $("loginPin").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

  // Admin panel buttons (wired after login in showAdminPanel)
});

// ── First-time setup ──────────────────────────────────────────
async function doSetup() {
  const pin  = $("setupPin").value;
  const pin2 = $("setupPin2").value;
  if (pin.length < 6)    { flash("gateMsg", "PIN must be at least 6 characters.", "#fa5400"); return; }
  if (pin !== pin2)      { flash("gateMsg", "PINs don't match.", "#fa5400"); return; }
  flash("gateMsg", "Generating RSA-2048 key pair…", "#888");
  $("setupBtn").disabled = true;
  try {
    await initKeyPair(pin);
    flashTemp("gateMsg", "Setup complete! Loading admin panel…", "#1db954");
    setTimeout(() => showAdminPanel(), 800);
  } catch (e) {
    flash("gateMsg", "Setup failed: " + e.message, "#e03131");
    $("setupBtn").disabled = false;
  }
}

async function initKeyPair(pin) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  _pubJwk  = await crypto.subtle.exportKey("jwk", kp.publicKey);
  _privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const enc     = await encryptPrivKey(_privJwk, pin);
  const pinHash = await hashPin(pin);
  await ss({
    [S_PUB]:     _pubJwk,
    [S_PRIV]:    enc,
    [S_PINHASH]: pinHash,
    [S_KEYS]:    [],
    [S_REVOKED]: [],
  });
}

// ── Login ─────────────────────────────────────────────────────
async function doLogin() {
  const pin = $("loginPin").value;
  if (!pin) { flash("gateMsg", "Enter your PIN.", "#fa5400"); return; }
  flash("gateMsg", "Verifying…", "#888");
  $("loginBtn").disabled = true;
  try {
    const stored = await sg(S_PINHASH);
    if (!stored) { flash("gateMsg", "No PIN set — run setup.", "#fa5400"); $("loginBtn").disabled = false; return; }
    const entered = await hashPin(pin);
    if (entered !== stored) {
      flash("gateMsg", "Incorrect PIN.", "#e03131");
      $("loginBtn").disabled = false;
      $("loginPin").value = "";
      $("loginPin").focus();
      return;
    }
    // Decrypt private key
    const enc = await sg(S_PRIV);
    _privJwk  = await decryptPrivKey(enc, pin);
    _pubJwk   = await sg(S_PUB);
    flashTemp("gateMsg", "Unlocked.", "#1db954");
    setTimeout(() => showAdminPanel(), 400);
  } catch (e) {
    flash("gateMsg", "Error: " + e.message, "#e03131");
    $("loginBtn").disabled = false;
  }
}

// ── Admin panel ───────────────────────────────────────────────
async function showAdminPanel() {
  $("pinGate").style.display      = "none";
  $("adminContent").style.display = "";

  // Load existing revocation URL
  const cfg = await getLicenseConfig();
  if (cfg.revocationUrl) $("revUrl").value = cfg.revocationUrl;

  renderKeyList();

  // Wire buttons
  $("genBtn").addEventListener("click", doGenerateKey);
  $("copyGenBtn").addEventListener("click", () => {
    navigator.clipboard.writeText($("genKeyOut").value)
      .then(() => flashTemp("genMsg", "Copied!", "#1db954"))
      .catch(() => {});
  });
  $("exportLicenseBtn").addEventListener("click", doExportLicense);
  $("dangerRegenBtn").addEventListener("click", () => { $("regenModal").style.display = "flex"; });
  $("regenCancelBtn").addEventListener("click", () => { $("regenModal").style.display = "none"; $("regenPin").value = ""; });
  $("regenConfirmBtn").addEventListener("click", doRegen);
  $("changePinBtn").addEventListener("click", doChangePin);
}

// ── Key generation ────────────────────────────────────────────
async function doGenerateKey() {
  const user   = $("genUser").value.trim();
  const expiry = $("genExpiry").value;
  const note   = $("genNote").value.trim();
  if (!user) { flashTemp("genMsg", "Enter a user/label.", "#fa5400"); return; }
  $("genBtn").disabled = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const exp = expiry ? Math.floor(new Date(expiry + "T23:59:59").getTime() / 1000) : 0;
    const id  = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2,18));
    const payload = { v: 1, id, user, exp, iat: now, tier: "full" };
    const ks  = await signLicenseKey(payload, _privJwk);

    // Persist metadata (never store keyString in admin — can regenerate if needed)
    const keys = (await sg(S_KEYS)) || [];
    keys.unshift({ id, user, exp, note, revoked: false, iat: now });
    await ss({ [S_KEYS]: keys });

    $("genKeyOut").value   = ks;
    $("genResult").style.display = "";
    flashTemp("genMsg", `Key for "${user}" generated.`, "#1db954");
    renderKeyList();
  } catch (e) {
    flashTemp("genMsg", "Error: " + e.message, "#e03131");
  } finally {
    $("genBtn").disabled = false;
  }
}

// ── Key list ──────────────────────────────────────────────────
async function renderKeyList() {
  const keys = (await sg(S_KEYS)) || [];
  const list = $("keyList");
  $("keyCountTag").textContent = `${keys.length} KEY${keys.length !== 1 ? "S" : ""}`;
  list.innerHTML = "";
  if (!keys.length) {
    list.innerHTML = '<p class="hint">No keys generated yet.</p>';
    return;
  }
  keys.forEach(k => list.appendChild(buildKeyRow(k)));
}

function buildKeyRow(k) {
  const tpl = document.getElementById("keyRowTpl").content.cloneNode(true);
  const row = tpl.querySelector(".key-row");
  const now = Math.floor(Date.now() / 1000);

  row.querySelector(".key-user").textContent = k.user || "(unlabelled)";

  const parts = [];
  if (k.note) parts.push(k.note);
  if (k.exp)  parts.push("Expires " + new Date(k.exp * 1000).toLocaleDateString());
  else        parts.push("Never expires");
  parts.push("Issued " + new Date(k.iat * 1000).toLocaleDateString());
  row.querySelector(".key-meta").textContent = parts.join("  ·  ");

  const badge = row.querySelector(".key-status-badge");
  const toggle = row.querySelector(".k-toggle");

  if (k.revoked) {
    badge.textContent = "REVOKED"; badge.style.color = "#e03131";
    toggle.textContent = "Reinstate"; toggle.className = "btn btn-mini btn-dark";
    toggle.addEventListener("click", () => setRevoked(k.id, false));
  } else if (k.exp && now > k.exp) {
    badge.textContent = "EXPIRED"; badge.style.color = "#666";
    toggle.textContent = "Revoke"; toggle.className = "btn btn-mini btn-danger";
    toggle.addEventListener("click", () => setRevoked(k.id, true));
  } else {
    badge.textContent = "ACTIVE"; badge.style.color = "#1db954";
    toggle.textContent = "Revoke"; toggle.className = "btn btn-mini btn-danger";
    toggle.addEventListener("click", () => setRevoked(k.id, true));
  }

  row.querySelector(".k-copy").addEventListener("click", async () => {
    // Re-sign so we have the key string even if admin dismissed the result panel
    try {
      const ks = await signLicenseKey(
        { v: 1, id: k.id, user: k.user, exp: k.exp, iat: k.iat, tier: "full" }, _privJwk);
      await navigator.clipboard.writeText(ks);
      flashTemp("distMsg", `Copied key for "${k.user}".`, "#1db954");
    } catch (e) { flashTemp("distMsg", "Copy failed: " + e.message, "#e03131"); }
  });

  return row;
}

async function setRevoked(id, revoked) {
  const keys = (await sg(S_KEYS)) || [];
  const k = keys.find(x => x.id === id);
  if (k) k.revoked = revoked;
  const revokedIds = keys.filter(x => x.revoked).map(x => x.id);
  await ss({ [S_KEYS]: keys, [S_REVOKED]: revokedIds });
  renderKeyList();
  flashTemp("distMsg", revoked ? "Key revoked." : "Key reinstated.", "#1db954");
}

// ── Export license.json ───────────────────────────────────────
async function doExportLicense() {
  const revokedIds = ((await sg(S_KEYS)) || []).filter(k => k.revoked).map(k => k.id);
  const revUrl     = $("revUrl").value.trim();
  const cfg = { v: 1, pubKey: _pubJwk, revokedIds, revocationUrl: revUrl };
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "license.json"; a.click();
  URL.revokeObjectURL(url);
  flashTemp("distMsg", "Downloaded license.json — replace the copy in your extension folder and reload.", "#1db954", 6000);
}

// ── Regenerate key pair ───────────────────────────────────────
async function doRegen() {
  const pin = $("regenPin").value;
  if (!pin) { flash("regenMsg", "Enter current PIN.", "#fa5400"); return; }
  const stored  = await sg(S_PINHASH);
  const entered = await hashPin(pin);
  if (entered !== stored) { flash("regenMsg", "Incorrect PIN.", "#e03131"); return; }
  flash("regenMsg", "Regenerating…", "#888");
  $("regenConfirmBtn").disabled = true;
  try {
    // Preserve existing key metadata but mark all as invalidated
    const oldKeys = ((await sg(S_KEYS)) || []).map(k => ({ ...k, revoked: true }));
    await initKeyPair(pin);
    // Re-store old key metadata (revoked) so history is visible
    const newKeys = (await sg(S_KEYS)) || [];
    await ss({ [S_KEYS]: [...newKeys, ...oldKeys] });
    $("regenModal").style.display = "none";
    $("regenPin").value = "";
    flashTemp("distMsg", "New key pair generated. Download and redistribute license.json.", "#f0c070", 6000);
    renderKeyList();
  } catch (e) {
    flash("regenMsg", "Error: " + e.message, "#e03131");
  } finally {
    $("regenConfirmBtn").disabled = false;
  }
}

// ── Change PIN ────────────────────────────────────────────────
async function doChangePin() {
  const np  = $("newPin").value;
  const np2 = $("newPin2").value;
  if (np.length < 6)  { flashTemp("pinMsg", "PIN must be at least 6 characters.", "#fa5400"); return; }
  if (np !== np2)     { flashTemp("pinMsg", "PINs don't match.", "#fa5400"); return; }
  try {
    const enc     = await encryptPrivKey(_privJwk, np);
    const pinHash = await hashPin(np);
    await ss({ [S_PRIV]: enc, [S_PINHASH]: pinHash });
    $("newPin").value = $("newPin2").value = "";
    flashTemp("pinMsg", "PIN changed.", "#1db954");
  } catch (e) {
    flashTemp("pinMsg", "Error: " + e.message, "#e03131");
  }
}
