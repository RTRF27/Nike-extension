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
    let digits = s.replace(/\D/g, "");
    if (!digits) return "";

    // Strip a leading country code. Malaysia's "60" is decisive on its own;
    // Singapore's "65" we peel off and judge the 8-digit local below.
    if (digits.startsWith("60") && digits.length >= 10) return "MY";
    if (digits.startsWith("65") && digits.length >= 10) digits = digits.slice(2);

    // Malaysian local: leading 0, 9–11 digits (01X-XXXXXXX mobile, 0X-XXXXXXX).
    if (digits.length >= 9 && digits.startsWith("0")) return "MY";

    // Malaysian mobile stored without the leading 0 (e.g. 1121099805). SG numbers
    // never start with 1, so this is unambiguous.
    if (digits.length >= 9 && digits.length <= 12 && digits.startsWith("1")) return "MY";

    // Singapore mobile: starts with 8 or 9. Accept exactly 8 digits, OR a
    // slightly longer capture (the settings-page reader sometimes bleeds a
    // couple of trailing digits from the next field, e.g. "9656 1552 28") — the
    // first 8 digits are the real number, and no MY number starts 8/9, so this
    // stays unambiguous.
    if (/^[89]/.test(digits) && digits.length >= 8 && digits.length <= 11) return "SG";

    return "";
  }

  // A short human label for a classified region (falls back to the raw code).
  function regionLabel(code) {
    return code === "SG" ? "Singapore" : code === "MY" ? "Malaysia" : "Unknown";
  }

  // Tidy a raw captured phone for DISPLAY: drop trailing digits the reader bled
  // from the next field so the shown number matches how it classified.
  //   "9656 1552 28" → "9656 1552" (SG, 8 digits)
  //   "011-2109 9805 28" → "01121099805" (MY local kept whole)
  function displayPhone(raw) {
    if (!raw) return "";
    let digits = String(raw).replace(/\D/g, "");
    if (!digits) return String(raw).trim();
    let cc = "";
    if (digits.startsWith("65") && digits.length >= 10) { cc = "+65 "; digits = digits.slice(2); }
    else if (digits.startsWith("60") && digits.length >= 10) { cc = "+60 "; digits = digits.slice(2); }
    // SG mobile: keep the first 8 digits (8/9 start) — the rest is bleed.
    if (/^[89]/.test(digits) && digits.length > 8) digits = digits.slice(0, 8);
    return cc + digits;
  }

  return { classifyRegionFromPhone, regionLabel, displayPhone };
});
