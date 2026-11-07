/**
 * Блог или платформа. Соцсети, маркетплейсы, магазины и короткие ссылки (Instagram, YouTube, Amazon, Etsy, amzn.to…)
 * владельцу не конкуренты: с их трастом блог не соревнуется. Все показатели статей топа считаются только по блогам.
 * Список как PLATFORM прототипа (competitors.py) + сокращатели и витрины ссылок.
 */
export const PLATFORM = /(instagram|tiktok|youtube|youtu\.be|facebook|pinterest|pin\.it|twitter|x\.com|threads\.net|reddit|etsy|amazon|amzn\.to|amzn\.|shein|walmart|target|temu|aliexpress|ebay|nordstrom|zara|hm\.com|ulta|sephora|shffls|linktr\.ee|bit\.ly|beacons\.ai|liketoknow|shopltk|ltk\.app|shopmy|shop\.app|google\.)/i;

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Ссылка ведёт на блог/сайт (не на платформу или магазин). Пустая ссылка — не блог. */
export function isBlogLink(url: string | null | undefined): boolean {
  const h = hostOf(url);
  return !!h && !PLATFORM.test(h);
}
