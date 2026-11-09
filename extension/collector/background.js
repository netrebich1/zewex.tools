// Zewex Collector — фоновый скрипт: запросы к порталу (с токеном) и «одна рабочая вкладка на режим».
// Сами запросы к Pinterest делают content scripts на странице (нужны cookie и csrf-токен сессии).

const DEFAULT_SERVER = "https://zewex.tools";

async function settings() {
  const s = await chrome.storage.local.get(["server", "token", "enabled"]);
  return { server: (s.server || DEFAULT_SERVER).replace(/\/+$/, ""), token: s.token || "", enabled: s.enabled !== false };
}

/** POST /api/keywords/collector/<action> → { ok, status, data } (data — JSON ответа портала). */
async function api(action, body) {
  const { server, token } = await settings();
  if (!token) return { ok: false, status: 0, data: { error: "Токен не вставлен. Откройте окно расширения и вставьте токен с вкладки «Сбор».", code: "no_token" } };
  try {
    const r = await fetch(`${server}/api/keywords/collector/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, version: chrome.runtime.getManifest().version }),
    });
    const data = await r.json().catch(() => ({ error: `Портал ответил ${r.status}` }));
    // Портал присылает актуальную версию расширения — окно расширения подскажет обновиться.
    if (data && typeof data.latest === "string") await chrome.storage.local.set({ latest: data.latest });
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Нет связи с порталом: ${e && e.message ? e.message : e}`, code: "network" } };
  }
}

/** Только одна вкладка Pinterest (и одна Ads Manager) собирает — остальные ждут. */
async function claim(mode, tabId) {
  const key = `lock_${mode}`;
  const cur = (await chrome.storage.session.get(key))[key];
  if (cur && cur !== tabId) {
    try {
      await chrome.tabs.get(cur);
      return { granted: false };
    } catch {
      // вкладку закрыли — замок свободен
    }
  }
  await chrome.storage.session.set({ [key]: tabId });
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false }); // Chrome не выгружает рабочую вкладку из памяти
  } catch {}
  return { granted: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await chrome.storage.session.get(["lock_serp", "lock_volume"]);
  for (const k of ["lock_serp", "lock_volume"]) if (s[k] === tabId) await chrome.storage.session.remove(k);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "api") return api(msg.action, msg.body || {});
    if (msg.type === "settings") return settings();
    if (msg.type === "claim") return sender.tab ? claim(msg.mode, sender.tab.id) : { granted: false };
    if (msg.type === "status") {
      await chrome.storage.local.set({ [`status_${msg.mode}`]: { text: msg.text, at: Date.now(), tone: msg.tone || "", done: msg.done || 0 } });
      const tone = (await chrome.storage.local.get(["status_serp", "status_volume"]));
      const bad = ["status_serp", "status_volume"].some((k) => tone[k] && tone[k].tone === "bad" && Date.now() - tone[k].at < 600000);
      const run = ["status_serp", "status_volume"].some((k) => tone[k] && tone[k].tone === "run" && Date.now() - tone[k].at < 120000);
      chrome.action.setBadgeText({ text: bad ? "!" : run ? "ON" : "" });
      chrome.action.setBadgeBackgroundColor({ color: bad ? "#d64545" : "#2e9d5b" });
      return { ok: true };
    }
    return { error: "unknown message" };
  })().then(reply, (e) => reply({ ok: false, data: { error: String(e) } }));
  return true;
});
