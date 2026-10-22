/**
 * Детерминированная чистка текста статьи (без ИИ, аудит текстов раунд 2 — text-v2.md, п. 2):
 *  • длинное/среднее тире → запятая (короткий зачин перед тире → двоеточие), диапазон чисел «2–3» → «2-3»,
 *    дефисы в составных словах не трогаем;
 *  • британское написание → американское (colour → color, favourite → favorite, -ise → -ize) для англоязычных
 *    сайтов США;
 *  • парность <p>…</p> (никаких </p></p>) — balanceParagraphs на каждой секции и на итоговом HTML;
 *  • слова-пустышки в URL (cute, trendy, ideas, for-women…) вне ключа.
 * Плюс стоп-лист выдуманного опыта и штампов и поиск оборотов, которые повторяются из статьи в статью на сайте
 * (используется проверкой после записи секций, worker/articles/stages/sections.ts).
 * Все функции чистые и идемпотентные: повторный проход ничего не меняет.
 */
import { balanceParagraphs } from "./textGuards";

// ───────────────────────── язык сайта ─────────────────────────

/** Страны, где принято британское написание: там colour не трогаем. */
const NON_US_ENGLISH = new Set(["GB", "UK", "IE", "AU", "NZ", "ZA", "IN", "SG"]);

/** Американское написание: язык английский (или не задан — по умолчанию сайты en/US) и страна не из британской группы. */
export function usesUsSpelling(language: unknown, country: unknown): boolean {
  const lang = String(language ?? "").trim().toLowerCase();
  const c = String(country ?? "").trim().toUpperCase();
  if (lang && !lang.startsWith("en")) return false;
  if (/^EN[-_](GB|AU|NZ|IE|ZA|IN)$/i.test(String(language ?? "").trim())) return false;
  return !NON_US_ENGLISH.has(c);
}

// ───────────────────────── тире ─────────────────────────

/** Тире в одном текстовом фрагменте (без тегов). */
export function fixDashesText(text: string): string {
  let s = String(text ?? "");
  if (!/[—–]|\s--\s/.test(s)) return s;
  s = s.replace(/\s--\s/g, " — ");
  // Диапазоны чисел: «2–3 weeks», «7—10 days» → «2-3».
  s = s.replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2");
  // Среднее тире без пробелов внутри слова — дефис составного слова («mid–length» → «mid-length»).
  s = s.replace(/([A-Za-z])–([A-Za-z])/g, "$1-$2");
  // Тире в начале или в конце фрагмента (перед </p>) просто убираем.
  s = s.replace(/^(\s*)[—–]\s*/, "$1").replace(/\s*[—–]\s*$/, "");
  // Короткий зачин-подлежащее («The fix», «One rule», «Your move») перед тире → двоеточие: «The fix — a thin top coat».
  // Если в том же предложении есть второе тире, это вставка «X — aside — Y», и двоеточие не ставим.
  s = s.replace(/(^|[.!?]\s+|^\s+)((?:The|One|Your|This|That|A|An|Our|Every|Each|Rule|Bottom)\s+(?:[A-Za-z'’]+\s+)?[A-Za-z'’]+)\s*[—–]\s*(?=\S)/g, (m: string, pre: string, lead: string, offset: number, all: string) => {
    const rest = all.slice(offset + m.length);
    const sentence = rest.split(/[.!?](?:\s|$)/)[0];
    return /[—–]/.test(sentence) ? m : `${pre}${lead}: `;
  });
  // После тире новое предложение с местоимением («— it's pure sunshine», «— there is nowhere to hide») → точка и
  // заглавная буква, чтобы не получить склейку запятой. Только если в предложении нет второго тире (вставки).
  s = s.replace(/\s*[—–]\s*(it|it's|its|this|that's|there|there's|they|they're|you|you're|we|I|I'm|she|he|who|what|which|getting|nothing|everything)\b/g, (m: string, w: string, offset: number, all: string) => {
    const rest = all.slice(offset + m.length);
    const sentence = rest.split(/[.!?](?:\s|$)/)[0];
    const headSentence = all.slice(0, offset).split(/[.!?]\s+/).pop() ?? "";
    return /[—–]/.test(sentence) || /[—–]/.test(headSentence) ? m : `. ${w[0].toUpperCase()}${w.slice(1)}`;
  });
  // После тире целое предложение (подлежащее + глагол: «— the powder application requires…») → точка и заглавная,
  // иначе запятая склеивала два предложения (аудит text-v3, §1.1: «This is a salon-only finish, the powder…»).
  s = s.replace(/\s*[—–]\s*([A-Za-z][\w'’-]*)/g, (m: string, w: string, offset: number, all: string) => {
    const rest = all.slice(offset + m.length);
    const sentence = `${w}${rest.split(/[.!?](?:\s|$)/)[0]}`;
    const headSentence = all.slice(0, offset).split(/[.!?]\s+/).pop() ?? "";
    if (/[—–]/.test(sentence) || /[—–]/.test(headSentence)) return m;
    if (headSentence.trim().split(/\s+/).filter(Boolean).length < 3 || !looksLikeClause(sentence)) return m;
    return `. ${w[0].toUpperCase()}${w.slice(1)}`;
  });
  // Остальное — запятая: вставки «X — aside — Y» → «X, aside, Y».
  s = s.replace(/\s*[—–]\s*/g, ", ");
  // Уборка: двойные знаки, запятая перед точкой, запятая сразу после конца предложения.
  s = s
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?;:])/g, "$1")
    .replace(/:\s*,/g, ":")
    .replace(/([.!?])\s*,\s*/g, "$1 ")
    .replace(/ {2,}/g, " ");
  return s;
}

/** С чего начинается самостоятельное предложение (подлежащее). */
const CLAUSE_START = new Set([
  "the", "a", "an", "each", "this", "that", "these", "those", "every", "your", "its", "their", "it", "they", "you",
  "she", "he", "we", "one", "both", "most", "many", "some", "all", "nothing", "no", "any", "neither", "either", "our",
  "his", "her", "plus", "chrome", "gel", "acrylic", "polish",
]);
/** Глаголы, по которым видно сказуемое (короткий список частых в текстах статей). */
const CLAUSE_VERB = new Set([
  "is", "are", "was", "were", "has", "have", "had", "needs", "need", "requires", "require", "keeps", "keep", "makes",
  "make", "works", "work", "gives", "give", "adds", "add", "reads", "sits", "sit", "looks", "lasts", "last", "takes",
  "take", "holds", "hold", "can", "will", "should", "must", "does", "do", "stays", "stay", "goes", "helps", "help",
  "lets", "turns", "feels", "comes", "means", "matters", "creates", "shows", "suits", "wears", "grows", "chips",
  "tends", "stops", "softens", "balances", "pulls", "draws", "ties", "breaks", "catches", "hides", "blurs", "fades",
  "lifts", "gets", "costs", "lands", "pairs", "plays", "brings", "carries", "anchors", "grounds", "isn't", "aren't",
  "won't", "can't", "doesn't", "don't", "it's", "that's", "there's", "they're", "you're",
]);
const RELATIVE = new Set(["that", "which", "who", "whose", "where", "when", "while", "because", "if", "so"]);

/**
 * Похоже ли на самостоятельное предложение: начинается с подлежащего, 5+ слов, глагол стоит раньше любого
 * относительного слова («the kind that hides grow-out» — не предложение, а уточнение).
 */
export function looksLikeClause(text: string): boolean {
  const words = String(text ?? "").toLowerCase().replace(/[’]/g, "'").split(/[^a-z']+/).filter(Boolean);
  if (words.length < 5 || !CLAUSE_START.has(words[0])) return false;
  for (let i = 1; i < Math.min(words.length, 9); i++) {
    if (RELATIVE.has(words[i])) return false;
    if (CLAUSE_VERB.has(words[i])) return true;
  }
  return false;
}

/** Тире в заголовке H2/H1: хвост «X — Y» → «X, Y» (в заголовках двоеточие не ставим). */
export function fixDashesHeading(heading: string): string {
  return String(heading ?? "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    // Тире перед связкой («Outfits – for Mini Skirts») — просто пробел.
    .replace(/\s*[—–]\s*(?=(?:for|with|to|that|from|in|on|at|by|and)\b)/gi, " ")
    .replace(/([A-Za-z])–([A-Za-z])/g, "$1-$2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ───────────────────────── американское написание ─────────────────────────

/** Слова на -our → -or (только корни из списка, чтобы не задеть «hour», «four», «tour», «pour»). */
const OUR_ROOTS = "colo|favo|flavo|hono|neighbo|behavio|humo|labo|odo|armo|vigo|rumo|savo|endeavo|parlo|harbo|splendo|valo|rigo|ardo|fervo|clamo";
const OUR_RE = new RegExp(`\\b(${OUR_ROOTS})ur(s|ed|ing|ful|fully|less|ist|ists|ite|ites|y|ation|able|ably|ings)?\\b`, "gi");
/** Корни глаголов на -ise → -ize (явный список: «rise», «wise», «precise», «exercise», «advise» не трогаем). */
const ISE_ROOTS = "organ|real|recogn|personal|custom|minim|maxim|emphas|priorit|accessor|moistur|modern|final|optim|apolog|categor|critic|summar|standard|util|visual|energ|harmon|sanit|character|glamor|glamour|neutral|central|stabil|steril|symbol|familiar|memor|special|theor|tantal|mesmer|revolution|jeopard|synchron|hypnot|dramat|romantic|winter|summer|textur|volum|polar|capital|individual|natural|normal|equal|immun|pressur|caramel|crystall";
const ISE_RE = new RegExp(`\\b(${ISE_ROOTS})is(e|ed|es|ing|er|ers|ation|ations)\\b`, "gi");
/** Отдельные слова. */
const WORD_MAP: Record<string, string> = {
  grey: "gray", greys: "grays", greyish: "grayish", greying: "graying",
  centre: "center", centres: "centers", centred: "centered",
  metre: "meter", metres: "meters", theatre: "theater", fibre: "fiber", fibres: "fibers",
  jewellery: "jewelry", travelled: "traveled", travelling: "traveling", traveller: "traveler",
  cancelled: "canceled", cancelling: "canceling", labelled: "labeled", labelling: "labeling",
  modelled: "modeled", modelling: "modeling", levelled: "leveled", jewelled: "jeweled",
  catalogue: "catalog", catalogues: "catalogs", cosy: "cozy", cosier: "cozier", cosiest: "coziest",
  pyjamas: "pajamas", sceptical: "skeptical", sceptic: "skeptic", whilst: "while", amongst: "among",
  mould: "mold", moulded: "molded", practise: "practice", practised: "practiced", licence: "license",
  defence: "defense", offence: "offense", programme: "program", tyre: "tire", plough: "plow",
  aeroplane: "airplane", aluminium: "aluminum", learnt: "learned",
  manoeuvre: "maneuver", oestrogen: "estrogen", ageing: "aging", towelling: "toweling", storey: "story",
};
const WORD_RE = new RegExp(`\\b(${Object.keys(WORD_MAP).join("|")})\\b`, "gi");

/** Сохранить регистр исходного слова: Colour → Color, COLOUR → COLOR. */
function keepCase(src: string, out: string): string {
  if (src === src.toUpperCase() && /[A-Z]/.test(src) && src.length > 1) return out.toUpperCase();
  if (src[0] && src[0] === src[0].toUpperCase() && /[A-Za-z]/.test(src[0])) return out[0].toUpperCase() + out.slice(1);
  return out;
}

/** Британское → американское написание в фрагменте текста. */
export function toUsSpellingText(text: string): string {
  let s = String(text ?? "");
  s = s.replace(OUR_RE, (m, root: string, suf: string | undefined) => keepCase(m, `${root}r${suf ?? ""}`.toLowerCase()));
  s = s.replace(ISE_RE, (m, root: string, suf: string) => {
    const r = root.toLowerCase() === "glamour" ? "glamor" : root.toLowerCase();
    const tail = suf.toLowerCase().startsWith("ation") ? `ization${suf.slice(5)}` : `iz${suf}`;
    return keepCase(m, `${r}${tail}`.toLowerCase());
  });
  s = s.replace(WORD_RE, (m) => keepCase(m, WORD_MAP[m.toLowerCase()] ?? m));
  return s;
}

// ───────────────────────── HTML ─────────────────────────

/** Применить преобразование только к тексту вне тегов (атрибуты и имена тегов не трогаем). */
export function mapTextNodes(html: string, fn: (t: string) => string): string {
  return String(html ?? "")
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith("<") && part.endsWith(">") ? part : fn(part)))
    .join("");
}

export type PolishOpts = { usSpelling?: boolean };

/**
 * Полная детерминированная чистка HTML текста автора: тире, американское написание, парность абзацев,
 * лишние пробелы. Идемпотентна — безопасно вызывать на каждом этапе (секции, вступление, сборка).
 */
export function polishHtml(html: unknown, opts: PolishOpts = {}): string {
  let s = String(html ?? "");
  if (!s.trim()) return s;
  // Буквальные «\n» из JSON-ответа модели (вступление zorvianix/red french, 2026-10-15) — граница абзаца, а не текст.
  s = s.replace(/(?:\\n|\\r)+/g, "\n");
  if (/\n/.test(s)) s = s.replace(/<p([^>]*)>([\s\S]*?)<\/p>/gi, (_m, attrs: string, inner: string) => inner.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => `<p${attrs}>${x}</p>`).join("")).replace(/\n+/g, " ");
  s = mapTextNodes(s, (t) => {
    let x = fixDashesText(t);
    // Склеенные предложения «after a week.Apply cuticle oil» — пробел после точки перед словом с заглавной.
    x = x.replace(/([a-z\)])([.!?])([A-Z][a-z])/g, "$1$2 $3");
    if (opts.usSpelling) x = toUsSpellingText(x);
    return x.replace(/ +([,.!?;:])/g, "$1");
  });
  // Запятая у края абзаца (после замены тире): в начале — вон, в конце — точка.
  s = s.replace(/<p([^>]*)>\s*,\s*/gi, "<p$1>").replace(/\s*,\s*<\/p>/gi, ".</p>");
  s = balanceParagraphs(s).replace(/<\/p>\s*<\/p>/gi, "</p>").replace(/<p[^>]*>\s*<\/p>\s*/gi, "");
  return s;
}

/** Чистка заголовка: тире и американское написание. */
export function polishHeading(heading: unknown, opts: PolishOpts = {}): string {
  let s = fixDashesHeading(String(heading ?? ""));
  if (opts.usSpelling) s = toUsSpellingText(s);
  return titleCaseHeading(s);
}

const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "nor", "but", "for", "of", "in", "on", "at", "to", "by", "from", "with", "vs", "via", "as", "into", "per"]);

/**
 * Один регистр для всех заголовков (аудит woman-trend 2026-10-22: у нарядов «Strapless evening gown with high slit»,
 * у волос — «Collarbone Lob With Caramel Lowlights»): каждое слово с заглавной, служебные (a, for, with…) — строчные,
 * кроме первого/последнего и после двоеточия. Слова с внутренними заглавными или цифрами (3D, McQueen, 2027) не трогаем.
 */
export function titleCaseHeading(s: string): string {
  const parts = String(s || "").split(/(\s+)/);
  const words = parts.filter((w) => w && !/^\s+$/.test(w));
  let idx = -1;
  let prev = "";
  return parts
    .map((w) => {
      if (!w || /^\s+$/.test(w)) return w;
      idx++;
      const afterColon = /[:—–]$/.test(prev);
      prev = w;
      if (/\d/.test(w) || /[A-Z]/.test(w.slice(1)) || /\{\{/.test(w)) return w;
      const bare = w.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
      if (idx > 0 && idx < words.length - 1 && !afterColon && SMALL_WORDS.has(bare)) return w.toLowerCase();
      return w.toLowerCase().replace(/(^|[-/(])([a-z])/g, (_m, a: string, c: string) => a + c.toUpperCase());
    })
    .join("");
}

// ───────────────────────── URL ─────────────────────────

/** Слова-пустышки URL: в ключе их нет — из адреса убираются («chic-micro-french-nails-for-women» → «micro-french-nails»). */
export const SLUG_FILLER = new Set([
  "cute", "trendy", "best", "top", "chic", "classy", "elegant", "pretty", "stylish", "aesthetic", "cool", "fresh",
  "popular", "amazing", "stunning", "gorgeous", "perfect", "ultimate", "ideas", "idea", "inspo", "inspiration",
  "designs", "design", "looks", "look", "gallery", "picks", "examples", "to", "try", "for", "women", "woman",
  "girls", "her", "you", "simple", "easy", "modern", "soft", "bold",
]);

/**
 * Убрать из URL слова-пустышки вне блока ключа. Блок ключа (`kwSlug`) и год остаются как есть;
 * слово, которое есть в самом ключе, пустышкой не считается.
 */
export function stripSlugFiller(slug: string, kwSlug: string, year = ""): string {
  const s = String(slug ?? "").toLowerCase();
  if (!kwSlug || !`-${s}-`.includes(`-${kwSlug}-`)) {
    // Ключа в адресе нет — чистим всё, кроме слов ключа
    const kw = new Set(String(kwSlug || "").split("-").filter(Boolean));
    return s.split("-").filter((w) => w && (kw.has(w) || !SLUG_FILLER.has(w))).join("-");
  }
  const i = `-${s}-`.indexOf(`-${kwSlug}-`);
  const before = s.slice(0, Math.max(0, i - 1)).split("-").filter(Boolean);
  const after = s.slice(i + kwSlug.length).split("-").filter(Boolean);
  const kwWords = new Set(kwSlug.split("-"));
  const keep = (w: string) => (year && w === year) || kwWords.has(w) || !SLUG_FILLER.has(w);
  return [...before.filter(keep), kwSlug, ...after.filter(keep)].join("-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

// ───────────────────────── стоп-лист ─────────────────────────

type Banned = { re: RegExp; kind: "invented" | "cliche" | "service" };

/**
 * Выдуманный опыт, штампы и служебные слова плана, найденные аудитами 14 и 15.10 (text.md, text-v2.md).
 * Регулярки без флага g: ищем первое вхождение каждой.
 */
const BANNED: Banned[] = [
  // выдуманный личный опыт
  { kind: "invented", re: /\bI(?:'ve| have)? (?:wore|worn|tried|tested|booked|painted|bleached|grew out|wear|got (?:so many|three|two|four|\d+))\b/i },
  { kind: "invented", re: /\bmine (?:held|lasted|stayed|grew|survived|chipped|went|looked|showed)\b/i },
  { kind: "invented", re: /\bmy (?:go-to|nail tech|tech|stylist|colou?rist|own (?:nails|hair|set|shag|bob|cut)|roots|chrome|manicure|mani|wedding|road trip)\b/i },
  { kind: "invented", re: /\b(?:I'm|I am|I'll be) (?:booking|getting|trying)\b/i },
  { kind: "invented", re: /\bbooking the\b/i },
  { kind: "invented", re: /\bcompliments\b/i },
  { kind: "invented", re: /\bI was (?:skeptical|sceptical|wrong|surprised)\b/i },
  { kind: "invented", re: /\bI(?:'ll| will| have to| must) admit\b/i },
  { kind: "invented", re: /\bI changed my mind\b/i },
  { kind: "invented", re: /\bafter writing (?:all )?(?:of )?(?:these|them|this)\b/i },
  { kind: "invented", re: /\bchair next to (?:mine|hers|me)\b/i },
  { kind: "invented", re: /\bflat by (?:4|four)\b/i },
  { kind: "invented", re: /\bthe tech told me\b/i },
  // штампы
  { kind: "cliche", re: /\bnot a sunday\b/i },
  { kind: "cliche", re: /\bbathroom[- ]mirror job\b/i },
  { kind: "cliche", re: /\b(?:doesn't|does not|without) (?:shout|shouting|scream|screaming)\b/i },
  { kind: "cliche", re: /\bcatch(?:es|ing)? (?:the|every) light\b/i },
  { kind: "cliche", re: /\bthe ultimate\b/i },
  { kind: "cliche", re: /\bgame[- ]changer\b/i },
  { kind: "cliche", re: /\bnon[- ]negotiable\b/i },
  { kind: "cliche", re: /\bthe principle\b/i },
  { kind: "cliche", re: /\b(?:here's|here is) the verdict\b|\bthe verdict(?: is|:)/i },
  { kind: "cliche", re: /\bmasterclass\b/i },
  { kind: "cliche", re: /\b(?:intentional|deliberate) rather than accidental\b/i },
  { kind: "cliche", re: /\bwithout trying too hard\b/i },
  { kind: "cliche", re: /\bheavy lifting\b/i },
  { kind: "cliche", re: /\beffortless(?:ly)?\b/i },
  { kind: "cliche", re: /\bstunning\b/i },
  { kind: "cliche", re: /\belevates?\b|\belevated\b/i },
  // «Whether you're», «Whether you need/have/want…» — любой зачин «whether you» (аудит text-v3: 4 из 6 вступлений)
  { kind: "cliche", re: /\bwhether you\b/i },
  { kind: "cliche", re: /\bwe've rounded up\b/i },
  { kind: "cliche", re: /\bvibes?\b/i },
  // аудит text-v3: новые штампы на месте старых
  { kind: "cliche", re: /\bcostume(?:y|-y|like)?\b/i },
  { kind: "cliche", re: /\bafterthought\b/i },
  { kind: "cliche", re: /\bthe honest downside\b/i },
  { kind: "cliche", re: /\bflatter(?:s|ing)? (?:every|all|any) skin ?tones?\b|\bworks on every skin ?tone\b/i },
  { kind: "cliche", re: /\breads as (?:intentional|deliberate|polished|effortless)\b/i },
  { kind: "cliche", re: /\bwe've (?:included|gathered|collected)\b/i },
  { kind: "cliche", re: /\bas dynamic as\b/i },
  // служебные слова плана и описание кадра
  { kind: "service", re: /\bhero piece\b/i },
  { kind: "service", re: /\bpicture this\b/i },
  { kind: "service", re: /\bno (?:footwear|shoes?|accessories|bag|jewe(?:l)?lery)\b[^.]{0,30}\b(?:is|are) (?:visible|shown|in (?:the )?(?:frame|shot))/i },
  { kind: "service", re: /\b(?:in|from) the (?:photo|picture|image|shot)\b|\bpictured (?:above|here)\b|\bas you can see\b/i },
];

/** Текст без тегов, с прямыми апострофами и кавычками (изогнутый «’» пропускал «Whether you’re» — аудит text-v3). */
export function plainText(html: unknown): string {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Найденные фразы стоп-листа (уникальные, как в тексте). Слово из ключа статьи стоп-листом не считается
 * («costume nails» — тема, а не штамп).
 */
export function findBannedPhrases(html: unknown, opts: { keyword?: string | null } = {}): string[] {
  const text = plainText(html);
  const kw = String(opts.keyword ?? "").toLowerCase();
  const out = new Set<string>();
  for (const b of BANNED) {
    const m = text.match(b.re);
    if (m && !(kw && kw.includes(m[0].toLowerCase()))) out.add(m[0]);
  }
  return [...out];
}

/**
 * Обороты с потолком на статью: сами по себе нормальны, но затёрты повтором (аудит text-v3: «rather than» 7,7 и
 * «reads as» 5,7 на статью). Всё, что сверх потолка, — проблема секции, где встретилось (первые вхождения не трогаем).
 */
export const ARTICLE_QUOTAS: Array<{ re: RegExp; max: number; label: string }> = [
  { re: /\brather than\b/gi, max: 2, label: "rather than" },
  { re: /\breads? as\b/gi, max: 2, label: "reads as" },
  { re: /\b(?:intentional|deliberate)\b/gi, max: 2, label: "intentional / deliberate" },
  { re: /\bsalon-only\b/gi, max: 2, label: "salon-only" },
];

/** Секции (индексы), где оборот встречается сверх потолка статьи, с подписью оборота. */
export function quotaOveruse(sections: string[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const q of ARTICLE_QUOTAS) {
    let seen = 0;
    sections.forEach((html, i) => {
      const n = (plainText(html).match(q.re) || []).length;
      if (!n) return;
      seen += n;
      // в секции есть вхождения сверх потолка статьи, или оборот дважды в одной секции
      if (seen > q.max || n >= 2) out.set(i, [...(out.get(i) ?? []), q.label]);
    });
  }
  return out;
}

/** Метка проблемы «нет пунктуации»: её видит перепись и превращает в инструкцию. */
export const NO_COMMAS_ISSUE = "no commas (punctuation lost)";

/**
 * Секция длиннее 50 слов без единой запятой — пунктуация потеряна (аудит text-v3: leather 11–14 целиком без запятых,
 * «To recreate it look for a straight midi skirt with a slit a classic bomber»). Это дефект, секция уходит в перепись.
 */
export function lacksPunctuation(html: unknown): boolean {
  const text = plainText(html);
  const words = text.split(/\s+/).filter(Boolean).length;
  return words > 50 && !text.includes(",");
}

/** Короткий стоп-лист для промта автора (дублирует промты набора на случай, если их правили в портале). */
export const BANNED_PROMPT_LINE =
  'NEVER write first-person claims of wearing, testing, booking or getting compliments ("I wore", "mine lasted", "I was skeptical", "I\'ll admit", "I\'m booking"), and never use: "the principle", "the verdict", "masterclass", "intentional rather than accidental", "without trying too hard", "heavy lifting", "hero piece", "picture this", "doesn\'t shout", "catches the light", "not a Sunday", "the chair next to mine", "flat by 4 pm", "effortless", "stunning", "elevate", "whether you", "vibe", "costume", "afterthought", "the honest downside", "flatters every skin tone", "reads as intentional", "we\'ve included". "Rather than" and "reads as" at most twice per article. Never claim a shade suits a skin tone or undertone unless the photo facts say so. No em dashes or en dashes. Normal punctuation: commas between clauses, apostrophes in possessives and contractions, a question mark after a question. Use American spelling (color, favorite). Never describe what is NOT visible.';

// ───────────────────────── повторы между статьями ─────────────────────────

/** Служебные слова: шаблонный оборот почти всегда содержит 2+ таких слова, содержательный совет — 0–1. */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "i", "i'm", "i've", "i'll", "i'd", "me", "my", "mine", "you", "you're", "your", "yours", "we", "our",
  "it", "it's", "its", "this", "that", "these", "those", "there", "here", "here's", "what", "which", "who", "when",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "don't", "doesn't", "have", "has", "had",
  "will", "would", "can", "could", "should", "to", "of", "in", "on", "at", "by", "for", "with", "from", "into", "next",
  "and", "or", "but", "so", "if", "than", "then", "not", "no", "just", "only", "every", "all", "one", "more", "most",
  "she", "her", "hers", "they", "them", "their", "up", "out", "about", "over", "after", "before", "like", "as",
]);

/**
 * Обязательные обороты каркаса секции: их требует промт, повтор из секции в секцию задуман (аудит text-v3, §5:
 * «To recreate it, look for» у одежды уходил в перепись). Из поиска шаблонов они вырезаются целиком.
 */
const STRUCTURAL_RE =
  /\bto recreate (?:it|this|the look|this look)\s*,?\s*look for\b|\b(?:ask|tell) your (?:nail )?(?:tech|technician|colou?rist|stylist|barber)(?: for)?\b|\blook for (?:an?|the)\b/gi;
/** Граница вместо вырезанного оборота: n-грамма через неё не строится. */
const BREAK = "zzbreakzz";

/** Слова текста для n-грамм: нижний регистр, без тегов и пунктуации (апостроф внутри слова сохраняется). */
export function wordsOf(html: unknown): string[] {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[’]/g, "'")
    .replace(STRUCTURAL_RE, ` ${BREAK} `)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/**
 * Слова обязательного каркаса секции («ask your tech for», «tell your stylist») — их повтор между статьями задуман
 * промтом и шаблоном не считается.
 */
const SKELETON_WORDS = new Set(["ask", "asking", "tell", "tech", "technician", "stylist", "colorist", "colourist", "barber", "salon", "recreate", BREAK]);
/**
 * Числа словами — это сроки и интервалы («every four to six weeks», «for two to three weeks»), а не штамп голоса:
 * аудит text-v3 — половина ложных срабатываний проверки после записи.
 */
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fourteen",
  "fifteen", "twenty", "thirty", "forty", "few", "couple", "half", "dozen", "once", "twice", "first", "second", "third",
]);
/**
 * Предметные слова ниш: оборот с ними — совет по делу («a thin top coat», «a round brush on»), а не шаблон голоса.
 * Известные шаблоны с такими словами («flat by 4 pm») ловит стоп-лист BANNED.
 */
const DOMAIN_WORDS = new Set([
  "coat", "top", "base", "oil", "cuticle", "cuticles", "brush", "acetone", "gel", "polish", "chrome", "tip", "tips", "shape", "length",
  "nail", "nails", "bed", "beds", "file", "lamp", "hair", "cut", "trim", "trims", "weeks", "week", "days", "day", "months", "shampoo",
  "heat", "layers", "bangs", "fringe", "root", "roots", "toner", "color", "colors", "shade", "shades", "part", "ends", "shoes", "heels",
  "boots", "sneakers", "jeans", "skirt", "dress", "jacket", "blazer", "bag", "belt", "waist", "hem", "knee", "ankle", "sleeves",
  "handbag", "tote", "sunglasses", "earrings", "hoop", "hoops", "necklace", "scarf", "shirt", "t", "tee", "sweater", "cardigan", "hoodie",
  "turtleneck", "trench", "denim", "leather", "trousers", "pants", "shorts", "tights", "socks", "loafers", "sandals", "flats", "mary",
  "janes", "jane", "texture", "curls", "waves", "wavy", "curly", "straight", "bob", "shag", "lob", "pixie", "grow", "growing", "volume",
  "finish", "glossy", "matte", "french", "almond", "coffin", "square", "oval", "stiletto", "nude", "pink", "red", "white", "black",
  "brown", "blue", "green", "yellow", "gray", "grey", "beige", "navy", "gold", "silver",
]);

/**
 * Шаблонная ли 4-грамма: 2–3 служебных слова из 4 (чисто служебные «it is a the» и содержательные советы — нет),
 * без цифр (сроки и длины — факты) и без слов каркаса.
 */
function templateLike(gram: string[]): boolean {
  if (gram.some((w) => /\d/.test(w) || SKELETON_WORDS.has(w) || DOMAIN_WORDS.has(w) || NUMBER_WORDS.has(w))) return false;
  const f = gram.filter((w) => FUNCTION_WORDS.has(w)).length;
  return f >= 2 && f <= 3;
}

export function ngramsOf(html: unknown, n = 4): Set<string> {
  const w = wordsOf(html);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n);
    if (templateLike(g)) out.add(g.join(" "));
  }
  return out;
}

/**
 * Обороты, повторяющиеся в `minArticles`+ статьях сайта (по текстам последних статей). Слова ключа текущей статьи
 * не считаются шаблоном (тема у статей сайта общая). Возвращает до `limit` самых частых.
 */
export function overusedPhrases(articles: string[][], opts: { minArticles?: number; limit?: number; keyword?: string } = {}): string[] {
  const min = opts.minArticles ?? 3;
  const kw = keywordWords(opts.keyword);
  const count = new Map<string, number>();
  for (const texts of articles) {
    const seen = new Set<string>();
    for (const t of texts) for (const g of ngramsOf(t)) seen.add(g);
    for (const g of seen) count.set(g, (count.get(g) ?? 0) + 1);
  }
  return [...count.entries()]
    .filter(([g, c]) => c >= min && !g.split(" ").some((w) => kw.has(w)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.limit ?? 40)
    .map(([g]) => g);
}

/** Какие из шаблонных оборотов есть в тексте секции. */
export function findOverused(html: unknown, overused: Iterable<string>): string[] {
  const grams = ngramsOf(html);
  const out: string[] = [];
  for (const g of overused) if (grams.has(g)) out.push(g);
  return out;
}

/**
 * Оборот в том виде, как он стоит в тексте, со знаками препинания («to recreate it, look for», а не «to recreate it
 * look for»). Автору показываем именно так: образцы без запятых и апострофов deepseek копировал вместе с потерей
 * пунктуации (аудит text-v3, §4 п.3). Не нашли — исходная форма.
 */
export function surfaceForm(texts: Iterable<string>, gram: string): string {
  const target = gram.split(" ");
  for (const html of texts) {
    const text = plainText(html);
    const tokens: Array<{ w: string; start: number; end: number }> = [];
    for (const m of text.matchAll(/[A-Za-z0-9']+/g)) {
      const w = m[0].toLowerCase().replace(/^'+|'+$/g, "");
      if (w) tokens.push({ w, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
    for (let i = 0; i + target.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < target.length && ok; k++) ok = tokens[i + k].w === target[k];
      if (ok) return text.slice(tokens[i].start, tokens[i + target.length - 1].end);
    }
  }
  return gram;
}

/** Слова ключа (с простым отбрасыванием окончания -s): оборот с ними — тема статьи, а не шаблон. */
function keywordWords(keyword: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of wordsOf(keyword ?? "")) {
    if (FUNCTION_WORDS.has(w)) continue;
    out.add(w);
    out.add(w.replace(/s$/, ""));
    out.add(`${w.replace(/s$/, "")}s`);
  }
  return out;
}

/** Обороты, повторённые в `min`+ секциях одной статьи (внутри статьи шаблон заметнее всего). */
export function repeatedWithinArticle(sections: string[], min = 3, keyword?: string): string[] {
  const kw = keywordWords(keyword);
  const count = new Map<string, number>();
  for (const t of sections) for (const g of ngramsOf(t)) count.set(g, (count.get(g) ?? 0) + 1);
  return [...count.entries()].filter(([g, c]) => c >= min && !g.split(" ").some((w) => kw.has(w))).map(([g]) => g);
}
