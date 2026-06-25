// ============================================================
// SNKRS Bot – License validation utilities
// Shared between admin.js (signing) and dashboard.js (verifying).
// Uses the Web Crypto API (RSA-PSS / SHA-256, 2048-bit keys).
// ============================================================
//
// Key format:
//   SNKRS-{base64url(payloadJSON)}.{base64url(RSA-PSS signature)}
//
// Payload shape:
//   { v:1, id:"uuid", user:"name", exp:unix_sec, iat:unix_sec, tier:"full" }
//
// exp == 0  →  never expires
// ============================================================

const _PSS_SALT = 32;

// ── Base64url helpers ─────────────────────────────────────────
function _b64u(ab) {
  return btoa(String.fromCharCode(...new Uint8Array(ab)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function _fromb64u(s) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

// ── Key import helpers ────────────────────────────────────────
function _importPub(jwk) {
  return crypto.subtle.importKey("jwk", jwk,
    { name: "RSA-PSS", hash: "SHA-256" }, false, ["verify"]);
}
function _importPriv(jwk) {
  return crypto.subtle.importKey("jwk", jwk,
    { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
}

// ── Core parse/sign/verify ────────────────────────────────────

function parseLicenseKey(ks) {
  if (typeof ks !== "string" || !ks.startsWith("SNKRS-")) return null;
  const body = ks.slice(6);
  const dot  = body.lastIndexOf(".");
  if (dot < 1) return null;
  try {
    const b64pay  = body.slice(0, dot);
    const b64sig  = body.slice(dot + 1);
    const payload = JSON.parse(atob(b64pay.replace(/-/g, "+").replace(/_/g, "/")));
    const sigBytes = _fromb64u(b64sig);
    return { payload, b64pay, sigBytes };
  } catch { return null; }
}

// Returns { ok, payload, err }
async function verifyLicenseKey(ks, pubJwk, revokedIds = []) {
  const parsed = parseLicenseKey(ks);
  if (!parsed) return { ok: false, err: "Invalid key format." };
  const { payload, b64pay, sigBytes } = parsed;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return { ok: false, payload, err: "Key expired." };
  if ((revokedIds || []).includes(payload.id)) return { ok: false, payload, err: "Key revoked." };
  try {
    const pub  = await _importPub(pubJwk);
    const data = new TextEncoder().encode(b64pay);
    const ok   = await crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: _PSS_SALT }, pub, sigBytes, data);
    return ok ? { ok: true, payload } : { ok: false, payload, err: "Invalid signature." };
  } catch (e) {
    return { ok: false, err: "Verification error: " + (e.message || e) };
  }
}

// Returns the formatted SNKRS-... key string
async function signLicenseKey(payload, privJwk) {
  const b64pay = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const data   = new TextEncoder().encode(b64pay);
  const priv   = await _importPriv(privJwk);
  const sigBuf = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: _PSS_SALT }, priv, data);
  return "SNKRS-" + b64pay + "." + _b64u(sigBuf);
}

// ── Fetch license.json from extension bundle ──────────────────
async function getLicenseConfig() {
  try {
    const r = await fetch(chrome.runtime.getURL("license.json"));
    return await r.json();
  } catch {
    return { v: 1, pubKey: null, revokedIds: [], revocationUrl: "" };
  }
}

// ── Admin PIN / private-key encryption (AES-GCM + PBKDF2) ────
function _hexOf(arr) { return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(""); }
function _fromHex(h) { return Uint8Array.from(h.match(/../g), x => parseInt(x, 16)); }

async function _pinToAES(pin, saltHex) {
  const mat = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: _fromHex(saltHex), iterations: 250000, hash: "SHA-256" },
    mat, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptPrivKey(privJwk, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const k    = await _pinToAES(pin, _hexOf(salt));
  const ct   = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(privJwk)));
  return { s: _hexOf(salt), i: _hexOf(iv), c: _hexOf(new Uint8Array(ct)) };
}

async function decryptPrivKey(enc, pin) {
  const k  = await _pinToAES(pin, enc.s);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: _fromHex(enc.i) }, k, _fromHex(enc.c));
  return JSON.parse(new TextDecoder().decode(pt));
}

async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin + ":snkrs"));
  return _hexOf(new Uint8Array(buf));
}
