/**
 * Гео: где у площадок Collaborator больше всего заказов — по языкам и странам, без украинского и русского.
 * Нужно владельцу, чтобы выбирать, на каком языке и под какую страну запускать следующие сайты.
 * Считается при сборе каталога из ВСЕХ площадок (не только с кликами GSC): по новым (месяц / 2 / 3 месяца) — каждый день,
 * по всему каталогу (≈46 тысяч, 460+ запросов) — раз в неделю. Итог лежит одним JSON в CompState.geo.
 * Без обращений к базе: чистые накопители, площадки приходят страницами и в памяти не держатся.
 *
 * Важно про цифры: Collaborator отдаёт число сделок нижней границей (точное до 4, дальше 5 / 10 / 20 / 50),
 * поэтому «заказов» — это «не меньше»; площадка с 50+ может иметь и 500. У площадки бывает несколько стран
 * и языков — она считается в каждой, поэтому суммы по строкам больше общего числа площадок.
 */
import type { Creator } from "./collab";

/** Языки домашнего рынка: площадки с ними в «зарубежный» счёт не идут и показываются одной строкой для сравнения. */
export const HOME_LANGS = ["Украинский", "Русский"];
export const GEO_WINDOWS = [31, 61, 92] as const;

export type GeoInner = { name: string; deals: number; sites: number };
export type GeoSite = { domain: string; deals: number; clicks: number; price: number | null; url: string };
export type GeoRow = {
  name: string;
  /** Площадок */
  sites: number;
  /** Из них хотя бы с одним заказом */
  withDeals: number;
  /** Сумма нижних границ числа заказов */
  deals: number;
  /** Площадок с 5+ и с 20+ заказами */
  d5: number;
  d20: number;
  /** Медиана цены статьи среди площадок с заказами (валюта кабинета) */
  medPrice: number | null;
  /** Площадок, поделившихся GSC, и сумма их кликов за месяц */
  gscSites: number;
  clicks: number;
  /** Для языка — страны, для страны — языки: где внутри строки заказы */
  inner: GeoInner[];
  /** Ниши (категории Collaborator) по заказам */
  cats: GeoInner[];
  /** Площадки с наибольшим числом заказов */
  top: GeoSite[];
};
export type GeoBlock = { sites: number; withDeals: number; deals: number; currency: string; languages: GeoRow[]; countries: GeoRow[]; home: GeoRow | null };
export type GeoData = { at: string; windows: Record<string, GeoBlock>; all?: GeoBlock; allAt?: string };

class RowAcc {
  sites = 0;
  withDeals = 0;
  deals = 0;
  d5 = 0;
  d20 = 0;
  gscSites = 0;
  clicks = 0;
  prices: number[] = [];
  inner = new Map<string, { deals: number; sites: number }>();
  cats = new Map<string, { deals: number; sites: number }>();
  top: GeoSite[] = [];

  add(site: GeoSite, clicks: number | null, inner: string[], cats: string[]) {
    this.sites++;
    this.deals += site.deals;
    if (site.deals >= 1) {
      this.withDeals++;
      if (site.price != null) this.prices.push(site.price);
    }
    if (site.deals >= 5) this.d5++;
    if (site.deals >= 20) this.d20++;
    if (clicks != null) {
      this.gscSites++;
      this.clicks += clicks;
    }
    for (const [map, names] of [[this.inner, inner], [this.cats, cats]] as const) {
      for (const n of names) {
        const x = map.get(n) ?? { deals: 0, sites: 0 };
        x.deals += site.deals;
        x.sites++;
        map.set(n, x);
      }
    }
    if (site.deals >= 1) {
      this.top.push(site);
      // Держим короткий список лучших, а не все площадки строки.
      if (this.top.length > 40) this.top = this.top.sort((a, b) => b.deals - a.deals || b.clicks - a.clicks).slice(0, 10);
    }
  }

  row(name: string): GeoRow {
    const top5 = (m: Map<string, { deals: number; sites: number }>) => [...m.entries()].map(([n, v]) => ({ name: n, ...v })).sort((a, b) => b.deals - a.deals || b.sites - a.sites).slice(0, 5);
    const p = [...this.prices].sort((a, b) => a - b);
    return {
      name, sites: this.sites, withDeals: this.withDeals, deals: this.deals, d5: this.d5, d20: this.d20,
      medPrice: p.length ? Math.round(p[Math.floor((p.length - 1) / 2)]) : null,
      gscSites: this.gscSites, clicks: this.clicks, inner: top5(this.inner), cats: top5(this.cats),
      top: this.top.sort((a, b) => b.deals - a.deals || b.clicks - a.clicks).slice(0, 8),
    };
  }
}

/** Накопитель одного среза (например, «новые за 61 день» или «весь каталог»). */
export class GeoAcc {
  private langs = new Map<string, RowAcc>();
  private countries = new Map<string, RowAcc>();
  private home = new RowAcc();
  private sites = 0;
  private withDeals = 0;
  private deals = 0;
  private currency = "";

  add(c: Creator): void {
    const langs = (c.site_languages ?? []).map((x) => x.name);
    const countries = (c.country ?? []).map((x) => x.name);
    const cats = (c.categories ?? []).map((x) => x.name);
    const article = c.prices?.find((p) => p.format_id === 1) ?? c.prices?.[0];
    const price = article?.price_publication ? Number(article.price_publication.amount) : NaN;
    if (!this.currency && article?.price_publication?.currency) this.currency = article.price_publication.currency;
    const clicks = c.gsc?.clicks?.last_month ?? null;
    const site: GeoSite = { domain: c.is_domain_visible ? c.name : "домен скрыт", deals: c.deals_count_at_least ?? 0, clicks: Math.round(clicks ?? 0), price: Number.isFinite(price) ? Math.round(price) : null, url: c.url ?? "" };
    if (langs.some((l) => HOME_LANGS.includes(l))) {
      this.home.add(site, clicks, countries, cats);
      return;
    }
    this.sites++;
    this.deals += site.deals;
    if (site.deals >= 1) this.withDeals++;
    for (const l of langs) {
      const a = this.langs.get(l) ?? new RowAcc();
      a.add(site, clicks, countries, cats);
      this.langs.set(l, a);
    }
    for (const k of countries) {
      const a = this.countries.get(k) ?? new RowAcc();
      a.add(site, clicks, langs, cats);
      this.countries.set(k, a);
    }
  }

  block(): GeoBlock {
    const rows = (m: Map<string, RowAcc>) => [...m.entries()].map(([n, a]) => a.row(n)).filter((r) => r.deals > 0 || r.sites >= 5).sort((a, b) => b.deals - a.deals || b.sites - a.sites).slice(0, 80);
    return { sites: this.sites, withDeals: this.withDeals, deals: this.deals, currency: this.currency, languages: rows(this.langs), countries: rows(this.countries), home: this.home.sites ? this.home.row(HOME_LANGS.join(" и ")) : null };
  }
}

const daysSince = (iso: string | null, now: number) => (iso ? Math.floor((now - new Date(`${iso}T00:00:00Z`).getTime()) / 86_400_000) : Infinity);

/** Срезы по новым площадкам: добавлены за 31, 61 и 92 дня. */
export function geoWindows(creators: Creator[], now = Date.now()): Record<string, GeoBlock> {
  const accs = GEO_WINDOWS.map((d) => ({ d, acc: new GeoAcc() }));
  for (const c of creators) {
    const age = daysSince(c.added_to_system_at, now);
    for (const a of accs) if (age <= a.d) a.acc.add(c);
  }
  return Object.fromEntries(accs.map((a) => [String(a.d), a.acc.block()]));
}

export type GeoSort = "deals" | "avg" | "share" | "sites" | "strong";
/** Сортировка строк на странице и в выгрузке. Средние и доли считаем только там, где площадок достаточно, иначе наверх лезет шум. */
export function sortRows(rows: GeoRow[], sort: GeoSort, minSites = 10): GeoRow[] {
  const ok = (r: GeoRow) => (r.sites >= minSites ? 1 : 0);
  const by: Record<GeoSort, (r: GeoRow) => number> = {
    deals: (r) => r.deals,
    avg: (r) => ok(r) * (r.deals / r.sites),
    share: (r) => ok(r) * (r.withDeals / r.sites),
    sites: (r) => r.sites,
    strong: (r) => r.d5,
  };
  return [...rows].sort((a, b) => by[sort](b) - by[sort](a) || b.deals - a.deals);
}
