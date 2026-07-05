// ============================================================
// CRX3 packer — pure Node, zero dependencies.
// ============================================================
// Chrome's .crx v3 format is:
//
//   "Cr24" | uint32LE version=3 | uint32LE headerLen | header | zip
//
// where `header` is a protobuf CrxFileHeader:
//
//   message CrxFileHeader {
//     repeated AsymmetricKeyProof sha256_with_rsa = 2;   // {public_key, signature}
//     bytes signed_header_data = 10000;                  // serialized SignedData
//   }
//   message SignedData { bytes crx_id = 1; }             // 16 bytes
//
// crx_id = first 16 bytes of SHA-256(publicKey DER) — the same bytes the
// extension ID is derived from, so signing with the SAME key keeps the
// same extension ID across every machine and profile.
//
// The RSA signature (PKCS#1 v1.5, SHA-256) covers:
//   "CRX3 SignedData\x00" + uint32LE(len(signedHeaderData)) +
//   signedHeaderData + zipBytes
//
// The zip is written by the minimal writer below (real DEFLATE via zlib),
// so no external `zip` binary is needed on Windows.
// ============================================================

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── CRC32 (needed for zip entries) ────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Minimal zip writer (DEFLATE, no encryption, no zip64) ─────
// entries: [{ name: "path/in/zip", data: Buffer }]
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Fixed DOS timestamp so packing is deterministic (contents decide the hash).
  const dosTime = 0, dosDate = (1 << 5) | 1; // 1980-01-01 00:00

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Method 8 (deflate) unless stored is smaller (tiny/incompressible files).
    const useStore = deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const method = useStore ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0x0800, 6);     // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra len
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);      // flags: UTF-8 names
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs = 0
    central.writeUInt32LE(offset, 42);     // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ── Tiny protobuf writers (only what CrxFileHeader needs) ─────
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

// length-delimited field (wire type 2)
function pbBytes(fieldNo, buf) {
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(buf.length), buf]);
}

// ── Key / ID helpers ──────────────────────────────────────────
function publicKeyDer(privateKeyPem) {
  const pub = crypto.createPublicKey(privateKeyPem);
  return pub.export({ type: "spki", format: "der" });
}

// Extension ID: sha256(pubkey DER)[0..15], hex digits mapped 0-f → a-p.
function extensionIdFromPublicKey(pubDer) {
  const hash = crypto.createHash("sha256").update(pubDer).digest();
  return hash.slice(0, 16).toString("hex")
    .split("")
    .map(c => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

// ── The packer ────────────────────────────────────────────────
// entries: same shape buildZip takes. Returns { crx: Buffer, id: string }.
function packCrx3(entries, privateKeyPem) {
  const zip = buildZip(entries);
  const pubDer = publicKeyDer(privateKeyPem);
  const crxId = crypto.createHash("sha256").update(pubDer).digest().slice(0, 16);

  const signedHeaderData = pbBytes(1, crxId); // SignedData { crx_id = 1 }

  // Signature covers: "CRX3 SignedData\0" + LE32(len) + signedHeaderData + zip
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const signer = crypto.createSign("sha256");
  signer.update(Buffer.from("CRX3 SignedData\x00", "binary"));
  signer.update(lenBuf);
  signer.update(signedHeaderData);
  signer.update(zip);
  const signature = signer.sign(privateKeyPem);

  const proof = Buffer.concat([pbBytes(1, pubDer), pbBytes(2, signature)]);
  const header = Buffer.concat([
    pbBytes(2, proof),              // sha256_with_rsa = 2
    pbBytes(10000, signedHeaderData), // signed_header_data = 10000
  ]);

  const front = Buffer.alloc(12);
  front.write("Cr24", 0, "binary");
  front.writeUInt32LE(3, 4);
  front.writeUInt32LE(header.length, 8);

  return {
    crx: Buffer.concat([front, header, zip]),
    id: extensionIdFromPublicKey(pubDer),
    zipBytes: zip.length,
  };
}

// ── Verify a packed crx (self-check used by pack.js/tests) ────
// Parses the header back out and verifies the RSA proof + crx_id.
function verifyCrx3(crxBuf) {
  if (crxBuf.slice(0, 4).toString("binary") !== "Cr24") throw new Error("bad magic");
  if (crxBuf.readUInt32LE(4) !== 3) throw new Error("not crx3");
  const headerLen = crxBuf.readUInt32LE(8);
  const header = crxBuf.slice(12, 12 + headerLen);
  const zip = crxBuf.slice(12 + headerLen);

  // Minimal protobuf reader over CrxFileHeader.
  let pos = 0, pubDer = null, signature = null, signedHeaderData = null;
  const readVarint = (buf) => {
    let shift = 0, val = 0;
    for (;;) {
      const b = buf[pos++];
      val |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return val >>> 0;
      shift += 7;
    }
  };
  while (pos < header.length) {
    const key = readVarint(header);
    const fieldNo = key >>> 3, wire = key & 7;
    if (wire !== 2) throw new Error("unexpected wire type " + wire);
    const len = readVarint(header);
    const val = header.slice(pos, pos + len);
    pos += len;
    if (fieldNo === 2) {
      // AsymmetricKeyProof
      let p = 0;
      while (p < val.length) {
        const k2 = val[p++];
        let l2 = 0, s2 = 0;
        for (;;) { const b = val[p++]; l2 |= (b & 0x7f) << s2; if (!(b & 0x80)) break; s2 += 7; }
        const v2 = val.slice(p, p + l2); p += l2;
        if ((k2 >>> 3) === 1) pubDer = v2;
        if ((k2 >>> 3) === 2) signature = v2;
      }
    } else if (fieldNo === 10000) {
      signedHeaderData = val;
    }
  }
  if (!pubDer || !signature || !signedHeaderData) throw new Error("header incomplete");

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const verifier = crypto.createVerify("sha256");
  verifier.update(Buffer.from("CRX3 SignedData\x00", "binary"));
  verifier.update(lenBuf);
  verifier.update(signedHeaderData);
  verifier.update(zip);
  const pubKey = crypto.createPublicKey({ key: pubDer, format: "der", type: "spki" });
  if (!verifier.verify(pubKey, signature)) throw new Error("signature verify FAILED");

  // crx_id must equal sha256(pubDer)[0..15]
  const expectId = crypto.createHash("sha256").update(pubDer).digest().slice(0, 16);
  const gotId = signedHeaderData.slice(2, 18); // field 1, len 16 → tag(1)+len(1)+bytes
  if (!expectId.equals(gotId)) throw new Error("crx_id mismatch");

  return { id: extensionIdFromPublicKey(pubDer), zipBytes: zip.length };
}

// Collect files under `root` into zip entries, skipping `excludes`
// (names matched against the path relative to root, top-level segment).
function collectEntries(root, excludes) {
  const skip = new Set(excludes);
  const entries = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const relPath = rel ? rel + "/" + name : name;
      if (skip.has(name) || skip.has(relPath)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, relPath);
      else entries.push({ name: relPath, data: fs.readFileSync(full) });
    }
  })(root, "");
  return entries;
}

module.exports = { packCrx3, verifyCrx3, buildZip, collectEntries, publicKeyDer, extensionIdFromPublicKey };
