// ============================================================
// Region classifier — SG vs MY from a phone number
// ============================================================
// Nike runs SNKRS SG and SNKRS MY as separate storefronts, and which one an
// account should enter is best told by its phone number:
//   • Singapore  — 8 digits starting with 8 or 9 (local), or +65 / 65 prefixed.
//   • Malaysia   — local numbers start with 0 and run 9–11 digits (e.g.
//                  011-2109 9805 → 01121099805), or +60 / 60 prefixed.
// Pure + side-effect free so it can be unit tested and shared between the
// background service worker (importScripts) and Node tests (require).

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node/tests
  root.RegionUtil = api;                                                     // SW / window
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Returns "SG", "MY", or "" (unknown) for a raw phone string in any common
  // format (spaces, dashes, parens, leading +, country code, or bare local).
  function classifyRegionFromPhone(raw) {
    if (raw == null) return "";
    const s = String(raw).trim();
    if (!s) return "";
    const hasPlus = s[0] === "+";
    const digits = s.replace(/\D/g, "");
    if (!digits) return "";

    // Explicit country code (with a leading + or a longer-than-local string).
    if (hasPlus || digits.length > 8) {
      if (digits.startsWith("65")) {
        const local = digits.slice(2);
        if (local.length === 8 && /^[89]/.test(local)) return "SG";
      }
      if (digits.startsWith("60")) return "MY"; // Malaysian country code
    }

    // Malaysian local: leading 0, 9–11 digits (01X-XXXXXXX mobile, 0X-XXXXXXX).
    if (digits.length >= 9 && digits.startsWith("0")) return "MY";

    // Singapore local: exactly 8 digits, starting 8 or 9.
    if (digits.length === 8 && /^[89]/.test(digits)) return "SG";

    // Malaysian mobile stored without the leading 0 (e.g. 1121099805).
    if (digits.length >= 9 && digits.startsWith("1")) return "MY";

    return "";
  }

  // A short human label for a classified region (falls back to the raw code).
  function regionLabel(code) {
    return code === "SG" ? "Singapore" : code === "MY" ? "Malaysia" : "Unknown";
  }

  return { classifyRegionFromPhone, regionLabel };
});
