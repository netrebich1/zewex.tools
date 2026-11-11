/**
 * Автоподбор статей сайта для соцсетей (правило владельца 2026-11-11): только мода, стиль, одежда, ногти, волосы;
 * «Поради» и новости (включая звёзд) не брать. Рубрики читаются из открытого REST API WordPress сайта, тема рубрики
 * определяется по её адресу (slug) и названию; статья, которая стоит и в нужной, и в запретной рубрике, не берётся.
 * Уже использованные в прошлых прогонах адреса пропускаются.
 */
import { prisma } from "@/lib/db";
import { safeFetch } from "@/lib/pins/fetch";

/** Нужные темы: мода и стиль, одежда и обувь, ногти, волосы (стрижки, причёски, окрашивание), тренды. */
export const TOPIC_RE = /(^|[-_ ])(mod[ayi]|fashion|styl|stil|стил|мод[аиы]|odyah|odezhd|одяг|одежд|outfit|obraz|образ|trend|тренд|sukn|plat|сукн|плать|vzutt|obuv|взутт|обув|kurtk|куртк|palt|пальт|spidnyts|yubk|спідниц|юбк|shtan|bryuk|штан|брюк|dzhyns|джинс|svetr|светр|свитер|futbolk|футболк|short|шорт|top[yi]?$|топ|kupaln|купальн|mayk|майк|nihti|nogti|nail|manik|ніг|ногт|манік|маник|volos|hair|волос|zachisk|prichesk|зачіск|причес|stryzh|strizh|стриж|kolor|farbuvann|okrash|фарбуван|окраш)/i;
/** Запретные рубрики: советы, новости, звёзды, эзотерика, дом и быт. */
export const EXCLUDE_RE = /(porad|sovet|tips|порад|совет|novyn|novost|news|новин|новост|zirk|zvezd|celeb|зірк|звезд|ezoter|езотер|эзотер|horoskop|гороскоп|dim-i-pobut|pobut|побут|uncategor|prann|plyam|stirk|пранн|плям|стирк|remont|rukodil|ремонт|рукоділ|рукодел|dohlyad-za-odyah|uhod-za-odezhd|догляд за одяг|уход за одежд)/i;

type WpCat = { id: number; name: string; slug: string; parent: number; count: number };

export type PickResult = { urls: string[]; used: string[]; skipped: string[]; skippedUsed: number };

async function wpJson<T>(base: string, path: string): Promise<T> {
  const res = await safeFetch(`${base}/wp-json/wp/v2${path}`, { timeoutMs: 25_000, maxBytes: 4 * 1024 * 1024, accept: "application/json", headers: { "User-Agent": "Mozilla/5.0 (compatible; ZewexSocial/1.0; +https://zewex.tools)" } });
  if (!res.ok) throw new Error(`Сайт не отдал список по REST API WordPress (${res.status}). Вставьте ссылки на статьи вручную.`);
  return JSON.parse(res.body.toString("utf8")) as T;
}

/** Деление рубрик на нужные и запретные; дочерние наследуют решение родителя (Одяг → Сукні, Новини → Зірки). */
export function classifyCategories(cats: WpCat[]): { include: WpCat[]; exclude: WpCat[] } {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const verdict = (c: WpCat, depth = 0): "in" | "out" | "none" => {
    const own = `${c.slug} ${c.name}`;
    if (EXCLUDE_RE.test(own)) return "out";
    const parent = c.parent && depth < 5 ? byId.get(c.parent) : undefined;
    const up = parent ? verdict(parent, depth + 1) : "none";
    if (up === "out") return "out";
    if (TOPIC_RE.test(c.slug) || TOPIC_RE.test(c.name)) return "in";
    return up;
  };
  return { include: cats.filter((c) => verdict(c) === "in"), exclude: cats.filter((c) => verdict(c) === "out") };
}

/** Свежие статьи сайта по нужным рубрикам, без запретных и без уже использованных. */
export async function pickSitePosts(siteUrl: string, limit: number): Promise<PickResult> {
  let base: string;
  try {
    base = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).origin;
  } catch {
    throw new Error("Не похоже на адрес сайта");
  }
  const cats = await wpJson<WpCat[]>(base, "/categories?per_page=100&_fields=id,name,slug,parent,count");
  const { include, exclude } = classifyCategories(cats);
  if (!include.length) throw new Error("На сайте не нашлось рубрик про моду, стиль, ногти или волосы. Вставьте ссылки на статьи вручную.");
  const want = Math.max(1, Math.min(100, limit));
  const urls: string[] = [];
  let skippedUsed = 0;
  for (let page = 1; page <= 5 && urls.length < want; page++) {
    const qs = new URLSearchParams({ per_page: "50", page: String(page), orderby: "date", order: "desc", _fields: "link", categories: include.map((c) => c.id).join(",") });
    if (exclude.length) qs.set("categories_exclude", exclude.map((c) => c.id).join(","));
    let posts: { link: string }[];
    try {
      posts = await wpJson<{ link: string }[]>(base, `/posts?${qs}`);
    } catch (e) {
      if (page > 1) break;
      throw e;
    }
    if (!posts.length) break;
    const links = posts.map((p) => String(p.link ?? "")).filter(Boolean);
    const usedRows = await prisma.socialItem.findMany({ where: { url: { in: links.flatMap((l) => [l, l.replace(/\/$/, ""), l.endsWith("/") ? l : `${l}/`]) } }, select: { url: true } });
    const used = new Set(usedRows.map((r) => r.url.replace(/\/$/, "")));
    for (const l of links) {
      if (used.has(l.replace(/\/$/, ""))) skippedUsed++;
      else if (urls.length < want) urls.push(l);
    }
    if (posts.length < 50) break;
  }
  return { urls, used: include.filter((c) => c.count > 0).map((c) => c.name), skipped: exclude.filter((c) => c.count > 0).map((c) => c.name), skippedUsed };
}
