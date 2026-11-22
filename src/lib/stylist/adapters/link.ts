/**
 * Вещь по ссылке из любого магазина: читаем разметку страницы товара (schema.org Product и Open Graph).
 * Если магазин не отдаёт страницу скрипту — вещь вносится вручную (название, цена, ссылка на фото).
 */
export type LinkProduct = { name: string; imageUrl: string; images: string[]; price: number | null; currency: string; colorName: string; inStock: boolean };

const meta = (html: string, prop: string) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = re.exec(html);
  return decode(m?.[1] ?? m?.[2] ?? "");
};
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

type Ld = Record<string, unknown>;
const arr = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function findProduct(node: unknown): Ld | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProduct(n);
      if (f) return f;
    }
    return null;
  }
  const o = node as Ld;
  const types = arr(o["@type"] as string | string[]).map(String);
  if (types.includes("Product") || types.includes("ProductGroup")) return o;
  return findProduct(o["@graph"]) ?? findProduct(o["mainEntity"]);
}

export function parseProductPage(html: string): LinkProduct | null {
  let ld: Ld | null = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      ld = findProduct(JSON.parse(m[1].trim()));
    } catch {
      /* битая разметка — пробуем следующую */
    }
    if (ld) break;
  }
  const variant = ld ? (arr(ld["hasVariant"] as Ld | Ld[])[0] ?? ld) : null;
  const offer = variant ? (arr((variant["offers"] ?? ld?.["offers"]) as Ld | Ld[])[0] ?? null) : null;
  const ldImages = ld ? arr(ld["image"] as unknown).map((i) => (typeof i === "string" ? i : String((i as Ld)?.["url"] ?? ""))).filter(Boolean) : [];
  const name = decode(String(ld?.["name"] ?? "")) || meta(html, "og:title") || decode(/<title>([^<]*)/i.exec(html)?.[1] ?? "");
  const image = ldImages[0] || meta(html, "og:image") || meta(html, "twitter:image");
  const priceRaw = String(offer?.["price"] ?? offer?.["lowPrice"] ?? "") || meta(html, "product:price:amount") || meta(html, "og:price:amount");
  const price = priceRaw ? Number(priceRaw.replace(/\s/g, "").replace(",", ".")) : NaN;
  const currency = String(offer?.["priceCurrency"] ?? "") || meta(html, "product:price:currency") || meta(html, "og:price:currency");
  if (!name || !image) return null;
  const availability = String(offer?.["availability"] ?? "");
  return {
    name: name.slice(0, 300),
    imageUrl: image.startsWith("//") ? `https:${image}` : image,
    images: ldImages.slice(1, 4),
    price: Number.isFinite(price) && price > 0 ? price : null,
    currency: currency.toUpperCase().slice(0, 4),
    colorName: decode(String(variant?.["color"] ?? ld?.["color"] ?? "")).slice(0, 80),
    inStock: !/OutOfStock|SoldOut|Discontinued/i.test(availability),
  };
}
