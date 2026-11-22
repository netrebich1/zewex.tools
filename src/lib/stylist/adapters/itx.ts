/**
 * Бренды Inditex на общей платформе (Massimo Dutti, Bershka, Pull&Bear, Stradivarius, Oysho): открытый JSON сайта.
 * Конфигурация → номер каталога страны → дерево разделов → номера товаров раздела → карточки товаров пачками.
 * Карточка несёт всё сразу: расцветки, размеры с наличием, артикул, фото. Каждая расцветка — отдельная вещь.
 */
import type { RawItem } from "../consts";
import type { Getter } from "./zara";

export type ItxConfig = { host: string; storeId: string; path: string; gender?: string };

type ICat = { id: number; name?: string; nameEn?: string; type?: string | number; viewCategoryId?: number; subcategories?: ICat[] };
type IMedia = { url?: string; extraInfo?: { deliveryUrl?: string; url?: string } };
type ISize = { name?: string; isBuyable?: boolean; visibilityValue?: string; price?: string; oldPrice?: string | null };
type IColor = { id?: string | number; name?: string; image?: { url?: string } | null; sizes?: ISize[] };
type IDetail = { displayReference?: string; reference?: string; colors?: IColor[]; xmedia?: Array<{ path?: string; xmediaItems?: Array<{ medias?: IMedia[] }> }> };
type IProduct = {
  id: number; name?: string; nameEn?: string; productUrl?: string; productUrlParam?: string; sectionNameEN?: string;
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

/** Карточки товаров → вещи. `hint` — раздел, где товар найден, и пол раздела. */
export function itxProducts(json: string, cfg: ItxConfig, hint: (id: number) => { name: string; gender: string } | undefined): RawItem[] {
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
      const inStock = [...new Set(sizes.filter((z) => z.isBuyable && (z.visibilityValue ?? "SHOW") === "SHOW").map((z) => z.name!.trim()))];
      const medias = (detail.xmedia ?? []).find((x) => x.path === c.image?.url)?.xmediaItems?.flatMap((i) => i.medias ?? []) ?? [];
      const imgs = [...new Set(medias.map((m) => m.extraInfo?.deliveryUrl || m.url || "").filter((u) => /^https:.*\.(jpe?g|png|webp)/i.test(u)))].map((u) => `${u}${u.includes("?") ? "&" : "?"}w=600`);
      if (!imgs.length) continue;
      const ref = detail.displayReference || (detail.reference ?? "").split("-")[0];
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
        inStock: inStock.length > 0,
        sku: ref ? `${ref}/${c.id}` : "",
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
      const json = await get(`${api(cfg, 3, catalogId)}/productsArray?productIds=${ids.slice(i, i + BATCH).join(",")}&languageId=-1&appId=1`);
      for (const it of itxProducts(json, cfg, (id) => where.get(id))) if (!seen.has(it.extId)) seen.set(it.extId, it);
    } catch (e) {
      if (++failed > Math.max(3, ids.length / BATCH / 4)) throw e;
    }
    onProgress?.(Math.min(i + BATCH, ids.length), ids.length);
    await pause();
  }
  return [...seen.values()];
}

const pause = () => new Promise((r) => setTimeout(r, 350 + Math.random() * 350));
