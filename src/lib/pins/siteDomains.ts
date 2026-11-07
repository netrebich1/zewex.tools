/**
 * Домены сайта для проверки ссылок прогона: адрес WordPress-доступа, домен для ссылок (рецепт и доступ),
 * название сайта, если оно похоже на домен. Чистые функции — используются и в форме, и на сервере.
 */

/** Хост без www и порта, в нижнем регистре; "" — не похоже на адрес. */
export function hostOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
}

/** Уникальные домены сайта из всех известных источников. */
export function siteDomains(sources: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    const v = (s ?? "").trim();
    if (!v || !/\./.test(v)) continue;
    const h = hostOf(v);
    if (h && h.includes(".")) out.add(h);
  }
  return [...out];
}

/** Ссылка принадлежит сайту: тот же домен или его поддомен (blog.site.com ↔ site.com). */
export function belongsTo(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`));
}

/** Чужие домены среди ссылок: { host, count }, по убыванию числа ссылок. Пустой список доменов сайта — проверки нет. */
export function foreignHosts(urls: string[], domains: string[]): Array<{ host: string; count: number }> {
  if (!domains.length) return [];
  const m = new Map<string, number>();
  for (const u of urls) {
    const h = hostOf(u);
    if (!h || belongsTo(h, domains)) continue;
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return [...m.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count);
}
