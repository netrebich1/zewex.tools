// Окно расширения: токен, адрес портала, включение сбора, состояние вкладок.
const $ = (id) => document.getElementById(id);

function show(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = `msg ${ok ? "ok" : "bad"}`;
}

function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s} с назад` : `${Math.round(s / 60)} мин назад`;
}

async function renderStatus() {
  const s = await chrome.storage.local.get(["status_serp", "status_volume"]);
  for (const mode of ["serp", "volume"]) {
    const st = s[`status_${mode}`];
    if (!st) continue;
    const stale = Date.now() - st.at > 3 * 60_000;
    $(`d_${mode}`).className = `dot ${stale ? "" : st.tone}`;
    $(`s_${mode}`).textContent = `${st.text} (${ago(st.at)}${stale ? " — вкладка закрыта или спит?" : ""})`;
  }
}

/** a < b по частям версии «1.2.3». */
function older(a, b) {
  const pa = String(a).split(".").map((x) => Number(x) || 0), pb = String(b).split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

async function renderVersion() {
  const own = chrome.runtime.getManifest().version;
  const { latest, server } = await chrome.storage.local.get(["latest", "server"]);
  $("ver").textContent = `v${own}`;
  const u = $("update");
  u.textContent = "";
  if (latest && older(own, latest)) {
    u.append(`Есть новая версия v${latest}. Скачайте её: `);
    const a = document.createElement("a");
    a.href = `${(server || "https://zewex.tools").replace(/\/+$/, "")}/pinterest/keywords/guide#update`;
    a.target = "_blank";
    a.textContent = "инструкция по обновлению";
    u.append(a);
  }
}

async function load() {
  renderVersion();
  const s = await chrome.storage.local.get(["server", "token", "enabled"]);
  $("token").value = s.token || "";
  $("server").value = s.server || "https://zewex.tools";
  $("enabled").checked = s.enabled !== false;
  renderStatus();
}

$("save").addEventListener("click", async () => {
  const server = ($("server").value.trim() || "https://zewex.tools").replace(/\/+$/, "");
  const token = $("token").value.trim();
  if (!/^https:\/\//.test(server)) return show("Адрес портала должен начинаться с https://", false);
  await chrome.storage.local.set({ server, token, enabled: $("enabled").checked });
  if (!token) return show("Вставьте токен с вкладки «Сбор» на портале.", false);
  const r = await chrome.runtime.sendMessage({ type: "api", action: "hello", body: { state: "проверка из окна расширения" } });
  if (r && r.ok) show(`Подключено: аккаунт «${r.data.account.name}»${r.data.account.username ? ` (@${r.data.account.username})` : ""}, пауза ${r.data.account.gapSec} с. ${$("enabled").checked ? "Сбор идёт на открытой вкладке Pinterest." : "Сбор выключен."}`, true);
  else show((r && r.data && r.data.error) || "Не получилось связаться с порталом.", false);
});

$("enabled").addEventListener("change", () => chrome.storage.local.set({ enabled: $("enabled").checked }));
$("openPin").addEventListener("click", () => chrome.tabs.create({ url: "https://www.pinterest.com/" }));
$("openAds").addEventListener("click", () => chrome.tabs.create({ url: "https://ads.pinterest.com/" }));
chrome.storage.onChanged.addListener(() => { renderStatus(); renderVersion(); });
load();
