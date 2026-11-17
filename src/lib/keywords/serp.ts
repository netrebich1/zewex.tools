/**
 * Разбор сырых ответов Pinterest на сервере — перенос один в один из прототипа
 * docs/keyword-research/prototype/serp-analyze.js (`__analyze`, `__uinfo`, `__ownGuess`, `__BIG`, `__ta`)
 * и serp-loop.js (`ul`, отрицательные просмотры/охват → null). Чистые функции, без базы.
 *
 * Расширение присылает ответы как есть (BaseSearchResource, UserResource, AdvancedTypeaheadResource),
 * поэтому поправить разбор можно здесь, без переустановки расширения.
 */
import { yearIn } from "./metrics";
import type { MinAvgMax, PinnerTuple, SerpAgg, TopTuple } from "./types";

/** Профиль автора как `__uinfo` прототипа (v — просмотры/мес, r — охват/мес, f — подписчики). */
export type PinnerInfo = {
  v: number | null; r: number | null; f: number | null; pins: number | null; boards: number | null;
  biz: boolean; dv: boolean; mer: boolean; dom: string | null;
};

/** Пин топа для KwPin. */
export type TopPin = {
  position: number; pinId: string | null; link: string | null; domain: string | null; createdAt: Date | null;
  saves: number | null; product: boolean; video: boolean; title: string | null; pinner: string | null;
  /** Картинка пина 236px (для определения оформления) */
  imageUrl: string | null;
  /** own — сохранил владелец сайта, resaved — другой пользователь, upload — без ссылки */
  saveType: "own" | "resaved" | "upload";
};

/** Крупные СМИ и магазины (`__BIG`). */
export const BIG = /(allure|byrdie|vogue|cosmopolitan|glamour|elle\.com|harpersbazaar|instyle|refinery29|whowhatwear|marieclaire|today\.com|goodhousekeeping|womansday|realsimple|buzzfeed|southernliving|etsy|amazon|nordstrom|shein|walmart|target\.com|zara|hm\.com|ulta|sephora|people\.com|stylecaster|teenvogue|seventeen|redbookmag|womenshealthmag|prevention|thezoereport|popsugar|bustle|nymag|hellogiggles|loreal|matrix|redken|wella|nailsmag|opi\.com)/i;

const STOP = ["for", "with", "the", "and"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** resource_response из тела ответа /resource/…/get/ (или null, если тело не то). */
export function resourceResponse(body: unknown): Any | null {
  const rr = (body as Any)?.resource_response;
  return rr && typeof rr === "object" ? rr : null;
}

/** Картинка пина для просмотра оформления: 236px (лёгкая), иначе ближайший размер. */
function imageOf(x: Any): string | null {
  const im = x?.images;
  if (!im || typeof im !== "object") return null;
  for (const k of ["236x", "170x", "474x", "orig"]) if (im[k]?.url) return String(im[k].url);
  return null;
}

/** Пины первого экрана (до 20), как `all` в `__analyze`. */
function pinsOf(rr: Any): Any[] {
  const res = (rr?.data && rr.data.results) || [];
  return Array.isArray(res) ? res.filter((x: Any) => x && x.type === "pin").slice(0, 20) : [];
}

/** Почему ответ поиска не годится: null — годится (в том числе пустая выдача — её отличает `n = 0`). */
export function searchProblem(httpStatus: number, body: unknown): string | null {
  if (httpStatus && httpStatus !== 200) return `HTTP ${httpStatus}`;
  const rr = resourceResponse(body);
  if (!rr) return "ответ без resource_response";
  if (rr.error) return String(rr.error.message || rr.error.code || JSON.stringify(rr.error)).slice(0, 180);
  if (rr.status && rr.status !== "success") return String(rr.message || rr.status).slice(0, 180);
  return null;
}

/** Авторы органических пинов топ-10 (кого нужно спросить через UserResource). */
export function orgUsernames(body: unknown): string[] {
  const org = pinsOf(resourceResponse(body)).filter((x) => !x.is_promoted);
  return [...new Set(org.slice(0, 10).map((x) => x.pinner && x.pinner.username).filter(Boolean) as string[])];
}

/** Все авторы пинов первого экрана (для подбора кэша). */
export function allUsernames(body: unknown): string[] {
  return [...new Set(pinsOf(resourceResponse(body)).map((x) => x.pinner && x.pinner.username).filter(Boolean) as string[])];
}

/** `__uinfo` + поправка serp-loop.js (отрицательные просмотры и охват — null). body — тело ответа UserResource. */
export function parseUser(body: unknown): PinnerInfo | null {
  const d = resourceResponse(body)?.data;
  if (!d || typeof d !== "object") return null;
  const fix = (v: unknown) => (v == null || typeof v !== "number" || v < 0 ? null : v);
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    v: fix(d.profile_views ?? null), r: fix(d.profile_reach ?? null), f: n(d.follower_count ?? null),
    pins: n(d.pin_count ?? null), boards: n(d.board_count ?? null),
    biz: !!d.is_partner, dv: !!d.domain_verified, mer: !!d.is_verified_merchant,
    dom: d.domain_verified && d.domain_url ? String(d.domain_url).toLowerCase().replace(/^www\./, "") : null,
  };
}

/** Подсказки поиска (`__ta`): только элементы type=query. body — тело ответа AdvancedTypeaheadResource. */
export function parseTypeahead(body: unknown): string[] {
  const items = resourceResponse(body)?.data?.items;
  return Array.isArray(items) ? items.filter((i: Any) => i && i.type === "query" && typeof i.query === "string").map((i: Any) => i.query as string) : [];
}

/** `__ownGuess`: имя/логин автора похоже на домен. */
export function ownGuess(x: Any): boolean {
  const root = String(x.domain).toLowerCase().replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9]/g, "");
  const names = [x.pinner.username || "", x.pinner.full_name || ""].map((s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""));
  return names.some((n: string) => n.length >= 4 && root.length >= 4 && (n.includes(root) || root.includes(n) || n.slice(0, 6) === root.slice(0, 6)));
}

const st = (a: number[]): MinAvgMax => (a.length ? { min: Math.min(...a), avg: Math.round(a.reduce((p, q) => p + q, 0) / a.length), max: Math.max(...a) } : null);
const med = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};
const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * `__analyze(kw)` + `acc` и `ul` из serp-loop.js. body — тело ответа BaseSearchResource,
 * users — кэш профилей авторов (как `__uc`: отсутствует — не спрашивали, null — Pinterest не отдал профиль),
 * ta — подсказки поиска. Возвращает агрегаты формата прототипа и пины топ-10 для KwPin.
 */
export function analyze(kw: string, body: unknown, users: Map<string, PinnerInfo | null>, ta: string[], acc: string | null, now = Date.now()): { agg: SerpAgg; top: TopPin[] } {
  const q = kw.toLowerCase();
  const rr = resourceResponse(body);
  const all = pinsOf(rr);
  if (!all.length) return { agg: { n: 0 } as SerpAgg, top: [] };
  let ad = 0, prod = 0, info = 0, nolink = 0, fresh = 0, fresh3 = 0, video = 0, tmatch = 0, org = 0, own = 0, resaved = 0, upload = 0, ty = 0;
  const tyears: Record<string, number> = {};
  const saves: number[] = [], fol: number[] = [], nums: number[] = [], doms: string[] = [], top: TopTuple[] = [], pins: TopPin[] = [];
  const words = q.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.includes(w));
  const orgPins = all.filter((x) => !x.is_promoted);
  const uc = (u: string | undefined) => (u ? users.get(u) : undefined);

  for (const x of all) {
    const isProd = (x.rich_summary && x.rich_summary.type_name === "product") || !!x.product_pin_data || (x.shopping_flags && x.shopping_flags.length > 0);
    if (x.is_promoted) { ad++; continue; }
    org++;
    if (isProd) prod++;
    else if (x.link || (x.rich_summary && x.rich_summary.type_name === "article")) info++;
    else nolink++;
    const s = x.aggregated_pin_data && x.aggregated_pin_data.aggregated_stats && x.aggregated_pin_data.aggregated_stats.saves;
    if (s != null) saves.push(s);
    const age = x.created_at ? (now - Date.parse(x.created_at)) / 864e5 : 9999;
    if (age < 180) fresh++;
    if (age < 90) fresh3++;
    const isVideo = !!(x.videos || (x.story_pin_data && JSON.stringify(x.story_pin_data).includes('"video')));
    if (isVideo) video++;
    const title = ((x.grid_title || x.title || "") + " ").toLowerCase();
    // Год в заголовке пина (не в прототипе): 2015–2029 отдельным числом.
    const py = yearIn(title);
    if (py != null) { ty++; tyears[py] = (tyears[py] ?? 0) + 1; }
    if (words.length && words.every((w) => title.includes(w.replace(/s$/, "")))) tmatch++;
    const m = title.match(/\b(\d{1,3})\b/);
    if (m && +m[1] >= 5 && +m[1] <= 200) nums.push(+m[1]);
    if (x.pinner && x.pinner.follower_count != null) fol.push(x.pinner.follower_count);
    let saveType: TopPin["saveType"] = "upload";
    if (!x.link || !x.domain) {
      upload++;
    } else {
      const u = x.pinner && uc(x.pinner.username);
      const d = String(x.domain).toLowerCase().replace(/^www\./, "");
      const o = u && u.dom ? u.dom === d || d.endsWith("." + u.dom) || u.dom.endsWith("." + d) : x.pinner ? ownGuess(x) : false;
      if (o) { own++; saveType = "own"; }
      else { resaved++; saveType = "resaved"; }
    }
    if (top.length < 10) {
      if (x.domain && x.link) doms.push(String(x.domain).toLowerCase());
      const date = x.created_at ? new Date(x.created_at).toISOString().slice(0, 10) : "";
      top.push([x.link || "", date, s ?? ""]);
      pins.push({
        position: top.length, pinId: x.id ? String(x.id).slice(0, 32) : null, link: x.link || null, domain: x.link ? domainOf(x.link) : null,
        createdAt: date ? new Date(`${date}T00:00:00Z`) : null, saves: typeof s === "number" ? s : null,
        product: !!isProd, video: isVideo, title: (x.grid_title || x.title || "").slice(0, 255) || null, pinner: x.pinner?.username ?? null,
        imageUrl: imageOf(x), saveType,
      });
    }
  }

  const U = orgPins.slice(0, 10).map((x) => x.pinner && uc(x.pinner.username)).filter(Boolean) as PinnerInfo[];
  const g = (f: (u: PinnerInfo) => number | null) => U.map(f).filter((v): v is number => v != null);
  const guides = ((rr.data && rr.data.rankedGuides) || []).map((x: Any) => x.display || x.term).filter(Boolean).slice(0, 15) as string[];
  const ul: PinnerTuple[] = orgPins.slice(0, 10)
    .map((x) => { const u = x.pinner && uc(x.pinner.username); return u ? ([u.v, u.r, u.f, u.pins, u.boards, u.biz ? 1 : 0, u.dv ? 1 : 0, u.mer ? 1 : 0] as PinnerTuple) : null; })
    .filter((u): u is PinnerTuple => !!u);

  const agg: SerpAgg = {
    n: all.length, org, ad, prod, info, nolink, fresh, fresh3, med: med(saves), video, tmatch, fol: med(fol),
    udom: new Set(doms).size, ndom: doms.length, big: doms.filter((d) => BIG.test(d)).length, listn: med(nums),
    own, resaved, upload, un: U.length,
    views: st(g((u) => u.v)), reach: st(g((u) => u.r)), fols: st(g((u) => u.f)), pins: st(g((u) => u.pins)), boards: st(g((u) => u.boards)),
    biz: U.filter((u) => u.biz).length, dv: U.filter((u) => u.dv).length, mer: U.filter((u) => u.mer).length,
    top, guides, ta, ul, ty, tyears,
  };
  if (acc) agg.acc = acc;
  return { agg, top: pins };
}

/**
 * Ответ Ads Manager `get_audience_sizing_handler` → частотность (`reach_estimate`): оценка и диапазон.
 * Пустой reach_estimate / нулевая оценка — «нет данных» (≈0), как `none` в vol.json прототипа.
 */
export function parseSizing(re: unknown): { estimate: number | null; lower: number | null; upper: number | null; none: boolean } | null {
  if (re == null) return { estimate: null, lower: null, upper: null, none: true };
  if (typeof re !== "object") return null;
  const r = re as Any;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const estimate = num(r.estimate), lower = num(r.lower_bound), upper = num(r.upper_bound);
  if (!estimate) return { estimate: null, lower, upper, none: true };
  return { estimate, lower, upper, none: false };
}
