/**
 * Метрики ключа по последнему снимку выдачи и последней частотности.
 * Перенос один в один из прототипа docs/keyword-research/prototype/build_tail.py (verdict, score, flags, variants, prof, art_stats, year_flag)
 * и competitors.py (niche). Чистые функции, без базы.
 */
import { MIN_VOLUME, type Flag, type KwProfile, type MinAvgMax, type Niche, type PositionSignals, type SerpAgg, type TopTuple, type Verdict } from "./types";

const MONTH_DAYS = 30.44;
const DAY = 864e5;

/** Возраст даты YYYY-MM-DD в месяцах (день > 28 считается 28-м, как в прототипе). */
export function monthsAgo(date: string, now = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const d = Date.UTC(+m[1], +m[2] - 1, Math.min(+m[3], 28));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round(((today - d) / DAY / MONTH_DAYS) * 10) / 10;
}

export function normPhrase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
/** Подсказка Pinterest «outfit-ideas_for» → «outfit ideas for». */
export function hum(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Статьи топ-10 с известной датой: возраст в месяцах — самая свежая, самая старая, средний, сколько с датой. */
export function artStats(top: SerpAgg["top"], dates: (url: string) => string | null | undefined, now = new Date()) {
  const ages: number[] = [];
  for (const [u] of top ?? []) {
    const d = u ? dates(u) : null;
    const a = d ? monthsAgo(d, now) : null;
    if (a != null && a >= 0) ages.push(a);
  }
  if (!ages.length) return null;
  return { newest: Math.min(...ages), oldest: Math.max(...ages), avg: Math.round((ages.reduce((p, q) => p + q, 0) / ages.length) * 10) / 10, count: ages.length };
}

/** Вердикт по выдаче и частотности. vol = null — частотность не снята. */
export function verdict(vol: number | null, s: SerpAgg | null): Verdict | null {
  if (vol != null && vol < MIN_VOLUME) return "low_volume";
  if (!s || s.tmatch == null) return null;
  const com = s.ad + s.prod;
  const med = s.med ?? 1e9;
  const fol = s.fol ?? 1e9;
  const weakOpt = !!s.org && s.tmatch / s.org <= 0.25;
  if (com >= 10) return "commercial";
  const easySignal = med <= 100 || (s.fresh3 >= 3 && med <= 1000) || (weakOpt && fol <= 5000 && med <= 1000);
  if (s.ad <= 2 && s.prod <= 2 && s.big <= 2 && easySignal && (vol == null || vol <= 500_000)) return "easy";
  if (com <= 7 && (s.fresh >= 2 || med <= 500)) return "medium";
  return "hard";
}

/**
 * Вес позиции в топ-10 органики: 1/log2(позиция + 1) — 1-е место 1.0, 3-е 0.5, 10-е 0.29 (как в DCG).
 * Свежий пин на 1-м месте говорит о том, что новичка пускают наверх; на 10-м — почти ничего.
 */
export const positionWeight = (pos: number) => 1 / Math.log2(pos + 1);

/** Сигналы топ-10 с учётом позиции. top — пины по порядку (ссылка, дата пина, сохранения). */
export function positionSignals(top: TopTuple[], now = new Date()): PositionSignals | null {
  const rows = top.slice(0, 10).map(([link, date, saves], i) => ({ pos: i + 1, link, age: date ? monthsAgo(date, now) : null, saves: saves === "" ? null : saves }));
  const dated = rows.filter((r) => r.age != null);
  if (!dated.length) return null;
  const wAll = dated.reduce((p, r) => p + positionWeight(r.pos), 0);
  const wFresh = dated.filter((r) => r.age! < 3).reduce((p, r) => p + positionWeight(r.pos), 0);
  const s3 = rows.slice(0, 3).map((r) => r.saves).filter((v): v is number => v != null).sort((a, b) => a - b);
  return {
    n: dated.length,
    freshW: Math.round((1000 * wFresh) / wAll) / 10,
    freshTop3: rows.slice(0, 3).filter((r) => r.age != null && r.age < 3).length,
    linkTop5: rows.slice(0, 5).filter((r) => r.link).length,
    savesTop3: s3.length ? s3[Math.floor(s3.length / 2)] : null,
  };
}

/** Наибольший год 2015–2029 в тексте (заголовок статьи, заголовок пина, адрес). */
export function yearIn(text: string | null | undefined): number | null {
  if (!text) return null;
  const ys = [...text.matchAll(/(?<![0-9])(20(?:1[5-9]|2[0-9]))(?![0-9])/g)].map((m) => Number(m[1]));
  return ys.length ? Math.max(...ys) : null;
}

/** Дополнительные сигналы к формулам прототипа (позиции и статьи топа). Без них формулы считают ровно как прототип. */
export type ExtraSignals = { pos?: PositionSignals | null; oldYears?: number | null; withLinks?: number | null };

export function flags(s: SerpAgg | null, artAvg: number | null, extra: ExtraSignals = {}): Flag[] {
  if (!s || s.tmatch == null) return [];
  const f: Flag[] = [];
  const n = s.n || 1;
  if (s.video / n >= 0.5) f.push("video");
  if (s.big >= 3) f.push("big_media");
  if (s.org && s.tmatch / s.org <= 0.25) f.push("weak_opt");
  if (s.fol != null && s.fol <= 1000) f.push("small_accounts");
  if (artAvg != null && artAvg >= 24) f.push("old_articles");
  if (s.resaved != null && s.org && s.resaved / s.org >= 0.4) f.push("resaved");
  if (s.ndom && s.udom <= 3 && s.ndom >= 5) f.push("few_sites");
  if (extra.pos && extra.pos.freshTop3 >= 1) f.push("fresh_top");
  if (extra.oldYears != null && extra.oldYears >= 2) f.push("old_years");
  return f;
}

/**
 * Оценка возможности 0–100: лёгкость выдачи × размер спроса. null — не считается.
 * С `extra.pos` свежесть считается с весом позиции (вместо «свежих из 20 без учёта места»), с `extra.oldYears` —
 * бонус за статьи топа с устаревшим годом в заголовке (доля от статей со ссылкой). Без extra — ровно формула прототипа.
 */
export function score(vol: number | null, s: SerpAgg | null, extra: ExtraSignals = {}): number | null {
  if (!vol || !s || s.tmatch == null || vol < MIN_VOLUME) return null;
  const n = s.n || 1;
  const org = s.org || 1;
  let ease = 100;
  ease -= ((100 * s.ad) / n) * 1.0;
  ease -= ((100 * s.prod) / n) * 1.0;
  ease -= ((100 * s.big) / Math.max(s.ndom, 1)) * 0.3;
  ease -= ((100 * s.tmatch) / org) * 0.25;
  // Вес 0.2 вместо 0.25: на стартовых данных доля с весом позиции в среднем 0.28 против 0.22 у «свежих из 20» —
  // средний вклад свежести тот же, но свежий пин наверху теперь весит больше, чем внизу.
  ease += extra.pos ? extra.pos.freshW * 0.2 : ((100 * s.fresh3) / n) * 0.25;
  if (extra.oldYears && extra.withLinks) ease += ((100 * extra.oldYears) / extra.withLinks) * 0.15;
  if (s.ul?.length) ease -= ((100 * s.ul.reduce((p, u) => p + u[5], 0)) / s.ul.length) * 0.25;
  if (s.med) ease -= Math.max(0, Math.log10(s.med) - 1) * 15;
  ease = Math.max(0, Math.min(100, ease));
  // золотая середина — средняя частотность: головные ключи тяжёлые, мелкие мало дают
  const demand = vol < 10_000 ? 0.6 : vol < 50_000 ? 0.85 : vol < 300_000 ? 1.0 : vol < 1_000_000 ? 0.8 : 0.6;
  return Math.round(ease * demand);
}

/**
 * Ищут ли ключ с годом: в подсказках поиска есть 2025–2029 отдельным словом.
 * В прототипе регулярка была испорчена (вместо `\b` — символ backspace), и колонка в Таблице всегда пустая; здесь — задуманная логика.
 */
export function withYear(s: SerpAgg | null): boolean {
  return /\b202[5-9]\b/.test((s?.ta ?? []).join(" ").toLowerCase());
}

/** Профиль авторов топ-10 (бизнес/личные, просмотры, охват, подписчики) — `prof()` прототипа. */
export function profile(s: SerpAgg | null): KwProfile | null {
  const ul = s?.ul;
  if (!ul) return null;
  const biz = ul.filter((u) => u[5]);
  const vals = (i: number) => biz.map((u) => u[i]).filter((v): v is number => v != null && v >= 0);
  const trio = (i: number): MinAvgMax => {
    const a = vals(i);
    return a.length ? { min: Math.min(...a), avg: Math.round(a.reduce((p, q) => p + q, 0) / a.length), max: Math.max(...a) } : null;
  };
  const avg = (i: number) => {
    const a = vals(i);
    return a.length ? Math.round(a.reduce((p, q) => p + q, 0) / a.length) : null;
  };
  return {
    n: ul.length, biz: biz.length, personal: ul.length - biz.length,
    views: trio(0), reach: trio(1), followers: trio(2), pinsAvg: avg(3), boardsAvg: avg(4),
    dv: ul.reduce((p, u) => p + u[6], 0), mer: ul.reduce((p, u) => p + u[7], 0),
  };
}

// ---------- вариации (тот же интент, только нейтральные модификаторы) ----------
const ADJ = ["trendy", "classy", "simple", "cute", "easy", "best", "elegant", "chic", "pretty", "modern", "stylish", "beautiful", "gorgeous", "aesthetic", "timeless", "popular", "unique", "cool"];
const SUF: Record<string, string> = { ideas: "Ideas", idea: "Ideas", inspo: "Inspo", inspiration: "Inspiration", looks: "Looks", designs: "Designs", design: "Designs", "design ideas": "Design Ideas", styles: "Styles" };
const PLURAL_SUF = new Set(["Ideas", "Inspo", "Inspiration", "Designs", "Design Ideas", "Looks", "Styles"]);
const SMALL = new Set(["for", "with", "and", "the", "of", "a", "to", "in", "on", "an", "or", "at"]);

/** Title Case без служебных слов (кроме первого). */
export function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean).map((x, i) => (SMALL.has(x.toLowerCase()) && i ? x : x.slice(0, 1).toUpperCase() + x.slice(1))).join(" ");
}
function sing(w: string): string {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
function withSuffix(k: string, suf: string): string | null {
  const m = /^(.+?)( (?:for|with|on|over|under) .+)$/i.exec(k);
  const [head, tail] = m ? [m[1], m[2]] : [k, ""];
  const hw = head.split(/\s+/);
  if (PLURAL_SUF.has(suf)) {
    if (["ideas", "designs", "inspo", "looks", "styles"].includes(hw[hw.length - 1].toLowerCase())) return null;
    hw[hw.length - 1] = sing(hw[hw.length - 1]);
  }
  return hw.join(" ") + " " + suf + tail;
}

/** До 5 вариаций ключа для заголовков пинов: сначала подтверждённые подсказками Pinterest, потом шаблоны. */
export function variants(k: string, ta: string[] = []): string[] {
  const lk = k.toLowerCase().trim();
  const out: string[] = [];
  const push = (x: string | null) => {
    if (!x) return;
    const t = titleCase(x);
    if (t.toLowerCase() !== lk && !out.includes(t)) out.push(t);
  };
  const startsAdj = ADJ.includes(lk.split(/\s+/)[0]);
  const m = /^how to style (.+)$/.exec(lk) || /^what to wear with (.+)$/.exec(lk);
  if (m) {
    const x = m[1];
    for (const t of [`ways to style ${x}`, `easy ways to style ${x}`, `cute ways to style ${x}`, `how to wear ${x}`, lk.startsWith("how") ? `what to wear with ${x}` : `how to style ${x}`]) push(t);
    return out.slice(0, 5);
  }
  if (/^(how|what|why|which|best way|types of|colors that|can|does|is) /.test(lk)) return []; // вопросы и гайды: модификатор сдвинет интент
  for (const raw of ta) {
    const s = hum(raw).toLowerCase();
    if (!s.startsWith(lk + " ")) continue;
    const extra = s.slice(lk.length).trim();
    if (ADJ.includes(extra) && !startsAdj) push(`${extra} ${k}`);
    else if (SUF[extra]) push(withSuffix(k, SUF[extra]));
  }
  if (!startsAdj) {
    for (const a of ["trendy", "classy", "simple", "cute", "easy", "elegant", "best", "chic"]) {
      if (out.length >= 5) break;
      push(`${a} ${k}`);
    }
  }
  if (out.length < 5) push(withSuffix(k, "Ideas"));
  if (out.length < 5) push(withSuffix(k, "Inspo"));
  return out.slice(0, 5);
}

/** Подсказки поиска без самого ключа и без повторов. */
export function suggestions(k: string, ta: string[] = []): string[] {
  const out: string[] = [];
  for (const x of ta) {
    const h = hum(x);
    if (h.toLowerCase() !== k.toLowerCase() && !out.includes(h)) out.push(h);
  }
  return out;
}

/** Ниша по словам ключа (competitors.py). */
export function guessNiche(k: string): Niche {
  const s = k.toLowerCase();
  if (/nail|manicure|pedicure|cuticle|french tip|biab/.test(s)) return "nails";
  if (/hair|braid|bob|bang|pixie|updo|balayage|highlight|blonde|brunette|loc|twist|bun|ponytail|shag|haircut|cornrow|layers|curls|wig|silk press|lob|wolf cut|cut$/.test(s)) return "hair";
  return "outfits";
}

/** Процент a от b (0–100) или null, если база 0. */
export function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  return a != null && b ? Math.round((1000 * a) / b) / 10 : null;
}
