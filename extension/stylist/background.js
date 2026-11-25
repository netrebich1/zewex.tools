// Zewex Стилист — фоновый скрипт: запросы к порталу с токеном (страницы магазинов сами в портал не ходят).
const DEFAULT_SERVER = "https://zewex.tools";

async function settings() {
  const s = await chrome.storage.local.get(["server", "token"]);
  return { server: (s.server || DEFAULT_SERVER).replace(/\/+$/, ""), token: s.token || "" };
}

/** POST /api/stylist/ext/<action> → { ok, status, data }. */
async function api(action, body) {
  const { server, token } = await settings();
  if (!token) return { ok: false, status: 0, data: { error: "Токен не вставлен. Нажмите на значок расширения и вставьте токен со страницы «Расширение» на zewex.tools." } };
  try {
    const r = await fetch(`${server}/api/stylist/ext/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, version: chrome.runtime.getManifest().version }),
    });
    const data = await r.json().catch(() => ({ error: `Портал ответил ${r.status}` }));
    if (data && typeof data.latest === "string") await chrome.storage.local.set({ latest: data.latest });
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Нет связи с порталом: ${e && e.message ? e.message : e}` } };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "api") return api(msg.action, msg.body || {});
    if (msg.type === "settings") return settings();
    return { ok: false };
  })().then(reply);
  return true;
});
