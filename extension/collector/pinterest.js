// Zewex Collector — сбор выдачи на www.pinterest.com.
// Запросы те же, что в прототипе (docs/keyword-research/prototype/serp-analyze.js): BaseSearchResource, UserResource,
// AdvancedTypeaheadResource с x-csrftoken и x-pinterest-pws-handler. Ответы уходят на портал СЫРЫМИ — разбирает сервер.

(() => {
  if (window.top !== window) return; // только основная страница, не iframe
  const MODE = "serp";

  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1];
  const H = (src, h) => ({
    "x-requested-with": "XMLHttpRequest", "x-csrftoken": csrf(), "x-pinterest-source-url": src, "x-pinterest-pws-handler": h,
    accept: "application/json, text/javascript, */*, q=0.01",
  });

  /** GET /resource/<name>/get/ → { status, body, ms } (body — JSON как есть или null). */
  async function resource(name, src, handler, options) {
    const t0 = performance.now();
    const r = await fetch(`/resource/${name}/get/?source_url=${encodeURIComponent(src)}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}&_=${Date.now()}`, { headers: H(src, handler), credentials: "include" });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body, ms: Math.round(performance.now() - t0) };
  }

  const search = (q) => {
    const src = `/search/pins/?q=${encodeURIComponent(q)}&rs=typed`;
    return resource("BaseSearchResource", src, "www/search/[scope].js", {
      query: q, scope: "pins", rs: "typed", redux_normalize_feed: true, source_url: src, page_size: 25, appliedProductFilters: "---", article: null,
      auto_correction_disabled: false, corpus: null, customized_rerank_type: null, filters: null, top_pin_id: "", query_pin_sigs: null,
    });
  };
  const typeahead = (q) => resource("AdvancedTypeaheadResource", "/search/pins/?q=x", "www/search/[scope].js", { pin_scope: "pins", count: 10, term: q, no_fetch_context_on_resource: false });
  const user = (u) => resource("UserResource", `/${u}/`, "www/[username].js", { username: u, field_set_key: "profile" });

  /** Логин аккаунта, открытого в браузере: из данных страницы, иначе UserSettingsResource. null — не вошли или не узнали. */
  let me = { name: null, at: 0 };
  async function username() {
    if (me.name && Date.now() - me.at < 30 * 60_000) return me.name;
    const pick = (o) => o && typeof o.username === "string" && o.username ? o.username : null;
    for (const id of ["__PWS_INITIAL_PROPS__", "__PWS_DATA__"]) {
      try {
        const el = document.getElementById(id);
        if (!el) continue;
        const d = JSON.parse(el.textContent || "{}");
        const p = d.props || d;
        const name = pick(p.context && p.context.user) || pick(d.context && d.context.user) || pick(p.initialReduxState && p.initialReduxState.viewer) || null;
        if (name) { me = { name, at: Date.now() }; return name; }
      } catch {}
    }
    try {
      const r = await resource("UserSettingsResource", "/settings/", "www/settings/[section].js", {});
      const name = pick(r.body && r.body.resource_response && r.body.resource_response.data);
      if (name) { me = { name, at: Date.now() }; return name; }
    } catch {}
    return null;
  }

  async function run() {
    await zxcClaim(MODE);
    let done = 0;
    let greeted = false;
    for (;;) {
      await zxcReady(MODE, done);
      const login = await username();
      if (!greeted) {
        const h = await zxcApi("hello", { username: login, state: "запуск" });
        if (!h.ok) { await zxcWait(MODE, h.status === 409 ? 300 : 60, h.data.error || "Портал не принял расширение.", done); continue; }
        if (h.data.protocol > ZXC_PROTOCOL) { await zxcWait(MODE, 600, "Портал ждёт новую версию расширения — обновите папку extension/collector.", done); continue; }
        // Логин не узнали со страницы: работаем, только если он вписан у аккаунта на вкладке «Сбор» вручную.
        if (!login && !h.data.account.username) {
          await zxcWait(MODE, 60, "Не удалось узнать аккаунт Pinterest. Проверьте, что вход выполнен, или впишите логин на вкладке «Сбор» → «Настроить».", done);
          continue;
        }
        greeted = true;
      }
      const n = await zxcApi("next", { mode: MODE, username: login, state: `выдача: жду задание (снято ${done})` });
      if (!n.ok) {
        const st = n.status === 409 || n.status === 401 || n.status === 403 ? "bad" : "wait";
        await zxcStatus(MODE, n.data.error || "Ошибка портала.", st, done);
        await zxcWait(MODE, st === "bad" ? 300 : 60, n.data.error || "Ошибка портала.", done);
        greeted = false;
        continue;
      }
      if (!n.data.task) { await zxcWait(MODE, Math.min(n.data.wait || 60, 900), n.data.reason || "Заданий нет.", done); continue; }

      const task = n.data.task;
      const q = task.phrase.toLowerCase();
      await zxcStatus(MODE, `Снимаю выдачу: «${task.phrase}» (в очереди ещё ${n.data.left ?? "?"})`, "run", done);
      let res;
      try {
        res = await search(q);
      } catch (e) {
        await zxcApi("fail", { kind: MODE, taskId: task.id, error: `запрос не ушёл: ${e && e.message ? e.message : e}` });
        await zxcWait(MODE, 60, "Запрос к Pinterest не ушёл (сеть?).", done);
        continue;
      }
      const s = await zxcApi("search", { taskId: task.id, status: res.status, body: res.body, ms: res.ms, state: `выдача: «${task.phrase}»` });
      if (!s.ok) { await zxcWait(MODE, 30, s.data.error || "Портал не принял выдачу.", done); continue; }
      if (s.data.pause) {
        await zxcStatus(MODE, s.data.reason, "bad", done);
        await zxcWait(MODE, Math.min(s.data.pause, 900), s.data.reason, done);
        continue;
      }
      const pinners = {};
      for (const u of s.data.pinners || []) {
        try { pinners[u] = await user(u); } catch (e) { pinners[u] = { error: String(e && e.message ? e.message : e) }; }
        await zxcSleep(400);
      }
      let ta = null;
      if (s.data.typeahead) {
        try { ta = await typeahead(q); } catch (e) { ta = { error: String(e && e.message ? e.message : e) }; }
      }
      const f = await zxcApi("finish", { taskId: task.id, pinners, typeahead: ta, state: `выдача: «${task.phrase}» готово` });
      if (f.ok) done++;
      const gap = zxcJitter((f.ok && f.data.gapSec) || n.data.gapSec || 10);
      await zxcStatus(MODE, f.ok ? `«${task.phrase}»: ${f.data.n} пинов. Снято за сеанс: ${done}.` : f.data.error || "Портал не принял снимок.", f.ok ? "run" : "bad", done);
      await zxcSleep(gap);
    }
  }

  run();
})();
