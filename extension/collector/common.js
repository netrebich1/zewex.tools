// Zewex Collector — общее для content scripts (www.pinterest.com и ads.pinterest.com): связь с фоном, паузы, статус.

const ZXC_PROTOCOL = 1;

/** Таймер через Web Worker: в фоновой вкладке Chrome замедляет setTimeout до раза в минуту, воркер — нет (как `__sleep` прототипа). */
const zxcSleep = (() => {
  let worker = null;
  const cbs = {};
  let id = 0;
  try {
    const blob = new Blob(["onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)"], { type: "text/javascript" });
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (e) => { if (cbs[e.data]) { cbs[e.data](); delete cbs[e.data]; } };
  } catch {
    worker = null;
  }
  return (ms) => new Promise((r) => {
    if (!worker) return setTimeout(r, ms);
    const i = ++id;
    cbs[i] = r;
    worker.postMessage({ id: i, ms });
  });
})();

const zxcSend = (msg) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, data: { error: chrome.runtime.lastError.message, code: "ext" } } : r));
  } catch (e) {
    // расширение обновили/перезагрузили — этот content script больше не нужен
    resolve({ ok: false, data: { error: String(e), code: "ext_gone" } });
  }
});

const zxcApi = (action, body) => zxcSend({ type: "api", action, body });

/** Расширение перезагрузили или удалили: старый content script останавливается (новый придёт с перезагрузкой вкладки). */
const zxcGone = (r) => {
  if (r && r.data && r.data.code === "ext_gone") throw new Error("Zewex Collector: расширение перезагружено, обновите вкладку");
};

/** Статус для окна расширения и для вкладки «Сбор» на портале. tone: run | wait | bad. */
async function zxcStatus(mode, text, tone, done) {
  await zxcSend({ type: "status", mode, text, tone, done });
}

/** Пауза с обратным отсчётом; прерывается, если сбор выключили в окне расширения. Возвращает false, если выключили. */
async function zxcWait(mode, sec, reason, done) {
  const until = Date.now() + sec * 1000;
  while (Date.now() < until) {
    const s = await zxcSend({ type: "settings" });
    zxcGone(s);
    if (!s || !s.enabled || !s.token) return false;
    const left = Math.ceil((until - Date.now()) / 1000);
    await zxcStatus(mode, `${reason} Продолжу через ${left >= 120 ? `${Math.ceil(left / 60)} мин` : `${left} с`}.`, "wait", done);
    await zxcSleep(Math.min(15000, until - Date.now()));
  }
  return true;
}

/** Ждём, пока сбор включён и токен вставлен. */
async function zxcReady(mode, done) {
  for (;;) {
    const s = await zxcSend({ type: "settings" });
    zxcGone(s);
    if (s && s.enabled && s.token) return;
    await zxcStatus(mode, s && s.token ? "Сбор выключен в окне расширения." : "Вставьте токен в окне расширения.", "wait", done);
    await zxcSleep(5000);
  }
}

/** Взять «замок» режима: собирает только одна вкладка. */
async function zxcClaim(mode) {
  for (;;) {
    const r = await zxcSend({ type: "claim", mode });
    zxcGone(r);
    if (r && r.granted) return;
    await zxcSleep(30000); // другая вкладка уже собирает; если её закроют — возьмём замок
  }
}

const zxcJitter = (gapSec) => Math.round(gapSec * (0.8 + Math.random() * 0.7) * 1000); // gapSec 10 → 8–15 с
