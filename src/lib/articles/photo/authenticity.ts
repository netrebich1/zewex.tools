// Бесплатное определение каталожного источника (порт _shared/photoAuthenticity.ts, 1:1).
// Белый фон намеренно не признак: отбраковывают только инфраструктура ритейлера или несколько листинговых примет.

/** оригинал: photoAuthenticity.ts:1-8 */
const RETAIL_IMAGE_HOSTS = [
  "walmartimages.com",
  "media-amazon.com",
  "ssl-images-amazon.com",
  "scene7.com",
  "cloudfront.net",
  "shopifycdn.com",
];

const PRODUCT_PATH = /(?:^|[\/_-])(product|products|catalog|catalogue|sku|pdp|item|items|listing|merch|commerce)(?:[\/_-]|$)/i;
const PRODUCT_TITLE = /\b(?:shop now|buy now|price|sale|sizes?|size chart|available in|product details|item #|sku|walmart|amazon|marketplace)\b/i;

export interface CatalogueSignal {
  reject: boolean;
  reason: string | null;
}

/** оригинал: photoAuthenticity.ts:22-41 */
export function catalogueSourceSignal(input: {
  sourceDomain?: string | null;
  sourcePageUrl?: string | null;
  imageUrl?: string | null;
  title?: string | null;
}): CatalogueSignal {
  const domain = String(input.sourceDomain || "").toLowerCase();
  const urls = `${input.sourcePageUrl || ""} ${input.imageUrl || ""}`.toLowerCase();
  const title = String(input.title || "");
  const retailerHost = RETAIL_IMAGE_HOSTS.find((host) => domain === host || domain.endsWith(`.${host}`) || urls.includes(`//${host}/`) || urls.includes(`.${host}/`));
  if (retailerHost === "walmartimages.com" || retailerHost === "media-amazon.com" || retailerHost === "ssl-images-amazon.com") {
    return { reject: true, reason: `каталожный источник (${retailerHost})` };
  }
  const pathCue = PRODUCT_PATH.test(urls);
  const titleCue = PRODUCT_TITLE.test(title);
  if (retailerHost && (pathCue || titleCue)) {
    return { reject: true, reason: `каталожная карточка (${retailerHost})` };
  }
  if (pathCue && titleCue) return { reject: true, reason: "каталожная карточка товара" };
  return { reject: false, reason: null };
}
