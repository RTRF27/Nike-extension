document.addEventListener("DOMContentLoaded", async () => {
  const KEY = "snkrsBotSettings";

  // ── Preview helper ────────────────────────────────────────────
  // Sends a preview request to the active Nike launch tab, which highlights
  // the exact product card + size button the bot would target. Shows the
  // result in the given status element.
  function sendPreview(keyword, size, sizeType, statusEl) {
    if (!size) {
      if (statusEl) {
        statusEl.style.color = "#fa5400";
        statusEl.textContent = "Pick a size first to preview.";
        setTimeout(() => (statusEl.textContent = ""), 2500);
      }
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !/nike\.com\/.*\/launch/.test(tab.url || "")) {
        if (statusEl) {
          statusEl.style.color = "#fa5400";
          statusEl.textContent = "Open a Nike launch page in this tab first.";
          setTimeout(() => (statusEl.textContent = ""), 3500);
        }
        return;
      }
      if (statusEl) {
        statusEl.style.color = "#888";
        statusEl.textContent = "Previewing on the page…";
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "preview_target", keyword, size, sizeType },
        (resp) => {
          if (chrome.runtime.lastError) {
            if (statusEl) {
              statusEl.style.color = "#e03131";
              statusEl.textContent = "Couldn't reach the page — reload the Nike tab and retry.";
            }
            return;
          }
          const r = resp && resp.result;
          if (!statusEl) return;
          if (r && r.ok) {
            statusEl.style.color = "#1db954";
            statusEl.textContent = r.message || "✓ Target highlighted on the page.";
          } else {
            statusEl.style.color = "#f08c00";
            statusEl.textContent = (r && r.message) || "Could not highlight target.";
          }
        }
      );
    });
  }

  const US_SIZES = [
    "5", "5.5", "6", "6.5", "7", "7.5",
    "8", "8.5", "9", "9.5", "10", "10.5",
    "11", "11.5", "12", "12.5", "13", "13.5", "14",
  ];

  // Apparel sizes (tops/hoodies/etc.) — same selection mechanic on nike.com.
  const APPAREL_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

  const els = {
    profileLabel:        document.getElementById("profileLabel"),
    enabled:             document.getElementById("enabled"),
    testMode:            document.getElementById("testMode"),
    logWebhook:          document.getElementById("logWebhook"),
    alertWebhook:        document.getElementById("alertWebhook"),
    sizeGrid:            document.getElementById("sizeGrid"),
    apparelGrid:         document.getElementById("apparelGrid"),
    productKeyword:      document.getElementById("productKeyword"),
    previewMainBtn:      document.getElementById("previewMainBtn"),
    previewMainMsg:      document.getElementById("previewMainMsg"),
    saveBtn:             document.getElementById("saveBtn"),
    saveMsg:             document.getElementById("saveMsg"),
    statusDot:           document.getElementById("statusDot"),
    statusText:          document.getElementById("statusText"),
    // Card
    cardName:            document.getElementById("cardName"),
    cardNumber:          document.getElementById("cardNumber"),
    cardExpiry:          document.getElementById("cardExpiry"),
    cardCvv:             document.getElementById("cardCvv"),
    // Poller
    statusPollerEnabled: document.getElementById("statusPollerEnabled"),
    pollerIntervalMin:   document.getElementById("pollerIntervalMin"),
    // Multi-product drop
    multiEnabled:        document.getElementById("multiEnabled"),
    useScheduler:        document.getElementById("useScheduler"),
    schedulerPanel:      document.getElementById("schedulerPanel"),
    dropTime:            document.getElementById("dropTime"),
    slotsContainer:      document.getElementById("slotsContainer"),
    openNowBtn:          document.getElementById("openNowBtn"),
    dropStatusMsg:       document.getElementById("dropStatusMsg"),
    multiPanel:          document.getElementById("multiPanel"),
  };

  let selectedSize = "";
  let selectedType = "footwear"; // "footwear" | "apparel"

  // ── Main "Preview Target" button ──────────────────────────────
  if (els.previewMainBtn) {
    els.previewMainBtn.addEventListener("click", () => {
      const kw = els.productKeyword ? els.productKeyword.value.trim() : "";
      sendPreview(kw, selectedSize, selectedType, els.previewMainMsg);
    });
  }

  // ── Card number formatter: adds spaces every 4 digits ─────────
  els.cardNumber.addEventListener("input", () => {
    let v = els.cardNumber.value.replace(/\D/g, "").slice(0, 16);
    els.cardNumber.value = v.replace(/(.{4})/g, "$1 ").trim();
  });

  // ── Expiry formatter: auto-inserts slash ──────────────────────
  els.cardExpiry.addEventListener("input", (e) => {
    let v = els.cardExpiry.value.replace(/\D/g, "").slice(0, 4);
    if (v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
    els.cardExpiry.value = v;
  });

  // ── Only digits for CVV ───────────────────────────────────────
  els.cardCvv.addEventListener("input", () => {
    els.cardCvv.value = els.cardCvv.value.replace(/\D/g, "").slice(0, 4);
  });

  function selectSizeButton(btn, size, type) {
    // Only clear selection within the main (single-product) grids, so the
    // multi-product slot grids keep their independent selections.
    els.sizeGrid.querySelectorAll(".size-btn").forEach(b => b.classList.remove("selected"));
    els.apparelGrid.querySelectorAll(".size-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedSize = size;
    selectedType = type;
  }

  // ── Build footwear size grid ──────────────────────────────────
  US_SIZES.forEach(size => {
    const btn = document.createElement("button");
    btn.className = "size-btn";
    btn.dataset.size = size;
    btn.dataset.type = "footwear";
    btn.textContent = "US " + size; // matches exact button text on nike.com/sg/launch pages
    btn.addEventListener("click", () => selectSizeButton(btn, size, "footwear"));
    els.sizeGrid.appendChild(btn);
  });

  // ── Build apparel size grid ───────────────────────────────────
  if (els.apparelGrid) {
    APPAREL_SIZES.forEach(size => {
      const btn = document.createElement("button");
      btn.className = "size-btn";
      btn.dataset.size = size;
      btn.dataset.type = "apparel";
      btn.textContent = size; // matches exact apparel button text (S, M, L, XL…)
      btn.addEventListener("click", () => selectSizeButton(btn, size, "apparel"));
      els.apparelGrid.appendChild(btn);
    });
  }

  // ── Multi-product slot builder ────────────────────────────────
  // Each slot holds its own URL, keyword, size, and size-type. We keep slot
  // state in this array and render two slot cards into #slotsContainer.
  const NUM_SLOTS = 2;
  const slotState = [
    { url: "", keyword: "", size: "", sizeType: "footwear" },
    { url: "", keyword: "", size: "", sizeType: "footwear" },
  ];

  function buildSlotCard(index) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "border:1px solid #2e2e2e; border-radius:8px; padding:10px; margin-bottom:10px;";

    const title = document.createElement("div");
    title.className = "section-label";
    title.style.cssText = "font-size:12px; margin-bottom:8px;";
    title.textContent = `PRODUCT ${index + 1}`;
    wrap.appendChild(title);

    // URL field
    const urlGroup = document.createElement("div");
    urlGroup.className = "field-group";
    const urlLabel = document.createElement("label");
    urlLabel.className = "field-label";
    urlLabel.textContent = "Product URL";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "field-input";
    urlInput.placeholder = "https://www.nike.com/sg/launch/t/...";
    urlInput.autocomplete = "off";
    urlInput.addEventListener("input", () => {
      slotState[index].url = urlInput.value.trim();
      refreshTaggedUrl();
    });
    urlGroup.appendChild(urlLabel);
    urlGroup.appendChild(urlInput);
    wrap.appendChild(urlGroup);

    // ── Tagged URL for MANUAL opening ─────────────────────────────
    // Builds "<url>#snkrsSlot=N" so a tab opened with it targets THIS slot's
    // product/size. This is the manual-first workflow — you open both tabs
    // yourself before the drop; no clock needed.
    const taggedWrap = document.createElement("div");
    taggedWrap.style.cssText = "margin-top:8px; padding:8px; background:#141414; border:1px solid #2e2e2e; border-radius:6px;";
    const taggedLabel = document.createElement("div");
    taggedLabel.className = "field-label";
    taggedLabel.style.marginBottom = "4px";
    taggedLabel.innerHTML = `Tagged URL to open manually <span style="font-weight:400;opacity:.6;">(slot ${index + 1})</span>`;
    const taggedUrl = document.createElement("div");
    taggedUrl.style.cssText = "font:600 11px/1.4 monospace; color:#7fd1a8; word-break:break-all; margin-bottom:6px; min-height:15px;";
    taggedUrl.textContent = "(enter a product URL above)";
    const taggedBtnRow = document.createElement("div");
    taggedBtnRow.style.cssText = "display:flex; gap:6px;";
    const copyBtn = document.createElement("button");
    copyBtn.className = "save-btn";
    copyBtn.style.cssText = "flex:1; background:#222; font-size:11px; padding:6px;";
    copyBtn.textContent = "📋 COPY";
    const openTabBtn = document.createElement("button");
    openTabBtn.className = "save-btn";
    openTabBtn.style.cssText = "flex:1; background:#222; font-size:11px; padding:6px;";
    openTabBtn.textContent = "↗ OPEN TAB";
    taggedBtnRow.appendChild(copyBtn);
    taggedBtnRow.appendChild(openTabBtn);
    const taggedMsg = document.createElement("div");
    taggedMsg.style.cssText = "font-size:11px; margin-top:4px; min-height:13px;";
    taggedWrap.appendChild(taggedLabel);
    taggedWrap.appendChild(taggedUrl);
    taggedWrap.appendChild(taggedBtnRow);
    taggedWrap.appendChild(taggedMsg);
    wrap.appendChild(taggedWrap);

    function buildTaggedUrl() {
      let u = (slotState[index].url || "").trim();
      if (!u) return "";
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      const sep = u.includes("#") ? "&" : "#";
      return `${u}${sep}snkrsSlot=${index + 1}`;
    }
    function refreshTaggedUrl() {
      const u = buildTaggedUrl();
      taggedUrl.textContent = u || "(enter a product URL above)";
    }
    copyBtn.addEventListener("click", () => {
      const u = buildTaggedUrl();
      if (!u) {
        taggedMsg.style.color = "#fa5400";
        taggedMsg.textContent = "Enter a product URL first.";
        setTimeout(() => (taggedMsg.textContent = ""), 2500);
        return;
      }
      navigator.clipboard.writeText(u).then(() => {
        taggedMsg.style.color = "#1db954";
        taggedMsg.textContent = "✓ Copied — paste into a new tab.";
        setTimeout(() => (taggedMsg.textContent = ""), 2500);
      }).catch(() => {
        taggedMsg.style.color = "#e03131";
        taggedMsg.textContent = "Copy failed — select the URL manually.";
        setTimeout(() => (taggedMsg.textContent = ""), 3000);
      });
    });
    openTabBtn.addEventListener("click", () => {
      const u = buildTaggedUrl();
      if (!u) {
        taggedMsg.style.color = "#fa5400";
        taggedMsg.textContent = "Enter a product URL first.";
        setTimeout(() => (taggedMsg.textContent = ""), 2500);
        return;
      }
      // Persist slots first so the opened tab can read this slot's settings.
      chrome.storage.sync.get(KEY, (saved) => {
        const merged = { ...(saved[KEY] || {}), slots: collectAllSlots() };
        chrome.storage.sync.set({ [KEY]: merged }, () => {
          chrome.tabs.create({ url: u, active: false });
          taggedMsg.style.color = "#1db954";
          taggedMsg.textContent = "✓ Opened in a background tab.";
          setTimeout(() => (taggedMsg.textContent = ""), 2500);
        });
      });
    });

    // Keyword field (optional — for collection pages)
    const kwGroup = document.createElement("div");
    kwGroup.className = "field-group";
    kwGroup.style.marginTop = "8px";
    const kwLabel = document.createElement("label");
    kwLabel.className = "field-label";
    kwLabel.innerHTML = 'Product keyword / SKU <span style="font-weight:400; opacity:0.6;">(optional — only for collection pages)</span>';
    const kwInput = document.createElement("input");
    kwInput.type = "text";
    kwInput.className = "field-input";
    kwInput.placeholder = "leave blank for a normal single-product URL";
    kwInput.autocomplete = "off";
    kwInput.addEventListener("input", () => { slotState[index].keyword = kwInput.value.trim(); });
    kwGroup.appendChild(kwLabel);
    kwGroup.appendChild(kwInput);
    wrap.appendChild(kwGroup);

    // Size sub-label
    const fLabel = document.createElement("div");
    fLabel.className = "size-subhead";
    fLabel.style.marginTop = "10px";
    fLabel.textContent = "Footwear (US Men's)";
    wrap.appendChild(fLabel);

    const footGrid = document.createElement("div");
    footGrid.className = "size-grid";
    wrap.appendChild(footGrid);

    const aLabel = document.createElement("div");
    aLabel.className = "size-subhead";
    aLabel.style.marginTop = "10px";
    aLabel.textContent = "Apparel";
    wrap.appendChild(aLabel);

    const appGrid = document.createElement("div");
    appGrid.className = "size-grid";
    wrap.appendChild(appGrid);

    // Selecting a size in this slot only clears THIS slot's grids.
    function selectSlotSize(btn, size, type) {
      footGrid.querySelectorAll(".size-btn").forEach(b => b.classList.remove("selected"));
      appGrid.querySelectorAll(".size-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      slotState[index].size = size;
      slotState[index].sizeType = type;
    }

    US_SIZES.forEach(size => {
      const btn = document.createElement("button");
      btn.className = "size-btn";
      btn.dataset.size = size;
      btn.dataset.type = "footwear";
      btn.textContent = "US " + size;
      btn.addEventListener("click", () => selectSlotSize(btn, size, "footwear"));
      footGrid.appendChild(btn);
    });
    APPAREL_SIZES.forEach(size => {
      const btn = document.createElement("button");
      btn.className = "size-btn";
      btn.dataset.size = size;
      btn.dataset.type = "apparel";
      btn.textContent = size;
      btn.addEventListener("click", () => selectSlotSize(btn, size, "apparel"));
      appGrid.appendChild(btn);
    });

    // Expose setters so we can restore saved values
    wrap._setValues = (slot) => {
      urlInput.value = slot.url || "";
      kwInput.value = slot.keyword || "";
      if (slot.size) {
        const grid = slot.sizeType === "apparel" ? appGrid : footGrid;
        const b = grid.querySelector(`.size-btn[data-size="${slot.size}"]`);
        if (b) b.classList.add("selected");
      }
      refreshTaggedUrl();
    };

    // Per-slot "Preview Target" button — verifies this slot's product/size on
    // the active Nike tab before the drop.
    const previewBtn = document.createElement("button");
    previewBtn.className = "save-btn";
    previewBtn.style.cssText = "margin-top:10px; background:#1db954;";
    previewBtn.textContent = `🔍 PREVIEW PRODUCT ${index + 1} ON PAGE`;
    const previewMsg = document.createElement("div");
    previewMsg.className = "save-msg";
    previewBtn.addEventListener("click", () => {
      const st = slotState[index];
      sendPreview(st.keyword, st.size, st.sizeType, previewMsg);
    });
    wrap.appendChild(previewBtn);
    wrap.appendChild(previewMsg);

    els.slotsContainer.appendChild(wrap);
    return wrap;
  }

  const slotCards = [];
  for (let i = 0; i < NUM_SLOTS; i++) slotCards.push(buildSlotCard(i));

  function setMultiPanelVisible(on) {
    els.multiPanel.style.display = on ? "block" : "none";
  }
  els.multiEnabled.addEventListener("change", () => setMultiPanelVisible(els.multiEnabled.checked));

  function setSchedulerPanelVisible(on) {
    if (els.schedulerPanel) els.schedulerPanel.style.display = on ? "block" : "none";
  }
  if (els.useScheduler) {
    els.useScheduler.addEventListener("change", () => setSchedulerPanelVisible(els.useScheduler.checked));
  }

  // ── Load saved settings ───────────────────────────────────────
  chrome.storage.sync.get(KEY, (saved) => {
    const s = saved[KEY] || {};

    els.profileLabel.value        = s.profileLabel        || "";
    els.enabled.checked           = s.enabled             ?? true;
    els.testMode.checked          = s.testMode            ?? false;
    els.logWebhook.value          = s.logWebhook          || "";
    els.alertWebhook.value        = s.alertWebhook        || "";
    els.statusPollerEnabled.checked = s.statusPollerEnabled ?? true;
    els.pollerIntervalMin.value   = s.pollerIntervalMin   ?? 3;

    // Card details
    els.cardName.value   = s.cardName   || "";
    els.cardNumber.value = s.cardNumber || "";
    els.cardExpiry.value = s.cardExpiry || "";
    // CVV intentionally not pre-filled in the visible input for security
    // but we load it so the bot can use it — just don't display it
    els.cardCvv.value    = s.cardCvv    || "";

    if (s.preferredSize) {
      selectedSize = s.preferredSize;
      selectedType = s.preferredSizeType || "footwear";
      // Scope to the MAIN grids so we don't accidentally match a slot grid.
      const mainGrids = [els.sizeGrid, els.apparelGrid];
      let btn = null;
      for (const g of mainGrids) {
        btn = g.querySelector(`.size-btn[data-size="${s.preferredSize}"][data-type="${selectedType}"]`)
           || g.querySelector(`.size-btn[data-size="${s.preferredSize}"]`);
        if (btn) break;
      }
      if (btn) {
        btn.classList.add("selected");
        selectedType = btn.dataset.type || selectedType;
      }
    }

    if (els.productKeyword) els.productKeyword.value = s.productKeyword || "";

    // ── Restore multi-product drop settings ─────────────────────
    els.multiEnabled.checked = s.multiEnabled ?? false;
    setMultiPanelVisible(els.multiEnabled.checked);
    // Scheduler is on only if it was explicitly enabled AND a drop time exists.
    const schedulerOn = !!(s.useScheduler && s.dropTimeISO);
    if (els.useScheduler) {
      els.useScheduler.checked = schedulerOn;
      setSchedulerPanelVisible(schedulerOn);
    }
    if (s.dropTimeISO) {
      // datetime-local needs "YYYY-MM-DDTHH:mm" in LOCAL time, no seconds/zone.
      const d = new Date(s.dropTimeISO);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, "0");
        els.dropTime.value =
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
          `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
    if (Array.isArray(s.slots)) {
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (s.slots[i]) {
          slotState[i] = {
            url: s.slots[i].url || "",
            keyword: s.slots[i].keyword || "",
            size: s.slots[i].size || "",
            sizeType: s.slots[i].sizeType || "footwear",
          };
          slotCards[i]._setValues(slotState[i]);
        }
      }
    }

    updateStatusPill(s.enabled ?? true);
  });

  // ── Status pill ───────────────────────────────────────────────
  function updateStatusPill(enabled) {
    els.statusDot.className = enabled ? "status-dot on" : "status-dot off";
    els.statusText.textContent = enabled ? "ON" : "OFF";
  }

  els.enabled.addEventListener("change", () => updateStatusPill(els.enabled.checked));

  // Helper: collect the slots that have a URL filled in.
  function collectActiveSlots() {
    return slotState
      .map(s => ({
        url: (s.url || "").trim(),
        keyword: (s.keyword || "").trim(),
        size: s.size || "",
        sizeType: s.sizeType || "footwear",
      }))
      .filter(s => s.url);
  }

  // Helper: collect ALL slots by INDEX (no filtering), so a manually-opened
  // tagged tab (#snkrsSlot=N) can always read slot N's product/size even if
  // the other slot is empty. Index position is preserved — critical because
  // the slot marker is 1-based on array position.
  function collectAllSlots() {
    return slotState.map(s => ({
      url: (s.url || "").trim(),
      keyword: (s.keyword || "").trim(),
      size: s.size || "",
      sizeType: s.sizeType || "footwear",
    }));
  }

  // Convert the datetime-local value (local time) to an ISO string.
  function dropTimeISO() {
    const v = els.dropTime.value;
    if (!v) return "";
    const d = new Date(v); // interpreted as local time
    return isNaN(d.getTime()) ? "" : d.toISOString();
  }

  // ── Save ──────────────────────────────────────────────────────
  els.saveBtn.addEventListener("click", () => {
    const multiOn = els.multiEnabled.checked;
    const schedulerOn = multiOn && els.useScheduler && els.useScheduler.checked;

    // Validation differs by mode.
    if (multiOn) {
      const active = collectActiveSlots();
      if (active.length < 1) {
        els.saveMsg.style.color = "#fa5400";
        els.saveMsg.textContent = "ADD AT LEAST ONE PRODUCT URL";
        setTimeout(() => els.saveMsg.textContent = "", 2500);
        return;
      }
      const missingSize = active.find(s => !s.size);
      if (missingSize) {
        els.saveMsg.style.color = "#fa5400";
        els.saveMsg.textContent = "PICK A SIZE FOR EACH PRODUCT";
        setTimeout(() => els.saveMsg.textContent = "", 2500);
        return;
      }
      // Drop time is required ONLY if the optional clock is enabled.
      if (schedulerOn && !dropTimeISO()) {
        els.saveMsg.style.color = "#fa5400";
        els.saveMsg.textContent = "SET A DROP TIME (or turn off the clock)";
        setTimeout(() => els.saveMsg.textContent = "", 3000);
        return;
      }
    } else {
      if (!selectedSize) {
        els.saveMsg.style.color = "#fa5400";
        els.saveMsg.textContent = "SELECT A SIZE FIRST";
        setTimeout(() => els.saveMsg.textContent = "", 2000);
        return;
      }
    }

    // Basic card validation (applies to both modes)
    const rawNumber = (els.cardNumber.value || "").replace(/\s/g, "");
    if (rawNumber && rawNumber.length < 13) {
      els.saveMsg.style.color = "#e03131";
      els.saveMsg.textContent = "CHECK CARD NUMBER";
      setTimeout(() => els.saveMsg.textContent = "", 2000);
      return;
    }

    const sizeDisplay = selectedType === "apparel" ? selectedSize : "US " + selectedSize;

    const settings = {
      enabled:             els.enabled.checked,
      testMode:            els.testMode.checked,
      preferredSize:       selectedSize,
      preferredSizeType:   selectedType,
      productKeyword:      els.productKeyword ? els.productKeyword.value.trim() : "",
      profileLabel:        els.profileLabel.value.trim(),
      logWebhook:          els.logWebhook.value.trim(),
      alertWebhook:        els.alertWebhook.value.trim(),
      // Card — stored as-is (with spaces for number, slash for expiry)
      cardName:            els.cardName.value.trim(),
      cardNumber:          els.cardNumber.value.trim(),
      cardExpiry:          els.cardExpiry.value.trim(),
      cardCvv:             els.cardCvv.value.trim(),
      // Poller
      statusPollerEnabled: els.statusPollerEnabled.checked,
      pollerIntervalMin:   parseInt(els.pollerIntervalMin.value) || 3,
      // Multi-product drop
      multiEnabled:        multiOn,
      useScheduler:        schedulerOn,
      // Clock only set when the optional scheduler is enabled.
      dropTimeISO:         schedulerOn ? dropTimeISO() : "",
      // Save ALL slots by index (not filtered) so manually-opened tagged tabs
      // (#snkrsSlot=N) always resolve to the right slot regardless of which
      // other slots are filled.
      slots:               collectAllSlots(),
    };

    chrome.storage.sync.set({ [KEY]: settings }, () => {
      // Arm the drop schedule ONLY if the optional clock is enabled.
      // Otherwise cancel any previously-set alarm (manual mode needs none).
      chrome.runtime.sendMessage({ type: schedulerOn ? "schedule_drop" : "cancel_drop" });

      let msg;
      if (schedulerOn) {
        const t = new Date(settings.dropTimeISO);
        const when = t.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        msg = `⚙️ SNKRS Bot saved — 2 products, auto-open scheduled for ${when}.`;
      } else if (multiOn) {
        msg = `⚙️ SNKRS Bot saved — 2 products configured (manual: open each tagged URL in a tab).`;
      } else {
        msg = `⚙️ SNKRS Bot saved — size ${sizeDisplay}${settings.profileLabel ? ", " + settings.profileLabel : ""}.`;
      }
      chrome.runtime.sendMessage({ type: "log", message: msg });

      updateStatusPill(settings.enabled);
      els.saveMsg.style.color = "#1db954";
      els.saveMsg.textContent = multiOn
        ? (schedulerOn ? `✓ SAVED — 2 products, auto-open set` : `✓ SAVED — 2 products (open tagged URLs)`)
        : `✓ SAVED — ${sizeDisplay}`;
      setTimeout(() => els.saveMsg.textContent = "", 3000);
    });
  });

  // ── Open both tabs now (manual test) ──────────────────────────
  els.openNowBtn.addEventListener("click", () => {
    const active = collectActiveSlots();
    if (active.length < 1) {
      els.dropStatusMsg.style.color = "#fa5400";
      els.dropStatusMsg.textContent = "ADD AT LEAST ONE PRODUCT URL FIRST";
      setTimeout(() => els.dropStatusMsg.textContent = "", 2500);
      return;
    }
    const missingSize = active.find(s => !s.size);
    if (missingSize) {
      els.dropStatusMsg.style.color = "#fa5400";
      els.dropStatusMsg.textContent = "PICK A SIZE FOR EACH PRODUCT FIRST";
      setTimeout(() => els.dropStatusMsg.textContent = "", 2500);
      return;
    }
    // Persist slots first so the content scripts can read them, then open.
    chrome.storage.sync.get(KEY, (saved) => {
      const merged = { ...(saved[KEY] || {}), slots: active };
      chrome.storage.sync.set({ [KEY]: merged }, () => {
        chrome.runtime.sendMessage({ type: "open_drop_now" });
        els.dropStatusMsg.style.color = "#1db954";
        els.dropStatusMsg.textContent = `Opening ${active.length} tab(s)…`;
        setTimeout(() => els.dropStatusMsg.textContent = "", 3000);
      });
    });
  });
});