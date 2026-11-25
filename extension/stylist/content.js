// Zewex Стилист — скрипт на страницах магазинов. Читает только то, что уже показано на открытой странице:
// разметку товара (schema.org / Open Graph), размеры, результат проверки «есть ли в магазинах» (её запускает сам человек
// кнопкой сайта). Ничего не запрашивает у магазина сам и не зависит от страны: город проверки задаётся в окне расширения.
(() => {
  if (window.top !== window || window.__zxStylist) return;
  window.__zxStylist = true;

  const send = (action, body) => chrome.runtime.sendMessage({ type: "api", action, body });
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute("content") || "";
  const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /* ---------- Товар со страницы ---------- */

  function findProduct(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const f = findProduct(n);
        if (f) return f;
      }
      return null;
    }
    const types = arr(node["@type"]).map(String);
    if (types.includes("Product") || types.includes("ProductGroup")) return node;
    return findProduct(node["@graph"]) || findProduct(node.mainEntity);
  }

  function ld() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const p = findProduct(JSON.parse(s.textContent || ""));
        if (p) return p;
      } catch {
        /* битая разметка — берём следующую */
      }
    }
    return null;
  }

  /** Размеры со страницы: кнопки и пункты выбора размера. Зачёркнутые и выключенные — «нет в наличии». */
  function sizesFromDom() {
    const SIZE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-5]XL|\d{2}(?:[.,]5)?|\d{2}\/\d{2}|W\d{2}(?:\s?L\d{2})?|ONE SIZE|OS|U)$/i;
    const all = [], have = [];
    const nodes = document.querySelectorAll('[class*="size" i] button, [class*="size" i] li, [class*="size" i] label, [data-qa-qualifier*="size" i], [data-testid*="size" i], select[name*="size" i] option');
    for (const el of nodes) {
      const text = clean(el.getAttribute("data-size") || el.querySelector?.('[class*="label" i], [class*="name" i]')?.textContent || el.textContent).toUpperCase();
      const label = text.split(" ")[0];
      if (!SIZE.test(text) && !SIZE.test(label)) continue;
      const size = SIZE.test(text) ? text : label;
      if (all.includes(size)) continue;
      const off = el.disabled || el.getAttribute("aria-disabled") === "true" || /disabled|unavailable|out-of-stock|sold-?out|no-stock|is-out/i.test(`${el.className} ${el.getAttribute("data-qa-action") || ""}`) || /out of stock|sold out|нет в наличии|немає/i.test(el.textContent || "");
      all.push(size);
      if (!off) have.push(size);
    }
    return { all, have };
  }

  function product() {
    const p = ld();
    const variants = p ? arr(p.hasVariant) : [];
    const first = variants[0] || p;
    const offers = p ? arr((first && first.offers) || p.offers) : [];
    const offer = offers[0] || {};
    const images = p ? arr(p.image).map((i) => (typeof i === "string" ? i : i && i.url)).filter(Boolean) : [];
    const dom = sizesFromDom();
    // Размеры из разметки (варианты товара), если сайт их отдаёт; иначе — из кнопок на странице.
    const ldAll = variants.map((v) => clean(v.size).toUpperCase()).filter(Boolean);
    const ldHave = variants.filter((v) => !/OutOfStock|SoldOut/i.test(String(arr(v.offers)[0]?.availability || ""))).map((v) => clean(v.size).toUpperCase()).filter(Boolean);
    const price = num(offer.price || offer.lowPrice) || num(meta("product:price:amount") || meta("og:price:amount"));
    const brand = p && p.brand ? clean(typeof p.brand === "string" ? p.brand : p.brand.name) : "";
    let image = images[0] || meta("og:image") || meta("twitter:image");
    if (image && image.startsWith("//")) image = `https:${image}`;
    return {
      url: location.href.split("#")[0],
      name: clean((p && p.name) || meta("og:title") || document.title).slice(0, 300),
      brand,
      price,
      currency: clean(offer.priceCurrency || meta("product:price:currency") || meta("og:price:currency")).toUpperCase(),
      image,
      images: images.slice(1, 4),
      color: clean((first && first.color) || (p && p.color) || ""),
      sku: clean((p && (p.sku || p.mpn || p.productID)) || ""),
      sizes: ldAll.length ? [...new Set(ldHave)] : dom.have,
      sizesAll: ldAll.length ? [...new Set(ldAll)] : dom.all,
      description: clean((p && p.description) || meta("og:description")).slice(0, 2000),
    };
  }

  /* ---------- Окно расширения на странице ---------- */

  const root = document.createElement("div");
  root.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:2147483646;font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;color:#111";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .fab { width: 46px; height: 46px; border-radius: 50%; border: 0; background: #111; color: #ffad0e; font: 700 20px/1 system-ui; cursor: pointer; box-shadow: 0 4px 14px #0005; }
      .panel { display: none; position: absolute; left: 0; bottom: 56px; width: 310px; background: #fff; border: 1px solid #ddd; border-radius: 14px; box-shadow: 0 10px 30px #0004; padding: 12px; }
      .panel.open { display: block; }
      .head { display: flex; gap: 10px; }
      .head img { width: 62px; height: 82px; object-fit: cover; border-radius: 8px; background: #eee; flex: none; }
      .name { font-weight: 600; line-height: 1.25; max-height: 3.8em; overflow: hidden; }
      .sub { color: #666; font-size: 12px; margin-top: 3px; }
      button.b { width: 100%; margin-top: 7px; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; font: inherit; color: #111; }
      button.b.main { background: #111; color: #fff; border-color: #111; }
      button.b:disabled { opacity: .5; cursor: default; }
      select, input { width: 100%; margin-top: 7px; padding: 7px 8px; border-radius: 8px; border: 1px solid #ccc; font: inherit; background: #fff; color: #111; }
      .row { display: flex; gap: 6px; } .row > * { flex: 1; }
      .msg { margin-top: 8px; padding: 6px 8px; border-radius: 8px; font-size: 12px; display: none; }
      .msg.ok { display: block; background: #e7f6ec; color: #15803d; } .msg.bad { display: block; background: #fde7ea; color: #b8323f; }
      .box { margin-top: 9px; padding: 8px; border-radius: 8px; background: #f5f6f8; font-size: 12px; color: #333; }
      .x { position: absolute; right: 8px; top: 6px; border: 0; background: none; font-size: 16px; cursor: pointer; color: #888; }
    </style>
    <div class="panel" id="panel">
      <button class="x" id="close" title="Закрыть">×</button>
      <div class="head"><img id="img" alt="" /><div><div class="name" id="name"></div><div class="sub" id="sub"></div></div></div>
      <div class="row"><button class="b main" id="add">В каталог</button><button class="b" id="fav">♥ В избранное</button></div>
      <select id="look"><option value="">Образ не выбран</option></select>
      <div class="row"><input id="size" placeholder="Нужный размер" /><button class="b main" id="tolook" style="margin-top:7px">В образ</button></div>
      <div class="box" id="stock" style="display:none"></div>
      <div class="msg" id="msg"></div>
    </div>
    <button class="fab" id="fab" title="Zewex Стилист">Z</button>`;
  document.documentElement.appendChild(root);
  const $ = (id) => shadow.getElementById(id);
  const say = (text, ok) => {
    $("msg").textContent = text;
    $("msg").className = `msg ${ok ? "ok" : "bad"}`;
  };

  let current = null;
  async function open() {
    current = product();
    $("img").src = current.image || "";
    $("name").textContent = current.name || "Вещь не распознана — откройте страницу самой вещи";
    $("sub").textContent = [current.price ? `${current.price} ${current.currency}` : "цена не найдена", current.sku && `арт. ${current.sku}`, current.sizesAll.length && `размеры: ${current.sizes.join(" ") || "нет"}`].filter(Boolean).join(" · ");
    $("msg").className = "msg";
    $("panel").classList.add("open");
    const s = await chrome.storage.local.get(["city"]);
    const zara = /(^|\.)zara\.com$/.test(location.hostname);
    $("stock").style.display = "block";
    $("stock").textContent = zara
      ? `Наличие в магазинах: нажмите на странице «Check in-store availability», выберите размер и город${s.city ? ` (${s.city})` : ""} — результат запишется в образ сам.`
      : "Наличие в магазинах: если сайт показывает его на странице вещи, проверьте там и отметьте в образе на zewex.tools — «есть» или «нет».";
    const r = await send("hello", {});
    if (!r.ok) return say(r.data.error || "Нет связи с порталом", false);
    const sel = $("look");
    const keep = sel.value || (await chrome.storage.local.get(["lookId"])).lookId || "";
    sel.innerHTML = '<option value="">Образ не выбран</option>';
    const groups = [...new Set(r.data.looks.map((l) => l.collection))];
    for (const g of groups) {
      const og = document.createElement("optgroup");
      og.label = g || "Без коллекции";
      for (const l of r.data.looks.filter((x) => x.collection === g)) og.appendChild(new Option(l.name, l.id));
      sel.appendChild(og);
    }
    sel.value = keep;
  }

  async function act(to, extra = {}) {
    if (!current) return;
    for (const id of ["add", "fav", "tolook"]) $(id).disabled = true;
    const r = await send("item", { to, product: current, ...extra });
    for (const id of ["add", "fav", "tolook"]) $(id).disabled = false;
    say(r.ok ? r.data.message : r.data.error || "Портал не ответил", r.ok);
    return r;
  }

  $("fab").addEventListener("click", () => ($("panel").classList.contains("open") ? $("panel").classList.remove("open") : open()));
  $("close").addEventListener("click", () => $("panel").classList.remove("open"));
  $("add").addEventListener("click", () => act("add"));
  $("fav").addEventListener("click", () => act("fav"));
  $("tolook").addEventListener("click", async () => {
    const lookId = $("look").value;
    if (!lookId) return say("Выберите образ в списке", false);
    await chrome.storage.local.set({ lookId });
    act("look", { lookId, size: $("size").value.trim() });
  });

  /* ---------- Zara: результат проверки «есть ли в магазинах» ---------- */
  // Человек сам открывает на странице «Check in-store availability», выбирает размеры и город.
  // Мы запоминаем отмеченные размеры и читаем показанный сайтом список магазинов (или «нет поблизости»).
  if (/(^|\.)zara\.com$/.test(location.hostname)) {
    let sizes = [];
    let sent = "";
    document.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest(".product-stock-availability-size-selector-form__button") : null;
      if (!btn) return;
      const form = document.querySelector(".product-stock-availability-size-selector-form__form");
      sizes = form ? [...form.querySelectorAll("input:checked")].map((i) => clean(i.closest("label")?.innerText || document.querySelector(`label[for="${i.id}"]`)?.innerText).toUpperCase()).filter(Boolean) : [];
      sent = "";
    }, true);

    // Подставляем город из настроек расширения в поиск магазинов (дальше человек выбирает подсказку сайта сам).
    const fillCity = async (input) => {
      const { city } = await chrome.storage.local.get(["city"]);
      if (!city || input.value || input.dataset.zxFilled) return;
      input.dataset.zxFilled = "1";
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, city);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const read = () => {
      const box = document.querySelector(".product-stock-availability-store-search__content");
      if (!box) return;
      const input = box.querySelector(".autocomplete__input");
      if (input) fillCity(input);
      const list = box.querySelector(".location-search__list-view");
      if (!list) return;
      const empty = list.querySelector(".e-store-search__empty-state, .zds-empty-state");
      const stores = empty ? [] : [...list.querySelectorAll("li, [role='listitem'], .zds-cell")].map((el) => clean(el.innerText)).filter((t) => t.length > 3);
      if (!empty && !stores.length) return;
      const city = clean(input?.value || "");
      const key = `${location.href}|${sizes.join(",")}|${city}|${stores.join("|")}`;
      if (key === sent) return;
      sent = key;
      current = product();
      send("item", { to: "instore", product: current, sizes, stores: [...new Set(stores)].slice(0, 20), city }).then((r) => {
        $("panel").classList.add("open");
        $("name").textContent = current.name;
        $("img").src = current.image || "";
        say(r.ok ? r.data.message : r.data.error || "Портал не ответил", r.ok);
      });
    };
    new MutationObserver(() => {
      clearTimeout(window.__zxT);
      window.__zxT = setTimeout(read, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
