// ============================================================
// Nike SNKRS Bot – Checkout Core (pure, testable)
// ============================================================
// The checkout DOM logic + an explicit state machine, with ZERO chrome.*
// dependencies. This is what makes the flow:
//   • unit-testable offline against saved fixture HTML (test-harness/), and
//   • reasoned-about as explicit states instead of one long patched script.
//
// The DOM detection functions are ported VERBATIM from the flow that was
// tuned across many live drops — same selectors, same visibility/DOM-order
// logic, same minimized-window handling. Only the control flow around them
// is reorganised into a state machine.
//
// Loads two ways:
//   • as a content script → attaches `window.CheckoutCore`
//   • as a Node/Playwright module → `module.exports`
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CheckoutCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  // ── Minimized-window helpers ────────────────────────────────
  // Chrome sets offsetParent=null for ALL elements in a minimized window (no
  // layout pass occurs off-screen) and getBoundingClientRect() returns zeros.
  // These helpers work regardless of window state.
  function isWindowMinimized(doc) {
    doc = doc || document;
    return !!(doc.body && doc.body.getBoundingClientRect().width === 0);
  }

  // CSS-computed visibility — works when minimized (unlike offsetParent).
  function isLogicallyVisible(el) {
    if (!el) return false;
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const s = view.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0;
  }

  // Element that anchors the top of the payment card form. Used for
  // above/below ordering via compareDocumentPosition (reliable when minimized).
  function findPaymentFormEl(doc) {
    doc = doc || document;
    const iframe = doc.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
    if (iframe && isLogicallyVisible(iframe)) return iframe;

    const cardInput = Array.from(doc.querySelectorAll("input")).find(inp => {
      const hay = [inp.name, inp.id, inp.placeholder, inp.getAttribute("aria-label"), inp.autocomplete]
        .join(" ").toLowerCase();
      return /card\s*number|cardnumber|cc-number|ccnumber|creditcard/.test(hay);
    });
    if (cardInput && isLogicallyVisible(cardInput)) return cardInput;

    const cardLabel = Array.from(doc.querySelectorAll("label, span, div, p")).find(el => {
      const t = (el.textContent || "").trim().toLowerCase();
      return t === "card number" || t === "card number *" || t.startsWith("card number");
    });
    if (cardLabel && isLogicallyVisible(cardLabel)) return cardLabel;

    return null;
  }

  // Sort elements by DOM order (earlier in document = lower index).
  function sortByDomOrder(els) {
    return els.slice().sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
  }

  function findDeliveryContinueButton(doc) {
    doc = doc || document;
    const all = Array.from(doc.querySelectorAll("button.button-continue")).filter(b => !b.disabled);
    return all.length > 0 ? all[0] : null;
  }

  // Strict delivery CONTINUE finder. Nike GS can show a PAYMENT-section
  // CONTINUE and a SUBMIT ORDER button at the same time; this makes sure we
  // only click the DELIVERY continue.
  function findDeliveryContinueOnly(doc, dbg) {
    doc = doc || document;
    dbg = dbg || function () {};
    const visibleContinues = Array.from(doc.querySelectorAll("button.button-continue"))
      .filter(b => !b.disabled && isLogicallyVisible(b));

    if (!visibleContinues.length) {
      dbg(`findDeliveryContinueOnly: no non-disabled visible CONTINUEs (minimized=${isWindowMinimized(doc)})`);
      return null;
    }

    const formEl = findPaymentFormEl(doc);
    if (formEl != null) {
      const aboveForm = visibleContinues.filter(b =>
        !!(formEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)
      );
      if (!aboveForm.length) {
        dbg(`findDeliveryContinueOnly: all CONTINUEs are after the payment form — none are delivery`);
        return null;
      }
      const sorted = sortByDomOrder(aboveForm);
      dbg(`findDeliveryContinueOnly: found delivery CONTINUE (above payment form)`);
      return sorted[0];
    }

    const sorted = sortByDomOrder(visibleContinues);
    dbg(`findDeliveryContinueOnly: found delivery CONTINUE (no payment form yet)`);
    return sorted[0];
  }

  // The PAYMENT accordion row — element whose OWN text is exactly "PAYMENT".
  function findPaymentAccordionRow(doc) {
    doc = doc || document;
    const allEls = doc.querySelectorAll(
      "div, section, li, button, [class*='accordion'], [class*='category'], [class*='panel'], [class*='header']"
    );
    for (const el of allEls) {
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(" ")
        .trim()
        .toUpperCase();
      if (ownText === "PAYMENT") return el;
      const innerText = (el.innerText || "").trim().toUpperCase();
      if (innerText === "PAYMENT" || innerText === "PAYMENT +") return el;
    }
    const allBtns = doc.querySelectorAll("button, [role='button']");
    for (const btn of allBtns) {
      const text = (btn.innerText || btn.textContent || "").trim();
      if (text === "+") {
        const parent = btn.parentElement;
        if (parent && (parent.innerText || "").toUpperCase().includes("PAYMENT")) return parent;
      }
    }
    return null;
  }

  function findPaymentIframe(doc) {
    doc = doc || document;
    return doc.querySelector("iframe.newCard, iframe[src*='gs-payments']");
  }

  // Strict payment-section CONTINUE finder — the CONTINUE that comes AFTER the
  // card form in the DOM (compareDocumentPosition, minimized-safe).
  function findPaymentContinueOnly(doc, dbg) {
    doc = doc || document;
    dbg = dbg || function () {};
    const visibleContinues = Array.from(doc.querySelectorAll("button.button-continue"))
      .filter(b => !b.disabled && isLogicallyVisible(b));

    if (!visibleContinues.length) {
      dbg(`findPaymentContinueOnly: no enabled visible CONTINUEs (minimized=${isWindowMinimized(doc)})`);
      return null;
    }

    const formEl = findPaymentFormEl(doc);
    if (formEl == null) {
      if (visibleContinues.length === 1) {
        dbg(`findPaymentContinueOnly: single CONTINUE, no payment form yet — treating as payment`);
        return visibleContinues[0];
      }
      dbg(`findPaymentContinueOnly: ${visibleContinues.length} CONTINUEs but no card form — ambiguous`);
      return null;
    }

    const afterForm = visibleContinues.filter(b =>
      !!(formEl.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
    if (!afterForm.length) {
      dbg(`findPaymentContinueOnly: all CONTINUEs are before the card form — none are payment`);
      return null;
    }
    const sorted = sortByDomOrder(afterForm);
    dbg(`findPaymentContinueOnly: found payment CONTINUE (after card form in DOM)`);
    return sorted[sorted.length - 1];
  }

  // SUBMIT ORDER — confirmed class button-submit, text fallback.
  function findSubmitOrderButton(doc) {
    doc = doc || document;
    const byClass = doc.querySelector("button.button-submit");
    if (byClass && !byClass.disabled) return byClass;
    return Array.from(doc.querySelectorAll("button")).find(b => {
      if (b.disabled) return false;
      return (b.textContent || "").trim().toUpperCase() === "SUBMIT ORDER";
    }) || null;
  }

  // Is PAYMENT already complete (a saved card is on file)? If so we must NOT
  // wait for a card-fill that will never happen, nor re-open the accordion.
  function isPaymentAlreadyComplete(doc, dbg) {
    doc = doc || document;
    dbg = dbg || function () {};
    const iframeEl = doc.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
    const iframeOpen = !!(iframeEl && isLogicallyVisible(iframeEl));
    if (iframeOpen) {
      dbg(`isPaymentAlreadyComplete: card iframe is open — not complete yet`);
      return false;
    }
    const bodyText = (doc.body.innerText || "");
    const hasCardBrand = /\b(VISA|MASTERCARD|MASTER CARD|AMEX|AMERICAN EXPRESS)\b/i.test(bodyText);
    const hasLast4Near = /\b(VISA|MASTERCARD|AMEX)\b[\s\S]{0,40}?\d{3,4}\b/i.test(bodyText)
                      || /PAYMENT[\s\S]{0,60}?\d{4}\b/i.test(bodyText.toUpperCase());
    const submitReady = !!findSubmitOrderButton(doc);
    if (hasLast4Near || (hasCardBrand && submitReady)) return true;
    return false;
  }

  // Do INLINE card fields (native inputs, no iframe) already hold a number?
  function isInlineCardFilled(doc) {
    doc = doc || document;
    const inputs = Array.from(doc.querySelectorAll("input"));
    const cardInput = inputs.find(inp => {
      const hay = [inp.name, inp.id, inp.placeholder, inp.getAttribute("aria-label"), inp.autocomplete]
        .join(" ").toLowerCase();
      return /card\s*number|cardnumber|cc-number|ccnumber|creditcard/.test(hay);
    });
    if (!cardInput) return false;
    const digits = (cardInput.value || "").replace(/\D/g, "");
    return digits.length >= 12;
  }

  // A visible, still-empty security-code / CVV input on the MAIN page — the
  // saved-card case where Nike shows the card already on file but still wants
  // the CVV typed before CONTINUE (see the "Security code *" field).
  function findSecurityCodeInput(doc) {
    doc = doc || document;
    const inputs = Array.from(doc.querySelectorAll("input"));
    return inputs.find((inp) => {
      const hay = [inp.name, inp.id, inp.placeholder, inp.getAttribute("aria-label"), inp.autocomplete]
        .join(" ").toLowerCase();
      const isCvv = inp.autocomplete === "cc-csc" ||
        /security\s*code|\bcvv\b|\bcvc\b|\bcid\b|card\s*verification|verification\s*(code|value)/.test(hay);
      if (!isCvv) return false;
      if (!isLogicallyVisible(inp)) return false;
      const v = (inp.value || "").replace(/\D/g, "");
      return v.length < 3; // empty or incomplete
    }) || null;
  }

  // Type a value into a native (possibly React-controlled) input: use the
  // prototype value setter so React's onChange sees it, then fire the events.
  function fillNativeInput(input, value, dbg) {
    dbg = dbg || function () {};
    if (!input) return false;
    const view = (input.ownerDocument && input.ownerDocument.defaultView) || window;
    try { input.focus(); } catch (e) {}
    try {
      const proto = view.HTMLInputElement && view.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(input, value); else input.value = value;
    } catch (e) { try { input.value = value; } catch (_) {} }
    for (const type of ["input", "change"]) {
      try { input.dispatchEvent(new view.Event(type, { bubbles: true })); } catch (e) {}
    }
    try { input.dispatchEvent(new view.KeyboardEvent("keyup", { bubbles: true })); } catch (e) {}
    try { input.blur(); } catch (e) {}
    dbg(`fillNativeInput: set CVV (${String(value).length} digits)`);
    return true;
  }

  // Has the page reached a confirmation / processing state?
  function isConfirmed(doc) {
    doc = doc || document;
    const loc = (doc.defaultView && doc.defaultView.location) || location;
    if (!loc.hostname.includes("gs.nike.com")) return true;
    const t = (doc.body.innerText || "").toUpperCase();
    return /PROCESSING|JUST A MINUTE|ORDER CONFIRMED|THANK YOU|YOU'RE IN|ENTRY CONFIRMED/.test(t);
  }

  // Structured snapshot of the page (replaces the ad-hoc dumpPageState). Pure —
  // returns an object the caller can log/format/assert.
  function snapshotPageState(doc) {
    doc = doc || document;
    const continues = doc.querySelectorAll("button.button-continue").length;
    const submits = doc.querySelectorAll("button.button-submit").length;
    const iframeEl = doc.querySelector("iframe.newCard[src*='gs-payments'], iframe[src*='gs-payments']");
    const iframeOpen = iframeEl ? isLogicallyVisible(iframeEl) : false;
    return {
      minimized: isWindowMinimized(doc),
      continues, submits, iframeOpen,
      deliveryContinue: !!findDeliveryContinueOnly(doc),
      paymentForm: !!findPaymentFormEl(doc),
      paymentContinue: !!findPaymentContinueOnly(doc),
      submitBtn: !!findSubmitOrderButton(doc),
      paymentDone: isPaymentAlreadyComplete(doc),
      inlineCard: isInlineCardFilled(doc),
      confirmed: isConfirmed(doc),
    };
  }

  function formatSnapshot(tag, s) {
    const finders = [
      `deliveryCont=${s.deliveryContinue}`, `paymentForm=${s.paymentForm}`,
      `paymentCont=${s.paymentContinue}`, `submitBtn=${s.submitBtn}`,
      `paymentDone=${s.paymentDone}`, `inlineCard=${s.inlineCard}`,
    ].join(" | ");
    return `🔬${tag} PAGE STATE — minimized=${s.minimized} | ` +
      `continues=${s.continues} submits=${s.submits} iframeOpen=${s.iframeOpen}\nFinders: ${finders}`;
  }

  // ── Native click ──────────────────────────────────────────────
  // Nike's checkout buttons are Angular components that often ignore a bare
  // el.click(). Dispatch the full pointer/mouse sequence, then fall back.
  async function nativeClick(el, label, fast, dbg) {
    dbg = dbg || function () {};
    if (!el) { dbg(`nativeClick: null for "${label}"`); return; }
    el.scrollIntoView({ behavior: fast ? "auto" : "smooth", block: "center" });
    if (!fast) await wait(randInt(150, 300));

    const r = el.getBoundingClientRect();
    const minimized = (r.width === 0 && r.height === 0) || isWindowMinimized(el.ownerDocument);
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const cx = minimized ? 0 : r.left + r.width / 2;
    const cy = minimized ? 0 : r.top + r.height / 2;
    const opt = { bubbles: true, cancelable: true, composed: true, view, clientX: cx, clientY: cy };

    try { el.focus(); } catch (e) {}
    for (const type of ["pointerover", "mouseover", "pointerenter",
                        "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try { el.dispatchEvent(new view.MouseEvent(type, opt)); } catch (e) {}
      await wait(randInt(4, 12));
    }
    try { el.click(); } catch (e) {}
    dbg(`nativeClick: "${label}" (sequence${minimized ? ", minimized" : ""})`);
  }

  async function waitFor(fn, timeoutMs, intervalMs) {
    timeoutMs = timeoutMs || 15000; intervalMs = intervalMs || 100;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = fn();
      if (r) return r;
      await wait(intervalMs);
    }
    return null;
  }

  // ── The explicit state machine ────────────────────────────────
  const STATES = {
    LOADING:    "LOADING",
    DELIVERY:   "DELIVERY",
    PAYMENT:    "PAYMENT",
    READY:      "READY",
    HOLDING:    "HOLDING",
    SUBMITTING: "SUBMITTING",
    DONE:       "DONE",
    ERROR:      "ERROR",
  };

  // deps (all optional except where noted):
  //   doc            → document to drive (defaults to global document)
  //   log(msg)       → "Discord"/background log; PRESERVE existing phrasings so
  //                    the live-status classifier keeps working
  //   dbg(msg)       → local console.log
  //   emit(evt)      → analytics: { code, t, extra } — code in
  //                    started|loaded|delivery|payment|filled|ready|holding|
  //                    submitting|submitted|done|error
  //   tag()          → profile tag string for logs
  //   getCardFill()  → Promise<boolean> armed BEFORE run() (never miss signal)
  //   cancelCardFill()
  //   isTestMode()   → bool (stop before clicking SUBMIT)
  //   getDropAt()    → Promise<number> epoch ms to hold SUBMIT until (0 = now)
  class CheckoutMachine {
    constructor(deps) {
      this.d = deps || {};
      this.doc = this.d.doc || document;
      this.state = STATES.LOADING;
      this.startTs = Date.now();
      this.stateTs = Date.now();
      this.dropAt = 0;
      // LEO / speed mode (FCFS drops): strip the fixed settling waits and submit
      // with millisecond precision at the drop time. Default OFF → the raffle
      // path below is completely unchanged.
      this.leo = !!(this.d.isLeoMode && this.d.isLeoMode());
      // DAN raffle: max random human delay (ms) added before SUBMIT. 0 = off.
      this.jitterMs = this.leo ? 0 : Math.max(0, (this.d.getSubmitJitterMs && this.d.getSubmitJitterMs()) || 0);
    }
    // A wait that collapses to a short one in LEO mode (fast) but keeps the
    // original duration for the normal raffle flow.
    _w(normalMs, leoMs) { return wait(this.leo ? leoMs : normalMs); }
    _log(msg) { if (this.d.log) try { this.d.log(msg); } catch (e) {} }
    _dbg(msg) { if (this.d.dbg) try { this.d.dbg(msg); } catch (e) {} }
    _tag() { return (this.d.tag && this.d.tag()) || ""; }
    _emit(code, extra) {
      if (!this.d.emit) return;
      try { this.d.emit({ code, t: Date.now(), dropAt: this.dropAt || 0, extra: extra || null }); } catch (e) {}
    }
    // PANIC / abort: the dashboard can raise a shared abort flag to stop every
    // held SUBMIT at once (e.g. wrong product detected). checkAbort() is
    // supplied by the adapter (throttled) and may be sync or async.
    async _aborted() {
      if (!this.d.checkAbort) return false;
      try { return !!(await this.d.checkAbort()); } catch (e) { return false; }
    }
    _abort() {
      this._to(STATES.ERROR);
      this._emit("error", { reason: "panic_abort" });
      return { state: this.state, submitted: false, aborted: true };
    }
    _to(state) {
      const prev = this.state;
      this.state = state;
      const now = Date.now();
      this._dbg(`[FSM] ${prev} → ${state} (+${now - this.stateTs}ms, total ${now - this.startTs}ms)`);
      this.stateTs = now;
    }

    finder(name) {
      const doc = this.doc, dbg = (m) => this._dbg(m);
      switch (name) {
        case "deliveryContinue": return findDeliveryContinueOnly(doc, dbg);
        case "paymentContinue":  return findPaymentContinueOnly(doc, dbg);
        case "paymentAccordion": return findPaymentAccordionRow(doc);
        case "paymentIframe":    return findPaymentIframe(doc);
        case "submit":           return findSubmitOrderButton(doc);
        case "paymentFormEl":    return findPaymentFormEl(doc);
      }
      return null;
    }
    snapshot() { return snapshotPageState(this.doc); }

    // Saved-card checkout variant: the card is already on file but Nike wants
    // the CVV / security code typed before CONTINUE. Fill it from the account's
    // stored CVV. No-op when there's no such field (returns false).
    async _fillSavedCardCvv(tag) {
      let input = findSecurityCodeInput(this.doc);
      if (!input) input = await waitFor(() => findSecurityCodeInput(this.doc), this.leo ? 1500 : 3000, 150);
      if (!input) return false; // this checkout doesn't ask for a CVV
      const cvv = (this.d.getCvv && String(this.d.getCvv() || "").replace(/\D/g, "")) || "";
      if (cvv.length < 3) {
        this._log(`⚠️${tag} [2/3] Saved card needs a security code but no CVV is set for this account — enter it manually.`);
        return false;
      }
      this._log(`💳${tag} [2/3] Saved card on file — entering security code (CVV)…`);
      fillNativeInput(input, cvv, (m) => this._dbg(m));
      await this._w(600, 200);
      // One retry if it didn't stick (React can drop a too-fast programmatic set).
      if (findSecurityCodeInput(this.doc)) {
        fillNativeInput(input, cvv, (m) => this._dbg(m));
        await this._w(400, 150);
      }
      return true;
    }

    // Run the whole flow once from the CURRENT DOM state. Safe to re-enter
    // (each state re-checks the DOM), which is what the outer watchdog relies
    // on. Returns { state, submitted }.
    async run() {
      const d = this.d;
      const tag = this._tag();
      const doc = this.doc;
      this._to(STATES.LOADING);
      this._emit("started");
      this._log(`💳${tag} SNKRS checkout — starting…${this.leo ? " ⚡LEO speed mode" : ""}`);

      // Let Angular finish rendering (matches the original 2000ms settle).
      // LEO trims this to the minimum a rendered checkout page needs.
      await this._w(2000, 800);
      if (isWindowMinimized(doc)) {
        this._log(`⚠️${tag} Window is MINIMIZED — using DOM-order visibility checks (offsetParent bypass active)`);
      }
      this._log(formatSnapshot(tag, this.snapshot()));
      this._emit("loaded");

      // ── DELIVERY ──────────────────────────────────────────────
      this._to(STATES.DELIVERY);
      this._log(`🔍${tag} [1/3] Looking for delivery CONTINUE…`);
      const deliveryContinue = this.finder("deliveryContinue");
      if (deliveryContinue) {
        this._log(`✅${tag} [1/3] Clicking CONTINUE (delivery)…`);
        await nativeClick(deliveryContinue, "CONTINUE (delivery)", false, (m) => this._dbg(m));
        await this._w(1500, 300);
      } else {
        this._log(`ℹ️${tag} [1/3] Delivery CONTINUE not found — already confirmed or payment form is open.`);
      }
      this._emit("delivery");

      // ── PAYMENT ───────────────────────────────────────────────
      this._to(STATES.PAYMENT);
      this._log(`🔍${tag} [2/3] Checking payment state…`);
      if (isPaymentAlreadyComplete(doc)) {
        this._log(`💳${tag} [2/3] Payment already on file — no card entry needed.`);
        if (d.cancelCardFill) d.cancelCardFill();
        // Saved card, but Nike may still require the CVV/security code typed.
        await this._fillSavedCardCvv(tag);
      } else if (isInlineCardFilled(doc)) {
        this._log(`💳${tag} [2/3] Card details already filled inline — proceeding to SUBMIT.`);
        if (d.cancelCardFill) d.cancelCardFill();
        await this._fillSavedCardCvv(tag);
      } else {
        const iframe = doc.querySelector("iframe.newCard[src*='gs-payments']");
        if (!iframe && !isInlineCardFilled(doc)) {
          this._log(`🔍${tag} [2/3] No payment iframe — looking for PAYMENT accordion to expand…`);
          const paymentRow = await waitFor(() => this.finder("paymentAccordion"), 6000, 150);
          if (paymentRow) {
            this._log(`✅${tag} [2/3] Expanding PAYMENT accordion…`);
            await nativeClick(paymentRow, "PAYMENT accordion row", false, (m) => this._dbg(m));
          } else {
            this._log(`⚠️${tag} [2/3] PAYMENT accordion not found after 6s — card iframe may already be loading`);
          }
        } else {
          this._log(`ℹ️${tag} [2/3] Payment iframe already present — waiting for fill signal…`);
        }

        this._log(`⏳${tag} Waiting for card details to be filled…`);
        const cardFillPromise = (d.getCardFill && d.getCardFill()) || Promise.resolve(false);
        const filledSomehow = await Promise.race([
          cardFillPromise.then(v => ({ via: "iframe", ok: v })),
          (async () => {
            const ok = await waitFor(
              () => isInlineCardFilled(doc) || isPaymentAlreadyComplete(doc),
              60000, 300
            );
            return { via: "inline/submit", ok: !!ok };
          })(),
        ]);
        if (d.cancelCardFill) d.cancelCardFill();

        this._log(`ℹ️${tag} [2/3] Fill race resolved: via=${filledSomehow.via} ok=${filledSomehow.ok} ` +
          `| inlineFilled=${isInlineCardFilled(doc)} | alreadyComplete=${isPaymentAlreadyComplete(doc)} ` +
          `| submitFound=${!!this.finder("submit")}`);
        if (!filledSomehow.ok && !isInlineCardFilled(doc) && !isPaymentAlreadyComplete(doc) && !this.finder("submit")) {
          this._log(`❌${tag} Card details could not be filled — ABORTING.`);
          this._log(formatSnapshot(tag, this.snapshot()));
          this._to(STATES.ERROR);
          this._emit("error", { reason: "card_fill_failed" });
          return { state: this.state, submitted: false };
        }
        this._log(`✅${tag} [2/3] Card details ready (${filledSomehow.via}) — confirming PAYMENT…`);

        const paymentContinue = this.finder("paymentContinue");
        if (paymentContinue) {
          this._log(`✅${tag} [2/3] Clicking CONTINUE (payment)…`);
          await nativeClick(paymentContinue, "CONTINUE (payment)", false, (m) => this._dbg(m));
          await this._w(1200, 150);
        } else {
          this._log(`ℹ️${tag} [2/3] No payment-section CONTINUE found — going straight to SUBMIT`);
          await this._w(400, 80);
        }
      }
      this._emit("filled");

      // ── READY: commit payment, then wait for SUBMIT ───────────
      this._to(STATES.READY);
      this._log(`⏳${tag} [3/3] Finalising — committing payment, then submitting…`);
      if (this.leo) {
        // LEO: one commit click if a CONTINUE is present, then poll hard for the
        // SUBMIT button — no fixed multi-second sleeps between commits.
        const pc = this.finder("paymentContinue");
        if (pc) {
          this._log(`✅${tag} [3/3] (LEO) Committing payment…`);
          await nativeClick(pc, "CONTINUE (payment)", false, (m) => this._dbg(m));
        }
      } else {
        for (let i = 0; i < 4; i++) {
          const pc = this.finder("paymentContinue");
          if (!pc) break;
          this._log(`✅${tag} [3/3] Clicking CONTINUE (payment) to commit it (try ${i + 1})…`);
          await nativeClick(pc, "CONTINUE (payment)", false, (m) => this._dbg(m));
          await wait(1600);
        }
      }

      let hb = 0;
      const heartbeat = this.leo ? null : setInterval(() => {
        hb++;
        const all = Array.from(doc.querySelectorAll("button.button-submit"));
        this._log(`💓${tag} [3/3] waiting for SUBMIT (${hb * 3}s) — submitBtns=${all.length} ` +
          `enabled=${all.filter(b => !b.disabled).length} | paymentCont=${!!this.finder("paymentContinue")}`);
      }, 3000);
      // LEO polls the SUBMIT button every 25ms so it's clickable the instant it
      // appears; the raffle path keeps its 100ms cadence.
      let submitBtn = await waitFor(() => this.finder("submit"), 12000, this.leo ? 25 : 100);
      if (heartbeat) clearInterval(heartbeat);

      if (!submitBtn) {
        this._log(`❌${tag} [3/3] SUBMIT ORDER not found — STUCK HERE. Full page state:`);
        this._log(formatSnapshot(tag, this.snapshot()));
        this._to(STATES.ERROR);
        this._emit("error", { reason: "no_submit_button" });
        return { state: this.state, submitted: false };
      }
      this._log(`✅${tag} [3/3] SUBMIT ORDER found and enabled.`);
      this._emit("ready");

      if (d.isTestMode && d.isTestMode()) {
        this._log(`🧪${tag} TEST MODE — NOT clicking SUBMIT ORDER.`);
        this._to(STATES.DONE);
        this._emit("done", { testMode: true });
        return { state: this.state, submitted: false, testMode: true };
      }

      // ── HOLDING: drop-time gate ───────────────────────────────
      let dropAt = 0;
      try { dropAt = (d.getDropAt && await d.getDropAt()) || 0; } catch (e) { dropAt = 0; }
      this.dropAt = dropAt;
      if (dropAt && Date.now() < dropAt) {
        this._to(STATES.HOLDING);
        this._emit("holding");
        this._log(`⏸️${tag} [3/3] Primed — holding SUBMIT until drop time ${new Date(dropAt).toLocaleTimeString()}.${this.leo ? " ⚡LEO on-the-dot" : ""}`);
        if (this.leo) {
          // LEO precise hold: coarse-wait (abort-checked) until ~40ms before the
          // drop, then BUSY-SPIN the final stretch so the click lands on the dot
          // (setTimeout granularity would otherwise cost up to ~100ms).
          while (dropAt - Date.now() > 40) {
            if (await this._aborted()) {
              this._log(`🛑${tag} [3/3] PANIC — abort raised while holding. SUBMIT cancelled, order NOT placed.`);
              return this._abort();
            }
            const left = dropAt - Date.now();
            await wait(Math.min(250, left - 40));
          }
          if (await this._aborted()) {
            this._log(`🛑${tag} [3/3] PANIC — abort raised at the line. SUBMIT cancelled.`);
            return this._abort();
          }
          while (Date.now() < dropAt) { /* busy-spin the last <=40ms for precision */ }
          this._log(`🟢${tag} [3/3] DROP TIME (LEO) — submitting on the dot!`);
        } else {
          let sinceAbortCheck = 0;
          while (Date.now() < dropAt) {
            // PANIC: bail out of the hold without ever submitting.
            if (await this._aborted()) {
              this._log(`🛑${tag} [3/3] PANIC — abort raised while holding. SUBMIT cancelled, order NOT placed.`);
              return this._abort();
            }
            const left = dropAt - Date.now();
            if (left > 5000) {
              this._log(`⏳${tag} [3/3] ${Math.ceil(left / 1000)}s to drop — SUBMIT held…`);
              await wait(Math.min(3000, left - 1500));
            } else {
              // Final approach: fine-grained, but still poll abort ~once/sec.
              await wait(120);
              if (++sinceAbortCheck >= 8) { sinceAbortCheck = 0; if (await this._aborted()) {
                this._log(`🛑${tag} [3/3] PANIC — abort raised at the line. SUBMIT cancelled.`);
                return this._abort();
              } }
            }
          }
          this._log(`🟢${tag} [3/3] DROP TIME — submitting now!`);
        }
      }

      // ── DAN raffle human delay ────────────────────────────────
      // A raffle isn't won on speed and stays open for ~20 min, so submitting
      // the instant the clock ticks over (and from every account at the exact
      // same millisecond) is an unnecessary bot tell. In DAN mode we wait a
      // small RANDOM amount before clicking to look human and spread the load.
      // LEO ignores this entirely (it submits on the dot). PANIC still bails.
      if (!this.leo && this.jitterMs > 0) {
        const j = randInt(0, this.jitterMs);
        if (j > 0) {
          this._log(`🎲${tag} [3/3] DAN raffle — human delay ~${(j / 1000).toFixed(1)}s before submit…`);
          const end = Date.now() + j;
          while (Date.now() < end) {
            if (await this._aborted()) {
              this._log(`🛑${tag} [3/3] PANIC — abort raised during human delay. SUBMIT cancelled.`);
              return this._abort();
            }
            await wait(Math.min(500, end - Date.now()));
          }
        }
      }

      // Final abort gate right before the click (covers the no-hold path too).
      if (await this._aborted()) {
        this._log(`🛑${tag} [3/3] PANIC — abort raised. SUBMIT cancelled, order NOT placed.`);
        return this._abort();
      }

      // ── SUBMITTING: click + verify, bounded retries ───────────
      this._to(STATES.SUBMITTING);
      this._emit("submitting");
      this._log(`@here 🚀${tag} Clicking SUBMIT ORDER…`);
      const loc = (doc.defaultView && doc.defaultView.location) || location;
      const startUrl = loc.href;
      const advanced = () => {
        const t = (doc.body.innerText || "").toUpperCase();
        if (!loc.hostname.includes("gs.nike.com")) return true;
        if (loc.href !== startUrl) return true;
        return /PROCESSING|JUST A MINUTE|ORDER CONFIRMED|THANK YOU|YOU'RE IN|ENTRY CONFIRMED/.test(t);
      };

      let submitted = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const pc = this.finder("paymentContinue");
        if (pc) {
          this._log(`⚠️${tag} [3/3] payment CONTINUE reappeared — re-committing before submit…`);
          await nativeClick(pc, "CONTINUE (payment) re-commit", false, (m) => this._dbg(m));
          await wait(1500);
        }
        const sb = this.finder("submit");
        if (!sb) {
          if (advanced()) { submitted = true; break; }
          await wait(800);
          continue;
        }
        this._log(`🚀${tag} [3/3] SUBMIT ORDER click attempt ${attempt}…`);
        await nativeClick(sb, "SUBMIT ORDER", true, (m) => this._dbg(m));
        submitted = true;
        this._emit("submitted", { attempt, offsetMs: dropAt ? Date.now() - dropAt : null });
        if (await waitFor(advanced, 5000, 250)) {
          this._log(`✅${tag} [3/3] Submit registered — order is processing.`);
          break;
        }
        this._log(`🔁${tag} [3/3] Submit didn't advance yet (attempt ${attempt}) — retrying…`);
      }

      if (!submitted) {
        this._log(`❌${tag} [3/3] Could not click SUBMIT ORDER.`);
        this._log(formatSnapshot(tag, this.snapshot()));
        this._to(STATES.ERROR);
        this._emit("error", { reason: "submit_click_failed" });
        return { state: this.state, submitted: false };
      }

      await wait(500);
      this._to(STATES.DONE);
      this._emit("done");
      return { state: this.state, submitted: true };
    }
  }

  return {
    STATES,
    // detection
    wait, randInt, waitFor,
    isWindowMinimized, isLogicallyVisible, findPaymentFormEl, sortByDomOrder,
    findDeliveryContinueButton, findDeliveryContinueOnly, findPaymentAccordionRow,
    findPaymentIframe, findPaymentContinueOnly, findSubmitOrderButton,
    isPaymentAlreadyComplete, isInlineCardFilled, isConfirmed,
    findSecurityCodeInput, fillNativeInput,
    snapshotPageState, formatSnapshot, nativeClick,
    // machine
    CheckoutMachine,
  };
});
