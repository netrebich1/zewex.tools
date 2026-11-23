/**
 * Магазины на платформе Shopify: стандартная открытая лента товаров `/products.json` (по 250 на страницу).
 * На Мальте так сделаны витрины франчайзи: retail.com.mt (Marks & Spencer, Aldo, LC Waikiki, Punt Roma, Geox),
 * hudsonstore.com (Mango, Nike, Tommy Hilfiger, Calvin Klein…), Kiabi, Tezenis, Springfield, Women'secret и другие.
 * Лента несёт всё сразу: бренд, цвета, размеры с наличием, артикул, старую цену. Каждая расцветка — отдельная вещь.
 */
import type { RawItem } from "../consts";
import type { Getter } from "./zara";

/** multi — в ленте несколько брендов (вещь уходит в магазин своего бренда); lang — язык названий, если не английский. */
export type ShopifyConfig = { host: string; multi?: boolean; lang?: string; gender?: string };

type SVariant = { id: number; title?: string; option1?: string | null; option2?: string | null; option3?: string | null; sku?: string | null; price?: string; compare_at_price?: string | null; available?: boolean; featured_image?: { src?: string } | null };
type SProduct = {
  id: number; title?: string; handle?: string; vendor?: string; product_type?: string; tags?: string[] | string; body_html?: string | null; published_at?: string;
  variants?: SVariant[]; options?: Array<{ name?: string; position?: number; values?: string[] }>; images?: Array<{ src?: string; variant_ids?: number[] }>;
};

const PAGE = 250;
/** Не одежда: еда, игрушки, товары для дома, канцелярия (в лентах универмагов их много). */
const NOT_FASHION = /snack|sweet|pantry|food|drink|wine|toy|hobb|bedding|decor|kitchen|dining|bath|body care|stationery|fragrance|candle|home|furniture|gift ?card|book|pet\b|electr|phone|cleaning|laundry|towel/i;
const NOT_FASHION_VENDOR = /^(lego|legami|maped|model toys|jason markk|\+boost)/i;
const SIZE_OPT = /^(size|taglia|taille|talla|gr[oö][sß]e|maat|misura)/i;
const COLOR_OPT = /^(colou?r|couleur|colore|farbe|kleur)/i;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tidy = (s: string) => {
  const t = s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return t === t.toUpperCase() || t === t.toLowerCase() ? t.toLowerCase().replace(/(^|[\s\-/&])([a-zа-яё])/g, (_, a: string, b: string) => a + b.toUpperCase()) : t;
};
const img = (src: string) => `${src}${src.includes("?") ? "&" : "?"}width=600`;

function genderOf(p: SProduct, cfg: ShopifyConfig): string {
  const tags = (Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",")).join(" | ");
  const s = `${tags} | ${p.product_type ?? ""} | ${p.title ?? ""}`;
  if (/\b(kids?|girls?|boys?|bab(y|ies)|bambin[aoi]|ragazz[aoi]|neonat|enfant|junior|infant|toddler)\b/i.test(s)) return "kids";
  const w = /\b(wom[ae]n'?s?|ladies|donna|femme|mujer)\b/i.test(s);
  const m = /\b(m[ae]n'?s?|uomo|homme|hombre)\b/i.test(s);
  return w && !m ? "woman" : m && !w ? "man" : w && m ? "unisex" : (cfg.gender ?? "woman");
}

/** Одна страница ленты → вещи. */
export function shopifyProducts(json: string, cfg: ShopifyConfig): RawItem[] {
  const data = JSON.parse(json) as { products?: SProduct[] };
  const out: RawItem[] = [];
  for (const p of data.products ?? []) {
    const title = (p.title ?? "").trim();
    const variants = p.variants ?? [];
    if (!title || !p.handle || !variants.length || !p.images?.length) continue;
    if (NOT_FASHION.test(p.product_type ?? "") || NOT_FASHION_VENDOR.test(p.vendor ?? "")) continue;
    const opts = [...(p.options ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const sizeIdx = opts.findIndex((o) => SIZE_OPT.test(o.name ?? ""));
    const colorIdx = opts.findIndex((o) => COLOR_OPT.test(o.name ?? ""));
    const opt = (v: SVariant, i: number) => (i < 0 ? "" : String([v.option1, v.option2, v.option3][i] ?? "").trim());
    // «EU 37.5» → «37.5», «4_5» → «4-5» (детские размеры по возрасту).
    const size = (v: SVariant) => opt(v, sizeIdx).toUpperCase().replace(/^(EU|IT|UK)\s+/, "").replace(/_/g, "-");
    const colors = colorIdx >= 0 ? [...new Set(variants.map((v) => opt(v, colorIdx)))] : [""];
    const tags = Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",").map((t) => t.trim());
    const started = p.published_at ? new Date(p.published_at) : null;
    for (const color of colors) {
      const vs = colorIdx >= 0 ? variants.filter((v) => opt(v, colorIdx) === color) : variants;
      const prices = vs.map((v) => Number(v.price)).filter((n) => n > 0);
      if (!prices.length) continue;
      const price = Math.min(...prices);
      const olds = vs.map((v) => Number(v.compare_at_price)).filter((n) => n > price);
      const ids = new Set(vs.map((v) => v.id));
      const own = (p.images ?? []).filter((i) => i.src && (i.variant_ids ?? []).some((id) => ids.has(id))).map((i) => i.src!);
      const all = (p.images ?? []).map((i) => i.src).filter((s): s is string => !!s);
      const imgs = [...new Set([...(vs.map((v) => v.featured_image?.src).filter((s): s is string => !!s)), ...own, ...(colors.length === 1 ? all : [])])];
      const pics = (imgs.length ? imgs : all).slice(0, 4).map(img);
      if (!pics.length) continue;
      // Размеры: опция «Size»; у вещи без размеров (сумка, украшение) — один размер.
      const sized = sizeIdx >= 0;
      const sizesAll = sized ? [...new Set(vs.map(size).filter(Boolean))] : ["ONE SIZE"];
      const sizes = sized ? [...new Set(vs.filter((v) => v.available).map(size).filter(Boolean))] : vs.some((v) => v.available) ? ["ONE SIZE"] : [];
      const sku = String(vs[0].sku ?? "").trim().replace(/[_ ](?:XXS|XS|S|M|L|XL|XXL|3XL|\d{1,3}(?:[.,]5)?(?:_\d)?)$/i, "");
      out.push({
        extId: `sf:${p.id}-${color.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "0"}`,
        name: tidy(title),
        brand: cfg.multi ? tidy(p.vendor ?? "") : undefined,
        lang: cfg.lang,
        url: `https://${cfg.host}/products/${p.handle}${colors.length > 1 ? `?variant=${vs[0].id}` : ""}`,
        imageUrl: pics[0],
        images: pics.slice(1),
        price,
        oldPrice: olds.length ? Math.max(...olds) : null,
        gender: genderOf(p, cfg),
        rawCategory: `${p.product_type ?? ""} | ${tags.filter((t) => t.length < 30 && !/^\d|sync|label|selected|^[A-Z]{2,4}\d{2,4}/i.test(t)).slice(0, 6).join(", ")}`.slice(0, 200),
        colorName: tidy(color.replace(/\s*\(\d+\)\s*$/, "")),
        colorHex: "",
        sizes,
        sizesAll,
        inStock: sizes.length > 0,
        sku,
        description: p.body_html ? text(p.body_html).slice(0, 1500) : "",
        storeDate: started && !Number.isNaN(started.getTime()) ? started : null,
      });
    }
  }
  return out;
}

/** Вся лента магазина; `onBatch` сохраняет страницу сразу. Возвращает число собранных вещей. */
export async function scanShopify(get: Getter, cfg: ShopifyConfig, onProgress?: (done: number, total: number) => void, onBatch?: (items: RawItem[]) => Promise<void>, maxPages = 200): Promise<number> {
  const seen = new Set<string>();
  let failed = 0;
  for (let page = 1; page <= maxPages; page++) {
    let json: string;
    try {
      json = await get(`https://${cfg.host}/products.json?limit=${PAGE}&page=${page}`);
    } catch (e) {
      // Страница не открылась — пробуем дальше; если так несколько раз подряд, сайт нас не пускает.
      if (++failed > 3 || page === 1) throw e;
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    const count = ((JSON.parse(json) as { products?: unknown[] }).products ?? []).length;
    if (!count) break;
    const batch = shopifyProducts(json, cfg).filter((it) => !seen.has(it.extId));
    for (const it of batch) seen.add(it.extId);
    if (batch.length) await onBatch?.(batch);
    onProgress?.(seen.size, seen.size);
    if (count < PAGE) break;
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
  }
  return seen.size;
}
