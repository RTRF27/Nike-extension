// Discord / Telegram webhooks — same events the extension sends, so a run from
// the terminal reports to the same channel as a run from the dashboard.
async function post(url, body) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch (e) { return false; }
}
// `ping` prefixes @here for DISCORD only — Telegram has no such mention and
// would render the literal text.
async function notify(cfg, text, ping = false) {
  const jobs = [];
  if (cfg && cfg.discordWebhook) jobs.push(post(cfg.discordWebhook, { content: (ping ? "@here " : "") + text }));
  if (cfg && cfg.telegramToken && cfg.telegramChatId) {
    jobs.push(post(`https://api.telegram.org/bot${encodeURIComponent(cfg.telegramToken)}/sendMessage`,
      { chat_id: String(cfg.telegramChatId), text, disable_web_page_preview: true }));
  }
  await Promise.all(jobs);
}
module.exports = { notify };
