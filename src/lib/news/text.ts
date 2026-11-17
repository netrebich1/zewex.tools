import { createHash } from "node:crypto";

/**
 * Текст: нормализация, токены, совпадение по основам слов (без лемматизатора — воркер на TypeScript).
 * Основа = начало слова: «зірк» ловит «зірка/зірки/зіркою», «суд» — «суду/суді», но не «судячи» (список исключений).
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Нижний регистр, единый апостроф, ё → е, без пунктуации. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’ʼ`´‘]/g, "'")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return normText(s).split(" ").map((t) => t.replace(/^'+|'+$/g, "")).filter((t) => t.length > 0);
}

/** Заголовок для дедупликации: без хвоста « - Источник» (Google News) и без кавычек. */
export function normTitle(title: string): string {
  return normText(title.replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, "")).slice(0, 300);
}

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Канонический URL: без utm и якоря, без хвостового слэша, хост в нижнем регистре. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_|from$|amp$|_ga)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

type Term = { raw: string; parts: string[] };
export type Matcher = { match: (toks: string[]) => string | null; all: (toks: string[]) => string[] };

/**
 * Совпадение по основам: термин из одного слова — начало токена; из нескольких — подряд идущие токены.
 * Исключения: токен, который начинается с исключения, однословным терминам не засчитывается.
 */
export function makeMatcher(terms: string[], exceptions: string[] = []): Matcher {
  const list: Term[] = terms.map((t) => ({ raw: t, parts: tokens(t) })).filter((t) => t.parts.length > 0);
  const exc = exceptions.map((e) => normText(e)).filter(Boolean);
  const isExc = (tok: string) => exc.some((e) => tok.startsWith(e));
  const hit = (toks: string[], t: Term): boolean => {
    if (t.parts.length === 1) {
      const p = t.parts[0];
      return toks.some((tok) => tok.startsWith(p) && !isExc(tok));
    }
    for (let i = 0; i + t.parts.length <= toks.length; i++) {
      if (t.parts.every((p, j) => toks[i + j].startsWith(p))) return true;
    }
    return false;
  };
  return {
    match: (toks) => list.find((t) => hit(toks, t))?.raw ?? null,
    all: (toks) => list.filter((t) => hit(toks, t)).map((t) => t.raw),
  };
}

/** Падежные окончания имён (укр/рус), которые могут идти после основы: «Дорофєєв|ої», «Карол|ем», «Зар|у», но не «Зар|аз». */
const NAME_ENDINGS = new Set([
  "", "а", "я", "о", "е", "є", "і", "ї", "и", "у", "ю", "ь", "й", "ой", "ей", "ою", "ею", "єю", "ої", "ій", "ий", "ая", "ую", "ом", "ем", "єм", "ам", "ям", "ах", "ях",
  "ами", "ями", "ові", "еві", "єві", "ів", "їв", "ов", "ев", "ого", "ому", "ім", "им", "их", "іх", "ых", "ин", "іна", "ина", "ину", "іну", "іної", "иной", "ою", "ової", "ову", "овій",
]);
const VOWEL_END = /[аяоеєіїиуюьй]$/;

/** Основа слова для имени: у кириллицы отрезаем конечную гласную (Дорофєєва → дорофєєв, Кароль → карол), латиница целиком. */
function nameStem(tok: string): string {
  if (/[a-z]/.test(tok)) return tok.replace(/'s$/, "");
  let s = tok;
  if (s.length >= 4 && VOWEL_END.test(s)) s = s.slice(0, -1);
  if (s.length >= 5 && VOWEL_END.test(s)) s = s.slice(0, -1);
  return s;
}

/** Слово текста подходит к основе имени: латиница — точно или с 's; кириллица — основа + падежное окончание. */
function nameTokenMatches(tok: string, stem: string): boolean {
  if (!tok.startsWith(stem)) return false;
  const rest = tok.slice(stem.length);
  if (/[a-z]/.test(stem)) return rest === "" || rest === "s" || rest === "'s";
  return NAME_ENDINGS.has(rest);
}

export type EntityRow = { id: string; name: string; weight: number; type: string; aliases: string[] };
export type EntityHit = { id: string; name: string; weight: number; type: string };

/** Совпадения сущностей в тексте: любое написание (имя, фамилия, латиница), окончание слова может меняться. */
export function makeEntityMatcher(rows: EntityRow[]): (toks: string[]) => EntityHit[] {
  const compiled = rows.map((r) => ({
    r,
    variants: [r.name, ...r.aliases]
      .map((a) => tokens(a))
      .filter((p) => p.length > 0 && (p.length > 1 || p[0].length >= 4))
      .map((p) => p.map(nameStem)),
  }));
  return (toks) => {
    const out: EntityHit[] = [];
    for (const { r, variants } of compiled) {
      const found = variants.some((v) => {
        for (let i = 0; i + v.length <= toks.length; i++) {
          if (v.every((stem, j) => nameTokenMatches(toks[i + j], stem))) return true;
        }
        return false;
      });
      if (found) out.push({ id: r.id, name: r.name, weight: r.weight, type: r.type });
    }
    return out.sort((a, b) => b.weight - a.weight);
  };
}

/**
 * Текст для фильтров: заголовок и (не для профильных лент) первое предложение лида — тело статьи о звезде часто
 * упоминает войну или суд мимоходом. Фразы-исключения («зоряні війни») вырезаются до поиска стоп-слов.
 */
export function filterText(title: string, lead: string, profile: boolean, phraseExceptions: string[] = []): string[] {
  const first = (lead.match(/^[\s\S]{0,220}?[.!?…](\s|$)/)?.[0] ?? lead.slice(0, 160)).trim();
  let t = ` ${normText(profile ? title : `${title} ${first}`)} `;
  for (const p of phraseExceptions) {
    const n = normText(p);
    if (n.includes(" ")) t = t.split(` ${n}`).join(" ");
  }
  return t.trim().split(" ").filter(Boolean);
}

/** Начало названия каждой рубрики (первые 3 слова): «Новини шоу-бізнесу: останні новини зірок України та світу» → «новини шоу бізнесу». */
export function rubricTokens(categories: string[]): string[] {
  return categories.flatMap((c) => tokens(c).slice(0, 3));
}

/** Похожесть заголовков по множествам слов (дедупликация перепечаток). */
export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Значимые слова заголовка (без коротких служебных). */
export function keyTokens(title: string): string[] {
  return tokens(title).filter((t) => t.length >= 4 || /\d/.test(t));
}
