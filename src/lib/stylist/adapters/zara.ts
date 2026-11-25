/**
 * Zara: открытый JSON самого сайта (тот же, что грузит страница каталога): дерево разделов и товары раздела.
 * Каждая расцветка — отдельная вещь. Размеры в списке не приходят — их отдаёт карточка товара (zaraSizes), по запросу.
 */
import type { RawItem } from "../consts";

export type Getter = (url: string) => Promise<string>;
export type ZaraConfig = { path: string };

type ZCat = { id: number; name?: string; sectionName?: string; layout?: string | null; redirectCategoryId?: number | null; seo?: { keyword?: string | null } | null; subcategories?: ZCat[] };
type ZMedia = { type?: string; url?: string };
type ZColor = { id?: string; name?: string; price?: number; oldPrice?: number; availability?: string; xmedia?: ZMedia[]; sizes?: Array<{ name?: string; availability?: string }> };
type ZProduct = {
  id: number; reference?: string; type?: string; kind?: string; name?: string; price?: number; oldPrice?: number; sectionName?: string; familyName?: string; subfamilyName?: string;
  availability?: string; seo?: { keyword?: string; seoProductId?: string; discernProductId?: number };
  detail?: { colors?: ZColor[]; displayReference?: string }; availableColors?: Array<{ colorName?: string; hexColor?: string }>;
};

const GENDER: Record<string, string> = { WOMAN: "woman", MAN: "man", KID: "kids" };
/** Только настоящие типы вещей; подборки, редакционные страницы и срезы («чёрные джинсы») не берём — их вещи есть в основном разделе. */
const TYPES = /^(?:jackets|outerwear|coats|puffers?|blazers|suits|knitwear|sweaters|cardigans|trousers|jeans|dresses|jumpsuits|skirts|shorts|bermudas|tshirts|t-shirts|shirts|tops|body|polos|sweatshirts|co-ords?|tracksuits?|overshirts|shoes|bags|accessories|lingerie|underwear|beachwear|swimwear)(?:-(?:padded|vests|cardigans|sweaters|skorts|socks|jewelry))?$/;
/** Контейнеры «SHOES | BAGS», «ACCESSORIES | JEWELLERY»: товары лежат в их подразделах. */
const CONTAINER = /highlighted|shoes-accessories|accesories-shoes/;

export const zaraImage = (url: string, w = 563) => url.replace("{width}", String(w));

/** Разделы с товарами: только настоящие типы вещей (куртки, брюки…), без подборок. */
export function zaraCategories(json: string): Array<{ id: number; gender: string; keyword: string; name: string }> {
  const data = JSON.parse(json) as { categories?: ZCat[] };
  const out = new Map<number, { id: number; gender: string; keyword: string; name: string }>();
  const add = (c: ZCat, gender: string) => {
    const keyword = c.seo?.keyword ?? "";
    if (c.layout !== "products-category-view" || !TYPES.test(keyword.replace(/^(?:woman|man)-/, ""))) return;
    const id = c.redirectCategoryId || c.id;
    if (!out.has(id)) out.set(id, { id, gender, keyword, name: c.name ?? "" });
  };
  // Типы вещей лежат на 2-м уровне («COLLECTION → JACKETS»); у контейнеров — на уровень глубже.
  const walk = (c: ZCat, gender: string, depth: number) => {
    const container = CONTAINER.test(c.seo?.keyword ?? "");
    if (depth === 2 && !container) add(c, gender);
    else if (depth === 3) add(c, gender);
    if (depth < 2 || (depth === 2 && container)) for (const sub of c.subcategories ?? []) walk(sub, gender, depth + 1);
  };
  for (const top of data.categories ?? []) {
    const gender = GENDER[top.sectionName ?? ""];
    if (gender && gender !== "kids") walk(top, gender, 0);
  }
  return [...out.values()];
}

/** Товары одного раздела. */
export function zaraProducts(json: string, cfg: ZaraConfig, cat: { gender: string; keyword: string; name: string }): RawItem[] {
  const data = JSON.parse(json) as { productGroups?: Array<{ elements?: Array<{ commercialComponents?: ZProduct[] }> }> };
  const out: RawItem[] = [];
  for (const g of data.productGroups ?? []) {
    for (const e of g.elements ?? []) {
      for (const p of e.commercialComponents ?? []) {
        if (p.type !== "Product" || !p.name || !p.seo?.keyword || !p.seo.seoProductId) continue;
        const hexByName = new Map((p.availableColors ?? []).map((c) => [(c.colorName ?? "").toLowerCase(), c.hexColor ?? ""]));
        for (const c of p.detail?.colors ?? []) {
          const price = c.price ?? p.price;
          if (!c.id || !price) continue;
          const imgs = (c.xmedia ?? []).filter((m) => m.type === "image" && m.url).map((m) => zaraImage(m.url!));
          if (!imgs.length) continue;
          const availability = c.availability ?? p.availability ?? "in_stock";
          if (availability === "coming_soon") continue;
          out.push({
            extId: `${p.id}-${c.id}`,
            name: tidy(p.name),
            url: `https://www.zara.com/${cfg.path}/${p.seo.keyword}-p${p.seo.seoProductId}.html?v1=${p.seo.discernProductId ?? p.id}`,
            imageUrl: imgs[0],
            images: imgs.slice(1, 4),
            price: price / 100,
            oldPrice: (c.oldPrice ?? p.oldPrice) ? (c.oldPrice ?? p.oldPrice)! / 100 : null,
            gender: cat.gender,
            rawCategory: `${p.familyName ?? ""} ${p.subfamilyName ?? ""} | ${cat.keyword} | ${cat.name}`.trim(),
            colorName: c.name ?? "",
            colorHex: hexByName.get((c.name ?? "").toLowerCase()) ?? "",
            sizes: null,
            inStock: availability === "in_stock" || availability === "low_on_stock",
            sku: p.detail?.displayReference ? `${p.detail.displayReference}/${c.id}` : "",
            season: /-([IV]20\d\d)$/.exec(p.reference ?? "")?.[1] ?? "",
          });
        }
      }
    }
  }
  return out;
}

/** Размеры расцветки в наличии из карточки товара (url вещи + ajax). null — расцветка не найдена. */
export function zaraSizes(json: string, extId: string): { sizes: string[]; all: string[]; low: string[]; inStock: boolean; price: number | null; oldPrice: number | null } | null {
  const data = JSON.parse(json) as { product?: { detail?: { colors?: ZColor[] } } };
  const colorId = extId.split("-")[1];
  const colors = data.product?.detail?.colors ?? [];
  const c = colors.find((x) => x.id === colorId) ?? (colors.length === 1 ? colors[0] : null);
  if (!c) return null;
  const sizes = (c.sizes ?? []).filter((s) => s.name && (s.availability === "in_stock" || s.availability === "low_on_stock")).map((s) => s.name!.trim());
  const named = (c.sizes ?? []).filter((s) => s.name);
  return { sizes, all: [...new Set(named.map((s) => s.name!.trim()))], low: named.filter((s) => s.availability === "low_on_stock").map((s) => s.name!.trim()), inStock: sizes.length > 0, price: c.price ? c.price / 100 : null, oldPrice: c.oldPrice && c.price && c.oldPrice > c.price ? c.oldPrice / 100 : null };
}

export async function scanZara(get: Getter, cfg: ZaraConfig, onProgress?: (done: number, total: number) => void): Promise<RawItem[]> {
  const cats = zaraCategories(await get(`https://www.zara.com/${cfg.path}/categories?ajax=true`));
  if (!cats.length) throw new Error("Zara не отдала разделы каталога");
  const seen = new Map<string, RawItem>();
  let failed = 0;
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    try {
      for (const it of zaraProducts(await get(`https://www.zara.com/${cfg.path}/category/${cat.id}/products?ajax=true`), cfg, cat)) {
        if (!seen.has(it.extId)) seen.set(it.extId, it);
      }
    } catch (e) {
      // Один раздел не открылся — не бросаем весь сбор; но если так почти везде, это блокировка.
      if (++failed > Math.max(3, cats.length / 3)) throw e;
    }
    onProgress?.(i + 1, cats.length);
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 600));
  }
  return [...seen.values()];
}

const tidy = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t;
};
