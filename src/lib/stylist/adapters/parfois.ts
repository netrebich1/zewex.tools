/**
 * Parfois (Salesforce Commerce): обычные страницы каталога. Раздел → номер раздела (cgid) → плитки товаров порциями.
 * Плитка несёт название, цену, раздел и фото; размеры в списке не приходят.
 */
import type { RawItem } from "../consts";
import type { Getter } from "./zara";

export type ParfoisConfig = { path: string; locale: string; country: string };

const SECTIONS = ["bags", "clothing", "shoes", "jewellery", "accessories", "wallets", "watches", "sunglasses"];
const PAGE = 48;

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Плитки одной страницы списка. */
export function parfoisTiles(html: string, cfg: ParfoisConfig): RawItem[] {
  const out: RawItem[] = [];
  const parts = html.split(/class="product js_product"/).slice(1);
  for (const part of parts) {
    const pid = /data-pid="([^"]+)"/.exec(part)?.[1];
    const gtmRaw = /data-gtmeventdata="([^"]+)"/.exec(part)?.[1] ?? /data-gtmdata="([^"]+)"/.exec(part)?.[1];
    // «Shop the look» — готовые образы магазина, не вещи.
    if (!pid || !gtmRaw || pid.startsWith("STL_")) continue;
    let g: { item_name?: string; price?: number; item_category?: string; item_category2?: string; item_category3?: string } | undefined;
    try {
      g = (JSON.parse(unescape(gtmRaw)) as { ecommerce?: { items?: Array<typeof g> } }).ecommerce?.items?.[0];
    } catch {
      continue;
    }
    if (!g?.item_name || !g.price || g.item_category === "looks") continue;
    let images: Array<{ url?: string; title?: string }> = [];
    const imgRaw = /var images = "(\[.*?\])";/.exec(part)?.[1];
    if (imgRaw) {
      try { images = JSON.parse(unescape(imgRaw)); } catch { /* фото возьмём из тега img */ }
    }
    const urls = images.map((i) => i.url).filter((u): u is string => !!u).map((u) => u.replace(/\?sw=\d+/, "?sw=600"));
    const imgTag = /<img[^>]+(?:data-src|src)="(https:[^"]+\.jpg[^"]*)"/.exec(part)?.[1];
    if (!urls.length && imgTag) urls.push(unescape(imgTag));
    if (!urls.length) continue;
    const href = /href="(\/[^"]+\.html)[^"]*"/.exec(part)?.[1];
    // Подпись фото: «Название, Цвет» — отсюда точное название цвета.
    const title = images[0]?.title ?? "";
    const colorName = title.startsWith(g.item_name) ? title.slice(g.item_name.length).replace(/^[,\s]+/, "") : "";
    const cats = [g.item_category, g.item_category2, g.item_category3].filter((c) => c && c !== "n/a").join(" | ");
    out.push({
      // Одна расцветка встречается в списке несколько раз с хвостом «-2», «-3» (другое главное фото).
      extId: pid.replace(/-\d+$/, ""),
      name: g.item_name.trim(),
      url: href ? `https://www.parfois.com${unescape(href)}` : `https://www.parfois.com/${cfg.path}/search?q=${encodeURIComponent(pid)}`,
      imageUrl: urls[0],
      images: urls.slice(1, 4),
      price: g.price,
      oldPrice: null,
      gender: "woman",
      rawCategory: cats,
      colorName,
      colorHex: "",
      sizes: null,
      inStock: !/sold-out|out-of-stock|js_soldout/i.test(part.slice(0, 600)),
    });
  }
  return out;
}

export async function scanParfois(get: Getter, cfg: ParfoisConfig, onProgress?: (done: number, total: number) => void): Promise<RawItem[]> {
  const seen = new Map<string, RawItem>();
  let opened = 0;
  for (let i = 0; i < SECTIONS.length; i++) {
    try {
      const first = await get(`https://www.parfois.com/${cfg.path}/${SECTIONS[i]}/`);
      const cgid = /Search-UpdateGrid\?cgid=([^&"]+)/.exec(first)?.[1];
      if (cgid) {
        opened++;
        for (let start = 0; start < 3000; start += PAGE) {
          const html = await get(`https://www.parfois.com/on/demandware.store/Sites-PAR_World-Site/${cfg.locale}/Search-UpdateGrid?cgid=${cgid}&prefn1=onlineForCountries&prefv1=ALL%7C${cfg.country}&start=${start}&sz=${PAGE}`);
          const tiles = parfoisTiles(html, cfg);
          let fresh = 0;
          for (const t of tiles) if (!seen.has(t.extId)) { seen.set(t.extId, t); fresh++; }
          if (tiles.length < PAGE / 2 || !fresh) break;
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
        }
      }
    } catch {
      // Раздела может не быть в этой стране — идём дальше.
    }
    onProgress?.(i + 1, SECTIONS.length);
  }
  if (!opened) throw new Error("Parfois не отдал ни одного раздела каталога");
  return [...seen.values()];
}
