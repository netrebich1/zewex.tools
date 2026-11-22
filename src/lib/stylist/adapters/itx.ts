/**
 * Бренды Inditex на общей платформе (Massimo Dutti, Bershka, Pull&Bear, Stradivarius, Oysho): открытый JSON сайта.
 * Конфигурация → номер каталога страны → дерево разделов → номера товаров раздела → карточки товаров пачками.
 * Карточка несёт всё сразу: расцветки, размеры с наличием, артикул, фото. Каждая расцветка — отдельная вещь.
 */
import type { RawItem, StoreContacts } from "../consts";
import type { Getter } from "./zara";

export type ItxConfig = { host: string; storeId: string; path: string; gender?: string };

type ICat = { id: number; name?: string; nameEn?: string; type?: string | number; viewCategoryId?: number; subcategories?: ICat[] };
type IMedia = { url?: string; clazz?: number; extraInfo?: { deliveryUrl?: string; url?: string; originalName?: string; productionType?: string } };
type ISize = { sku?: number; name?: string; isBuyable?: boolean; visibilityValue?: string; price?: string; oldPrice?: string | null; country?: string };
type IComp = { composition?: Array<{ name?: string; percentage?: string }> };
type IColor = { id?: string | number; name?: string; image?: { url?: string } | null; sizes?: ISize[] };
type IDetail = { longDescription?: string; composition?: IComp[]; displayReference?: string; reference?: string; colors?: IColor[]; xmedia?: Array<{ path?: string; xmediaItems?: Array<{ medias?: IMedia[] }> }> };
type IProduct = {
  id: number; startDate?: string; name?: string; nameEn?: string; productUrl?: string; productUrlParam?: string; sectionNameEN?: string;
  familyNameEN?: string; familyName?: string; subFamilyNameEN?: string; subFamilyName?: string; detail?: IDetail; bundleProductSummaries?: IProduct[];
};

const BATCH = 20;
/** Больше разделов не обходим: дальше идут срезы тех же вещей. */
const MAX_CATS = 160;
/** Подборки и служебные пункты меню: товары из них есть в разделах-типах. */
const SKIP = /footer|seo\b|recommended|special projects|hidden|influencer|collab|promotion|beauty|perfume|home\b|gift card|new in|new arrivals|selection|edit\b|edition|lookbook|gift|divider|collection|trend|best ?sellers?|special prices|sale|join life|stores?|help|newsletter|personal tailoring|paper|about|magazine|campaign|^view all$/i;

const api = (cfg: ItxConfig, v: number, catalogId: string) => `https://www.${cfg.host}/itxrest/${v}/catalog/store/${cfg.storeId}/${catalogId}`;

const genderOf = (name: string): string | null => (/^(wom[ae]n|mujer|ladies)\b/i.test(name.trim()) ? "woman" : /^(m[ae]n|hombre)\b/i.test(name.trim()) ? "man" : null);

/**
 * Разделы с товарами. Меню у брендов разной глубины (Massimo Dutti: WOMAN → JACKETS; Bershka: WOMAN → Highlight → Jackets),
 * поэтому идём вниз до листьев: у раздела с «VIEW ALL» берём его целиком, иначе спускаемся в подразделы.
 */
export function itxCategories(json: string, cfg: ItxConfig): Array<{ id: number; gender: string; name: string }> {
  const data = JSON.parse(json) as { categories?: ICat[] };
  const out = new Map<number, { id: number; gender: string; name: string }>();
  const nameOf = (c: ICat) => (c.nameEn || c.name || "").replace(/\s+/g, " ").trim();
  const walk = (c: ICat, gender: string, depth: number, parent: string) => {
    const name = nameOf(c);
    const subs = c.subcategories ?? [];
    const viewAll = c.viewCategoryId && c.viewCategoryId > 0 ? c.viewCategoryId : subs.find((x) => /^view all$/i.test(nameOf(x)))?.id;
    if (viewAll) {
      if (!SKIP.test(name) && !out.has(viewAll)) out.set(viewAll, { id: viewAll, gender, name });
      return;
    }
    if (subs.length && depth < 4) {
      for (const x of subs) walk(x, gender, depth + 1, name);
      return;
    }
    if (!name || name.length < 3 || SKIP.test(name) || out.size >= MAX_CATS) return;
    if (!out.has(c.id)) out.set(c.id, { id: c.id, gender, name: /^(all|view all|see all)$/i.test(name) ? parent : `${name}${parent && !SKIP.test(parent) ? ` | ${parent}` : ""}` });
  };
  for (const c of data.categories ?? []) {
    // У брендов только для женщин (Stradivarius, Oysho) корня «WOMAN» нет: разделы лежат сразу в меню.
    const gender = genderOf(nameOf(c)) ?? cfg.gender ?? "woman";
    if (/kid|boy|girl|baby|home/i.test(nameOf(c))) continue;
    for (const x of c.subcategories ?? []) walk(x, gender, 1, "");
  }
  return [...out.values()];
}

const tidy = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t;
};

/** Остатки по размерам: номер размера (sku) → in_stock | low_on_stock | out_of_stock | … */
export function itxStock(json: string): Map<number, string> {
  const data = JSON.parse(json) as { stocks?: Array<{ stocks?: Array<{ id?: number; availability?: string }> }> };
  const out = new Map<number, string>();
  for (const p of data.stocks ?? []) for (const s of p.stocks ?? []) if (s.id != null) out.set(s.id, s.availability ?? "");
  return out;
}

const DAYS = ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Обычные магазины бренда в стране (официальный список сайта): адрес, телефон, часы. */
export function itxStores(json: string): StoreContacts {
  type S = { name?: string; addressLines?: string[]; city?: string; zipCode?: string; phones?: string[]; openingHours?: { schedule?: Array<{ weekdays?: number[]; timeStripList?: Array<{ initHour?: string; endHour?: string }> }> } };
  const data = JSON.parse(json) as { closerStores?: S[]; stores?: S[] };
  const hours = (s: S) => (s.openingHours?.schedule ?? []).map((x) => {
    const d = [...(x.weekdays ?? [])].sort((a, b) => a - b);
    const days = d.length > 2 && d[d.length - 1] - d[0] === d.length - 1 ? `${DAYS[d[0]]}–${DAYS[d[d.length - 1]]}` : d.map((n) => DAYS[n]).join(", ");
    return `${days} ${(x.timeStripList ?? []).map((t) => `${t.initHour}–${t.endHour}`).join(", ")}`;
  }).join("; ");
  return {
    branches: (data.closerStores ?? data.stores ?? []).map((s) => ({
      name: tidy(s.name ?? ""),
      address: [...(s.addressLines ?? []), s.zipCode, s.city].filter(Boolean).map((x) => tidy(String(x))).join(", "),
      phone: (s.phones ?? []).filter(Boolean).map((p) => (/^\+/.test(p) ? p : `+${p}`).replace(/\s+/g, " ")).join(", "),
      email: "",
      hours: hours(s),
      note: "по данным сайта магазина",
    })),
  };
}

/** Карточки товаров → вещи. `hint` — раздел, где товар найден, и пол раздела; `stock` — остатки (нет — по признаку «можно купить»). */
export function itxProducts(json: string, cfg: ItxConfig, hint: (id: number) => { name: string; gender: string } | undefined, stock: Map<number, string> | null = null): RawItem[] {
  const data = JSON.parse(json) as { products?: IProduct[] };
  const out: RawItem[] = [];
  for (const p of data.products ?? []) {
    const s = p.bundleProductSummaries?.[0] ?? p;
    const detail = s.detail ?? p.detail;
    const name = (p.name || s.name || "").trim();
    const slug = p.productUrl || s.productUrl;
    if (!detail?.colors?.length || !name || !slug) continue;
    const h = hint(p.id);
    const section = p.sectionNameEN ?? "";
    const gender = /wom|muj|lad/i.test(section) ? "woman" : /\bm[ae]n|hom/i.test(section) ? "man" : /kid|boy|girl|baby/i.test(section) ? "kids" : (h?.gender ?? cfg.gender ?? "woman");
    for (const c of detail.colors) {
      if (c.id == null) continue;
      const sizes = (c.sizes ?? []).filter((z) => z.name);
      const prices = sizes.map((z) => Number(z.price)).filter((n) => n > 0);
      if (!prices.length) continue;
      const price = Math.min(...prices) / 100;
      const olds = sizes.map((z) => Number(z.oldPrice)).filter((n) => n > 0);
      const state = (z: ISize) => (stock && z.sku != null && stock.has(z.sku) ? stock.get(z.sku)! : z.isBuyable && (z.visibilityValue ?? "SHOW") === "SHOW" ? "in_stock" : "out_of_stock");
      const inStock = [...new Set(sizes.filter((z) => /^(in_stock|low_on_stock)$/.test(state(z))).map((z) => z.name!.trim()))];
      const low = [...new Set(sizes.filter((z) => state(z) === "low_on_stock").map((z) => z.name!.trim()))];
      const all = [...new Set(sizes.map((z) => z.name!.trim()))];
      const refDigits = (detail.reference ?? "").split("-")[0];
      const medias = ((detail.xmedia ?? []).find((x) => x.path === c.image?.url)?.xmediaItems?.[0]?.medias ?? [])
        .map((m) => ({ url: m.extraInfo?.deliveryUrl || m.url || "", name: m.extraInfo?.originalName ?? "", swatch: m.clazz === 2, model: m.extraInfo?.productionType === "MODEL" }))
        .filter((m) => /^https:.*\.(jpe?g|png|webp)/i.test(m.url))
        // Чужие картинки в наборе (рекламный баннер коллекции) узнаются по чужому артикулу в адресе.
        .filter((m) => !refDigits || m.url.includes(refDigits));
      // Главное фото — сама вещь на чистом фоне (p, a1t…), потом остальные предметные, потом на модели; образец цвета — никогда.
      const rank = (m: { name: string; swatch: boolean; model: boolean }) => (m.swatch ? 9 : /^p\d*$/.test(m.name) ? 0 : /^a1/.test(m.name) ? 1 : m.model ? 4 : /^(z|v|a\d+d)/.test(m.name) ? 3 : 2);
      const sorted = [...medias].sort((a, b) => rank(a) - rank(b));
      const usable = sorted.some((m) => !m.swatch) ? sorted.filter((m) => !m.swatch) : sorted;
      const imgs = [...new Set(usable.map((m) => m.url))].map((u) => `${u}${u.includes("?") ? "&" : "?"}w=600`);
      if (!imgs.length) continue;
      const ref = detail.displayReference || (detail.reference ?? "").split("-")[0];
      const season = /-([IV]20\d\d)$/.exec(detail.reference ?? "")?.[1] ?? "";
      const composition = [...new Set((detail.composition ?? []).flatMap((x) => x.composition ?? []).filter((x) => x.name).map((x) => `${x.name} ${x.percentage ?? ""}%`.replace(" %", "")))].join(", ");
      const started = p.startDate ? new Date(p.startDate) : null;
      out.push({
        extId: `${p.id}-${c.id}`,
        name: tidy(name),
        url: `https://www.${cfg.host}/${cfg.path}/${slug}${slug.includes("?") ? "&" : "?"}${slug.includes(".html") ? `colorId=${c.id}` : `pelement=${p.productUrlParam ?? p.id}&colorId=${c.id}`}`,
        imageUrl: imgs[0],
        images: imgs.slice(1, 4),
        price,
        oldPrice: olds.length ? Math.max(...olds) / 100 : null,
        gender,
        rawCategory: `${p.familyNameEN ?? p.familyName ?? ""} ${p.subFamilyNameEN ?? p.subFamilyName ?? ""} | ${h?.name ?? ""}`.trim(),
        colorName: tidy(c.name ?? ""),
        colorHex: "",
        sizes: inStock,
        sizesAll: all,
        sizesLow: low,
        inStock: inStock.length > 0,
        sku: ref ? `${ref}/${c.id}` : "",
        season,
        composition,
        description: (detail.longDescription ?? "").trim(),
        madeIn: tidy(sizes.find((z) => z.country)?.country ?? ""),
        storeDate: started && !Number.isNaN(started.getTime()) && started.getFullYear() > 2015 ? started : null,
      });
    }
  }
  return out;
}

export async function scanItx(get: Getter, cfg: ItxConfig, onProgress?: (done: number, total: number) => void, limit = Infinity): Promise<RawItem[]> {
  const conf = JSON.parse(await get(`https://www.${cfg.host}/itxrest/2/web/seo/config?appId=1`)) as { seoCatalogMap?: Record<string, string[]> };
  const catalogId = conf.seoCatalogMap?.[cfg.storeId]?.[0];
  if (!catalogId) throw new Error(`${cfg.host}: в конфигурации сайта нет каталога для магазина ${cfg.storeId}`);
  const cats = itxCategories(await get(`${api(cfg, 2, catalogId)}/category?languageId=-1&typeCatalog=1&appId=1`), cfg);
  if (!cats.length) throw new Error(`${cfg.host}: сайт не отдал разделы каталога`);
  const where = new Map<number, { name: string; gender: string }>();
  for (const cat of cats) {
    try {
      const r = JSON.parse(await get(`${api(cfg, 3, catalogId)}/category/${cat.id}/product?languageId=-1&appId=1&showProducts=false`)) as { productIds?: number[] };
      for (const id of r.productIds ?? []) if (!where.has(id)) where.set(id, cat);
    } catch {
      // Раздел без товаров (страница-витрина) — пропускаем.
    }
    await pause();
    if (where.size >= limit) break;
  }
  const ids = [...where.keys()].slice(0, limit);
  if (!ids.length) throw new Error(`${cfg.host}: в разделах нет товаров`);
  const seen = new Map<string, RawItem>();
  let failed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const part = ids.slice(i, i + BATCH).join(",");
      const json = await get(`${api(cfg, 3, catalogId)}/productsArray?productIds=${part}&languageId=-1&appId=1`);
      // Остатки по размерам — отдельным лёгким запросом; не ответил — берём признак «можно купить» из карточки.
      const stock = await get(`${api(cfg, 2, catalogId)}/product/stock?productIds=${part}&languageId=-1&appId=1`).then(itxStock).catch(() => null);
      for (const it of itxProducts(json, cfg, (id) => where.get(id), stock)) if (!seen.has(it.extId)) seen.set(it.extId, it);
    } catch (e) {
      // Отказ на середине — сайт просит сбавить темп: ждём минуту и идём дальше (пачка доберётся при следующем сборе).
      if (++failed > Math.max(6, ids.length / BATCH / 4)) throw e;
      await new Promise((r) => setTimeout(r, 60_000));
    }
    onProgress?.(Math.min(i + BATCH, ids.length), ids.length);
    await pause();
  }
  return [...seen.values()];
}

/** Одна карточка товара со свежими остатками — для кнопки «Проверить размеры». */
export async function fetchItxProduct(get: Getter, cfg: ItxConfig, productId: string): Promise<RawItem[]> {
  const conf = JSON.parse(await get(`https://www.${cfg.host}/itxrest/2/web/seo/config?appId=1`)) as { seoCatalogMap?: Record<string, string[]> };
  const catalogId = conf.seoCatalogMap?.[cfg.storeId]?.[0];
  if (!catalogId) return [];
  const json = await get(`${api(cfg, 3, catalogId)}/productsArray?productIds=${productId}&languageId=-1&appId=1`);
  const stock = await get(`${api(cfg, 2, catalogId)}/product/stock?productIds=${productId}&languageId=-1&appId=1`).then(itxStock).catch(() => null);
  return itxProducts(json, cfg, () => undefined, stock);
}

/** Магазины бренда на Мальте (центр острова, до 30 ближайших в стране). */
export async function fetchItxStores(get: Getter, cfg: ItxConfig, countryCode: string): Promise<StoreContacts | null> {
  try {
    const c = itxStores(await get(`https://www.${cfg.host}/itxrest/2/bam/store/${cfg.storeId}/physical-store?latitude=35.9122&longitude=14.5042&countryCode=${countryCode}&max=30&appId=1&languageId=-1`));
    return c.branches?.length ? c : null;
  } catch {
    return null;
  }
}

/** Темп: около одной пачки в 3 секунды — быстрее Pull&Bear начинал отвечать отказом (22.11.2026). */
const pause = () => new Promise((r) => setTimeout(r, 1300 + Math.random() * 900));
