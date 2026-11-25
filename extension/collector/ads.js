// Zewex Collector — частотность в Ads Manager (ads.pinterest.com, открытый черновик кампании, US).
// Как `__vol` прототипа: вписываем "ключ" в нижнем регистре в поле ключевых слов и ждём перехваченный reach_estimate
// (ads-main.js). Прямой повтор запроса даёт 403, поэтому только через поле.

(() => {
  if (window.top !== window) return;
  const MODE = "volume";
  const TIMEOUT_MS = 8000;
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

  const sizes = [];
  const waiters = {};
  let seq = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__zxc === "sizing") sizes.push(e.data);
    if (e.data.__zxc === "setKwDone" && waiters[e.data.id]) { waiters[e.data.id](e.data.ok); delete waiters[e.data.id]; }
  });
  const setKw = (value) => new Promise((resolve) => {
    const id = ++seq;
    waiters[id] = resolve;
    window.postMessage({ __zxc: "setKw", id, value }, location.origin);
    setTimeout(() => { if (waiters[id]) { delete waiters[id]; resolve(false); } }, 3000);
  });

  async function volume(phrase) {
    const lk = norm(phrase);
    sizes.length = 0;
    const t0 = Date.now();
    if (!(await setKw(`"${lk}"`))) return { error: "на странице нет поля ключевых слов" };
    while (Date.now() - t0 < TIMEOUT_MS) {
      const h = sizes.filter((x) => x.kw && norm(x.kw.replace(/^"|"$/g, "")) === lk).pop() || sizes.filter((x) => x.kw && norm(x.kw) === `"${lk}"`).pop();
      if (h) return { reach: h.re, ms: Date.now() - t0 };
      await zxcSleep(300);
    }
    return { error: `Ads Manager не ответил за ${TIMEOUT_MS / 1000} с`, ms: Date.now() - t0 };
  }

  async function run() {
    await zxcClaim(MODE);
    let done = 0;
    for (;;) {
      await zxcReady(MODE, done);
      if (!document.querySelector("textarea")) {
        await zxcWait(MODE, 15, "Откройте черновик кампании (US) с полем ключевых слов.", done);
        continue;
      }
      const n = await zxcApi("next", { mode: MODE, state: `частотность: жду задание (снято ${done})` });
      if (!n.ok) { await zxcWait(MODE, 60, n.data.error || "Ошибка портала.", done); continue; }
      if (!n.data.task) { await zxcWait(MODE, Math.min(n.data.wait || 60, 900), n.data.reason || "Заданий нет.", done); continue; }
      const task = n.data.task;
      await zxcStatus(MODE, `Частотность: «${task.phrase}» (в очереди ещё ${n.data.left ?? "?"})`, "run", done);
      const r = await volume(task.phrase);
      const v = await zxcApi("volume", { taskId: task.id, ...r, state: `частотность: «${task.phrase}»` });
      if (v.ok && v.data.ok) done++;
      await zxcStatus(MODE, v.ok && v.data.ok ? `«${task.phrase}»: ${v.data.none ? "нет данных" : Number(v.data.estimate).toLocaleString("ru-RU")}. Снято за сеанс: ${done}.` : r.error || v.data.error || "ошибка", v.ok && v.data.ok ? "run" : "bad", done);
      await zxcSleep(1000 + Math.round(Math.random() * 1500));
    }
  }

  run();
})();
