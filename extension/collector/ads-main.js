// Zewex Collector — часть для Ads Manager, работает в мире страницы (world: MAIN):
// перехват ответа get_audience_sizing_handler (как в прототипе ads-manager.js) и ввод ключа в поле ключевых слов.
// Связь с ads.js — window.postMessage с полем __zxc.

(() => {
  if (window.__zxcAds) return;
  window.__zxcAds = 1;

  const post = (data) => window.postMessage({ __zxc: "sizing", ...data }, location.origin);

  function handle(url, reqBody, text) {
    if (!text || !text.includes("get_audience_sizing_handler")) return;
    try {
      let raw = null;
      try { raw = new URL(url, location.href).searchParams.get("data"); } catch {}
      if (!raw && typeof reqBody === "string") raw = new URLSearchParams(reqBody).get("data");
      const d = JSON.parse(raw || "{}");
      const kws = (d.options && d.options.data && d.options.data.phrase_keywords) || [];
      const re = JSON.parse(text).resource_response.data.reach_estimate;
      post({ kw: kws.join("|"), re: re === undefined ? null : re });
    } catch (e) {
      post({ err: String(e) });
    }
  }

  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__zxcU = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    this.addEventListener("load", () => { try { handle(this.__zxcU, b, this.responseType === "" || this.responseType === "text" ? this.responseText : ""); } catch {} });
    return os.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const r = await of.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && /resource|audience|sizing/i.test(url)) r.clone().text().then((t) => handle(url, init && init.body, t)).catch(() => {});
    } catch {}
    return r;
  };

  /** `__setKw` прототипа: значение через нативный сеттер + input/change/blur, чтобы React заметил. */
  function setKw(v) {
    const t = document.querySelector("textarea");
    if (!t) return false;
    t.focus();
    const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    s.call(t, v);
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));
    t.blur();
    t.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return true;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__zxc !== "setKw") return;
    window.postMessage({ __zxc: "setKwDone", id: e.data.id, ok: setKw(e.data.value) }, location.origin);
  });
})();
