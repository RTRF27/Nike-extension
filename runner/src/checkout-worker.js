// ============================================================
// Reagan Runner — CHECKOUT WORKER
// ============================================================
// Void splits the job in two, and it's a genuinely good design:
//
//   TASKS            find the product, pick a size, Add to Bag  →  emit a
//                    checkout job (a live cart that will expire)
//   CHECKOUT WORKERS consume those jobs and actually pay for them
//
// The split matters because the two halves fail differently. Carting fails on
// stock; paying fails on the CARD. So a checkout worker's retry policy is about
// payment: if a card declines, retrying the SAME card just declines again — you
// have to rotate to a different billing profile. That's what
// `profileRotateRetries` is for, and it's the piece most people miss.
//
// This class is PURE: every side effect (browser, clock, logging) is injected,
// so the whole policy is unit-testable offline with no Playwright and no Nike.
// Same trick as the extension's checkout-core.js.
// ============================================================

const OUTCOME = {
  COMPLETED: "completed",   // order placed
  DECLINED:  "declined",    // payment rejected — rotating the card may help
  EXPIRED:   "expired",     // the cart died; retrying this job is pointless
  ERROR:     "error",       // transport/page problem — worth a plain retry
};

class CheckoutWorker {
  /**
   * @param {object} cfg
   *   id, name                 identity (matches workers.csv)
   *   proxyGroup               named proxy list this worker draws from
   *   maxRetries               attempts per job before giving up
   *   retryDelayMs             pause between attempts
   *   profileRotateRetries     rotate billing profile every N failed attempts
   *   timeLimitMs              hard cap on one job (0 = none)
   *   stopOnCartExpiry         abandon immediately when the cart expires
   * @param {object} deps
   *   takeJob()      -> job | null          pull the next checkout job
   *   runCheckout(job, profile) -> {status, detail}
   *   nextProfile(current)      -> profile   rotate billing identity
   *   onResult(job, result)                 persist / notify
   *   log(msg)
   *   now() -> ms       sleep(ms)           injected so tests run instantly
   *   shouldStop() -> bool                  cooperative cancellation
   */
  constructor(cfg, deps) {
    this.id = cfg.id;
    this.name = cfg.name || `worker-${cfg.id}`;
    this.proxyGroup = cfg.proxyGroup || "";
    this.maxRetries = Math.max(0, cfg.maxRetries ?? 5);
    this.retryDelayMs = Math.max(0, cfg.retryDelayMs ?? 5000);
    this.profileRotateRetries = Math.max(0, cfg.profileRotateRetries ?? 3);
    this.timeLimitMs = Math.max(0, cfg.timeLimitMs ?? 25 * 60000);
    this.stopOnCartExpiry = cfg.stopOnCartExpiry !== false;
    this.enabled = cfg.enabled !== false;

    this.d = deps || {};
    this.stats = { completed: 0, declined: 0, expired: 0, errors: 0, attempts: 0 };
    this.startedAt = null;
    this.stoppedAt = null;
    this.state = "idle";
  }

  _log(m) { if (this.d.log) this.d.log(`[${this.name}] ${m}`); }
  _now() { return this.d.now ? this.d.now() : Date.now(); }
  _sleep(ms) { return this.d.sleep ? this.d.sleep(ms) : new Promise(r => setTimeout(r, ms)); }
  _stop() { return this.d.shouldStop ? !!this.d.shouldStop() : false; }

  // Work one job to a terminal outcome. Returns the outcome string.
  async processJob(job) {
    const started = this._now();
    let profile = job.profile || (this.d.nextProfile ? this.d.nextProfile(null) : null);
    let attempt = 0;
    let sinceRotate = 0;

    while (true) {
      if (this._stop()) { this._log(`stopped mid-job ${job.id}`); return "stopped"; }

      if (this.timeLimitMs && this._now() - started > this.timeLimitMs) {
        this._log(`⌛ job ${job.id} hit the ${Math.round(this.timeLimitMs / 60000)}min limit — giving up.`);
        this.stats.declined++;
        this._result(job, { status: OUTCOME.DECLINED, detail: "time limit reached", attempts: attempt });
        return OUTCOME.DECLINED;
      }

      attempt++;
      this.stats.attempts++;
      this.state = "checking-out";
      this._log(`attempt ${attempt}/${this.maxRetries + 1} on job ${job.id}` +
                (profile ? ` with profile "${profile.name}"` : ""));

      let res;
      try {
        res = await this.d.runCheckout(job, profile);
      } catch (e) {
        res = { status: OUTCOME.ERROR, detail: String((e && e.message) || e) };
      }
      const status = (res && res.status) || OUTCOME.ERROR;
      const detail = (res && res.detail) || "";

      if (status === OUTCOME.COMPLETED) {
        this.stats.completed++;
        this.state = "idle";
        this._log(`✅ ORDER PLACED for job ${job.id}${detail ? " — " + detail : ""}`);
        this._result(job, { status, detail, attempts: attempt, profile: profile && profile.name });
        return status;
      }

      // A dead cart cannot be revived by retrying — the checkout id is gone.
      if (status === OUTCOME.EXPIRED) {
        this.stats.expired++;
        this._log(`🗑️ cart expired on job ${job.id}${this.stopOnCartExpiry ? " — abandoning" : " — treating as retryable"}`);
        if (this.stopOnCartExpiry) {
          this.state = "idle";
          this._result(job, { status, detail: detail || "cart expired", attempts: attempt });
          return status;
        }
      } else if (status === OUTCOME.DECLINED) {
        this.stats.declined++;
        sinceRotate++;
      } else {
        this.stats.errors++;
      }

      if (attempt > this.maxRetries) {
        this.state = "idle";
        this._log(`❌ giving up on job ${job.id} after ${attempt} attempt(s) — last: ${status}${detail ? " (" + detail + ")" : ""}`);
        this._result(job, { status, detail, attempts: attempt, gaveUp: true });
        return status;
      }

      // Rotate the billing profile after N consecutive declines: the same card
      // will keep declining, a different one might not.
      if (status === OUTCOME.DECLINED && this.profileRotateRetries &&
          sinceRotate >= this.profileRotateRetries && this.d.nextProfile) {
        const nextP = this.d.nextProfile(profile);
        if (nextP && (!profile || nextP.name !== profile.name)) {
          this._log(`🔄 ${sinceRotate} decline(s) — rotating profile "${profile && profile.name}" → "${nextP.name}"`);
          profile = nextP;
          sinceRotate = 0;
        } else {
          this._log(`⚠️ ${sinceRotate} decline(s) but no other billing profile to rotate to.`);
          sinceRotate = 0;
        }
      }

      if (this.retryDelayMs) await this._sleep(this.retryDelayMs);
    }
  }

  _result(job, result) {
    try { if (this.d.onResult) this.d.onResult(job, result); } catch (e) { this._log("onResult failed: " + e.message); }
  }

  // Consume jobs until the queue is dry or we're told to stop.
  async run() {
    if (!this.enabled) { this._log("disabled — not starting."); return this.stats; }
    this.startedAt = this._now();
    this.state = "running";
    this._log(`started (proxy group "${this.proxyGroup || "any"}", ${this.maxRetries} retries, ` +
              `rotate every ${this.profileRotateRetries}, limit ${Math.round(this.timeLimitMs / 60000)}min)`);
    while (!this._stop()) {
      const job = this.d.takeJob ? await this.d.takeJob() : null;
      if (!job) break;
      await this.processJob(job);
    }
    this.stoppedAt = this._now();
    this.state = "stopped";
    this._log(`finished — ${this.stats.completed} completed, ${this.stats.declined} declined, ` +
              `${this.stats.expired} expired, ${this.stats.errors} errors`);
    return this.stats;
  }

  toRow() {
    return {
      id: this.id, name: this.name, proxy_list: this.proxyGroup,
      max_retries: this.maxRetries,
      retry_delay_seconds: Math.round(this.retryDelayMs / 1000),
      profile_rotate_retries: this.profileRotateRetries,
      time_limit_minutes: Math.round(this.timeLimitMs / 60000),
      stop_on_cart_expiry: this.stopOnCartExpiry,
      enabled: this.enabled,
      completed: this.stats.completed,
      declined: this.stats.declined,
      started_at: this.startedAt ? new Date(this.startedAt).toISOString() : "",
      stopped_at: this.stoppedAt ? new Date(this.stoppedAt).toISOString() : "",
    };
  }
}

module.exports = { CheckoutWorker, OUTCOME };
