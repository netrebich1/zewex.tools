import { chatJson, type AiCtx } from "./llm";
import { fetchText } from "./fetch";
import { CATEGORY_LABELS, SLOT_BRIEF, SLOT_CLASSIFY, type NewsSettings } from "./types";

/**
 * Этап 2: украинская суть карточки и «почему зайдёт у нас» (в прогоне, пачками), углы по кнопке «В работу»,
 * ТЗ для Claude по выбранному углу — в стиле редакции проекта. ТЗ собирается из JSON модели в одинаковый markdown.
 */

export type SourceForAi = { domain: string; title: string; lead: string; url: string; tier: string; at: Date };
export type ClusterForAi = { id: string; title: string; category: string | null; subcategory: string | null; entity: string | null; signals: string[]; sources: SourceForAi[] };
export type Summary = { id: string; titleUk: string; summaryUk: string; whyUs: string };
export type Angle = { title: string; angle: string; why: string; novelty: number; usefulness: number; kind: string; format?: string };
export type OurArticle = { title: string; url: string };

const s = (v: unknown, max = 2000) => String(v ?? "").trim().slice(0, max);
const n15 = (v: unknown) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));
const srcText = (c: ClusterForAi, perLead = 500) =>
  c.sources.slice(0, 8).map((x, i) => `${i + 1}. [${x.tier === "world" ? "світове медіа" : "українське медіа"}] ${x.domain}: ${x.title}${x.lead ? ` — ${x.lead.slice(0, perLead)}` : ""}`).join("\n");

/** Суть по-украински для пачки до 5 кластеров (дешёвая модель классификации). */
export async function summarizeClusters(ctx: AiCtx, st: NewsSettings, list: ClusterForAi[]): Promise<Summary[]> {
  const system = `Ти редактор українського медіа. Про сайт: ${st.siteAbout}
Для кожної новини (id) дай:
- title_uk: нейтральний заголовок українською до 90 символів (якщо джерела англійською — переклади суть, не дослівно; імена — як прийнято в українських медіа);
- summary_uk: 2–3 речення українською — хто, що, де, коли; лише факти з джерел, спірне познач «за даними …»;
- why_us: 1–2 речення українською — чому це зайде саме нашій аудиторії і на чому зробити акцент (практична користь, впізнаваний герой, образ, ціна, тренд). Якщо тема слабка для нас — чесно скажи чому.
Поверни лише JSON: {"items":[{"id":"…","title_uk":"…","summary_uk":"…","why_us":"…"}]}`;
  const user = list.map((c) => `### id: ${c.id}\nКатегорія: ${c.category ? CATEGORY_LABELS[c.category] ?? c.category : "—"}${c.entity ? `; герой: ${c.entity}` : ""}\nСигнали: ${c.signals.join("; ") || "—"}\nДжерела:\n${srcText(c, 400)}`).join("\n\n");
  const j = await chatJson(ctx, SLOT_CLASSIFY, system, user, ctx.classifyModel, 2500);
  const items = Array.isArray(j.items) ? (j.items as Record<string, unknown>[]) : [];
  return items
    .map((r) => ({ id: s(r.id, 64), titleUk: s(r.title_uk, 300), summaryUk: s(r.summary_uk, 1500), whyUs: s(r.why_us, 1000) }))
    .filter((x) => list.some((c) => c.id === x.id) && x.summaryUk);
}


/**
 * Формат статьи под Discover. Discover показывает материал по интересу к герою и картинке, а не по запросу:
 * побеждает момент + одна наша мысль, а не справочник. Формат выбирается по типу повода, объём — по формату.
 */
export const FORMATS: Record<string, { label: string; words: string; when: string }> = {
  moment: { label: "Момент", words: "250–400 слів", when: "фото/образ/вихід зірки, одна подія, 1–3 факти: новина + що це за образ або стрижка + одна наша ремарка" },
  news: { label: "Новина", words: "300–450 слів", when: "подія з кількома фактами: заручини, прем'єра, запуск, скандал — що сталося, що відомо, що далі" },
  look: { label: "Розбір образу", words: "350–500 слів", when: "образ варто розібрати по речах: бренд, ціна, де схоже купити в Україні — коротко, по пунктах" },
  howto: { label: "Як повторити", words: "450–650 слів", when: "лише якщо тренд справді масовий і читачка захоче повторити: 5–7 кроків, без енциклопедії" },
  list: { label: "Підбірка", words: "400–600 слів", when: "премія, тиждень моди, Геловін — 5–10 образів, по 1–2 речення на кожен, фото головне" },
  context: { label: "Що за цим стоїть", words: "400–550 слів", when: "новина має передісторію, яку читачка не знає: що було раніше, чому зараз, що буде" },
};
const FORMAT_KEYS = Object.keys(FORMATS);

const DISCOVER_RULES = `Правила Discover (Україна):
- Discover — стрічка за інтересами, не пошук. Читачка побачить картинку і заголовок; клікне, якщо впізнає героя і зрозуміє, що нового. Жодних «гайдів під запит».
- Заголовок: герой у перших 2–3 словах, конкретна нова деталь (стрижка, сукня, подія), 45–65 символів, без «як повторити», «гайд», «все що треба знати», без «шок/сенсація/не повірите», без трикрапки й капсу. Можна легке питання або інтригу, якщо текст її чесно закриває.
- Текст легкий: короткий лід у 2 речення, далі 3–5 коротких блоків, по 2–4 речення. Одна наша думка або порада, а не чотири розділи. Жодних списків «для круглого обличчя», цін по містах, історії стрижки з 1953 року.
- Факти лише з джерел. Деталі, яких нема в джерелах (ціни в салонах, назви засобів), не вигадувати — або прибрати, або позначити як завдання автору знайти.
- Фото вирішує: велике (1200 px+), герой або річ у центрі, без колажів із логотипами. Під кожне фото — ім'я файлу та alt з героєм.
- Теги = сутності (герой, бренд, подія); рубрика — одна.`;

/** 3 угла с форматом (кнопка «В работу»). */
export async function makeAngles(ctx: AiCtx, st: NewsSettings, c: ClusterForAi, ours: OurArticle[]): Promise<{ angles: Angle[]; competitorsAngle: string; gaps: string[] }> {
  const system = `Ти шеф-редактор українського жіночого медіа для Google Discover. Про сайт: ${st.siteAbout}
${DISCOVER_RULES}

Формати статті (format → коли доречний, обсяг):
${FORMAT_KEYS.map((k) => `- ${k} (${FORMATS[k].label}, ${FORMATS[k].words}): ${FORMATS[k].when}`).join("\n")}

Перед тобою публікації про одну подію (українські та світові) і наші схожі статті.
1. competitors_angle: одним реченням — як подали інші.
2. gaps: 2–3 пункти — що можна додати від себе одним абзацом (не розділом).
3. angles: рівно 3 кути, перший — найлегший і найближчий до самої події; кути мають різні формати. Для кожного:
   format — один із ${FORMAT_KEYS.join(" | ")}; title — заголовок українською за правилами Discover; angle — 1–2 речення, що саме пишемо і яка одна наша думка; why — чому клікнуть у Discover (герой, деталь, картинка), одним реченням; novelty і usefulness — 1–5.
Якщо інформаційний привід слабкий для нашої читачки (другорядна подія, герой маловідомий в Україні), скажи це в fit: «слабкий привід: …», інакше fit: «ok».
Поверни лише JSON: {"fit":"…","competitors_angle":"…","gaps":["…"],"angles":[{"format":"moment","title":"…","angle":"…","why":"…","novelty":4,"usefulness":4}]}`;
  const user = `Тема: ${c.title}\nКатегорія: ${c.category ? CATEGORY_LABELS[c.category] ?? c.category : "—"}${c.subcategory ? ` (${c.subcategory})` : ""}${c.entity ? `\nГерой: ${c.entity}` : ""}\nСигнали: ${c.signals.join("; ") || "—"}\n\nПублікації:\n${srcText(c, 700)}\n\nНаші схожі статті:\n${ours.map((o) => `- ${o.title} (${o.url})`).join("\n") || "— немає"}`;
  const j = await chatJson(ctx, SLOT_BRIEF, system, user, st.briefModel, 2500);
  const angles = (Array.isArray(j.angles) ? (j.angles as Record<string, unknown>[]) : []).slice(0, 3).map((a) => {
    const f = s(a.format, 20).toLowerCase();
    const format = FORMAT_KEYS.includes(f) ? f : "news";
    return { kind: FORMATS[format].label, format, title: s(a.title, 160), angle: s(a.angle, 600), why: s(a.why, 400), novelty: n15(a.novelty), usefulness: n15(a.usefulness) };
  }).filter((a) => a.title && a.angle);
  if (!angles.length) throw new Error("Модель не предложила углы — нажмите ещё раз");
  const fit = s(j.fit, 300);
  const gaps = (Array.isArray(j.gaps) ? j.gaps : []).map((g) => s(g, 300)).filter(Boolean).slice(0, 4);
  if (fit && !/^ok\b/i.test(fit)) gaps.unshift(`⚠ ${fit}`);
  return { angles, competitorsAngle: s(j.competitors_angle, 400), gaps };
}

type BriefJson = {
  hook: string;
  whyNow: string;
  lead: string;
  facts: { fact: string; source: string }[];
  blocks: { h2: string; note: string }[];
  ourTouch: string[];
  todo: string[];
  photos: { shot: string; file: string; alt: string }[];
  headlines: { text: string; type: string }[];
  titles: string[];
  descriptions: string[];
  slugs: string[];
  tags: string[];
  rubric: string;
  og: string;
  dont: string[];
};

/** ТЗ по выбранному углу: короткое, под формат, с вариантами заголовков, title, description, slug и именами файлов. */
export async function makeBrief(ctx: AiCtx, st: NewsSettings, site: string, c: ClusterForAi, angle: Angle, ours: OurArticle[], summaryUk: string | null): Promise<string> {
  const fmt = FORMATS[angle.format ?? "news"] ?? FORMATS.news;
  const system = `Ти шеф-редактор українського жіночого медіа ${site} для Google Discover. Про сайт: ${st.siteAbout}
${DISCOVER_RULES}
Стиль редакції (коротко): ${st.houseStyle.split("\n").slice(0, 3).join(" ")}

Склади коротке ТЗ для автора. Формат: ${fmt.label} (${fmt.words}) — ${fmt.when}. Пиши українською. Факти лише з публікацій (номер джерела). Нічого не вигадуй: чого нема в джерелах — у todo як завдання автору перевірити.
Поверни лише JSON:
{"hook":"одне речення — що нового і чому читачка клікне",
"why_now":"одне речення — чому писати сьогодні",
"lead":"готовий лід, 2 речення: хто, що, де, коли + деталь",
"facts":[{"fact":"…","source":1}] — 3–6 фактів,
"blocks":[{"h2":"підзаголовок без клікбейту","note":"що в блоці, 1 речення"}] — рівно стільки, скільки потрібно формату (момент: 2–3; новина: 3–4; розбір/підбірка: 4–6), без H3,
"our_touch":["1–2 речі від себе одним абзацом кожна: порада, контекст, український аналог"],
"todo":["що автору перевірити або знайти самому, бо в джерелах цього немає"],
"photos":[{"shot":"що в кадрі","file":"ім'я файлу латиницею через дефіс з героєм і деталлю, напр. zendaya-pixie-wnba-finals.jpg","alt":"alt українською з героєм, до 110 символів"}] — 2–3 фото, перше головне 1200 px+,
"headlines":[{"text":"…","type":"новина|деталь|питання|емоція|користь"}] — 5 різних заголовків 45–65 символів, герой у перших словах,
"titles":["3 варіанти Title до 60 символів"],
"descriptions":["3 варіанти Description 110–155 символів: що побачить читачка + конкретна деталь"],
"slugs":["3 варіанти slug транслітом, 3–6 слів, з героєм, без дат"],
"tags":["сутності: герой, бренд, подія"],"rubric":"одна рубрика","og":"сюжет OG 1200×630",
"dont":["2–4 пункти чого не робити саме в цій статті"]}`;
  const user = `Тема: ${c.title}${summaryUk ? `\nСуть: ${summaryUk}` : ""}\nОбраний кут (${angle.kind}): ${angle.title} — ${angle.angle}\nЧому клікнуть: ${angle.why}\n\nПублікації (номер — джерело):\n${c.sources.slice(0, 8).map((x, i) => `${i + 1}. ${x.domain} — ${x.title}${x.lead ? `: ${x.lead.slice(0, 900)}` : ""}`).join("\n")}\n\nНаші статті для посилань:\n${ours.map((o) => `- ${o.title} (${o.url})`).join("\n") || "— немає"}`;
  const j = await chatJson(ctx, SLOT_BRIEF, system, user, st.briefModel, 4000, 150_000);
  const list = (v: unknown, max = 300) => (Array.isArray(v) ? v.map((x) => s(x, max)).filter(Boolean) : []);
  const arr = <T>(v: unknown, f: (x: Record<string, unknown>) => T) => (Array.isArray(v) ? (v as Record<string, unknown>[]).map(f) : []);
  const b: BriefJson = {
    hook: s(j.hook, 300),
    whyNow: s(j.why_now, 300),
    lead: s(j.lead, 700),
    facts: arr(j.facts, (x) => ({ fact: s(x.fact, 400), source: s(x.source, 10) })).filter((x) => x.fact).slice(0, 8),
    blocks: arr(j.blocks, (x) => ({ h2: s(x.h2, 160), note: s(x.note, 300) })).filter((x) => x.h2).slice(0, 7),
    ourTouch: list(j.our_touch, 400).slice(0, 3),
    todo: list(j.todo, 300).slice(0, 5),
    photos: arr(j.photos, (x) => ({ shot: s(x.shot, 200), file: s(x.file, 80).toLowerCase().replace(/[^a-z0-9.-]+/g, "-"), alt: s(x.alt, 160) })).filter((x) => x.shot).slice(0, 4),
    headlines: arr(j.headlines, (x) => ({ text: s(x.text, 120), type: s(x.type, 20) })).filter((x) => x.text).slice(0, 6),
    titles: list(j.titles, 120).slice(0, 4),
    descriptions: list(j.descriptions, 220).slice(0, 4),
    slugs: list(j.slugs, 100).map((x) => x.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).slice(0, 4),
    tags: list(j.tags, 60).slice(0, 10),
    rubric: s(j.rubric, 60),
    og: s(j.og, 300),
    dont: list(j.dont, 300).slice(0, 5),
  };
  return renderBrief(site, st, c, angle, fmt, b, ours, summaryUk);
}

const srcRef = (c: ClusterForAi, ref: string) => {
  const x = c.sources[Number(ref) - 1];
  return x ? ` (джерело ${ref}, ${x.domain})` : "";
};
const check = (text: string, min: number, max: number) => (text.length < min ? `⚠ ${text.length}, замало` : text.length > max ? `⚠ ${text.length}, забагато` : `${text.length}`);
const clickbait = (t: string) => /шок|сенсац|не повірит|\.\.\.|…|!{2,}/i.test(t);

function renderBrief(site: string, st: NewsSettings, c: ClusterForAi, angle: Angle, fmt: { label: string; words: string }, b: BriefJson, ours: OurArticle[], summaryUk: string | null): string {
  const hero = c.entity ? c.entity.split(" ").filter((w) => w.length > 2).map((w) => w.toLowerCase().slice(0, 5)) : [];
  const heroIn = (t: string) => !hero.length || hero.some((h) => t.toLowerCase().includes(h));
  const hl = (t: string) => `${t} — ${check(t, 45, 65)}${clickbait(t) ? " ⚠ клікбейт" : ""}${heroIn(t) ? "" : " ⚠ без героя"}`;
  const lines: string[] = [
    `# ТЗ (${fmt.label}, ${fmt.words}): ${b.headlines[0]?.text || angle.title}`,
    "",
    `> Напиши статтю для ${site} за цим ТЗ. Це матеріал для Google Discover: легкий, короткий, з героєм у заголовку. Лише факти з розділу «Факти»; що в «Автору перевірити» — знайди і підтверди або прибери. Поверни: H1, лід, текст із H2, підписи до фото, Title, Description, slug, теги.`,
    "",
    "## Суть",
    summaryUk || c.title,
    "",
    "## Гачок і чому зараз",
    `- Гачок: ${b.hook || angle.why}`,
    `- Чому зараз: ${b.whyNow || "подія свіжа, конкуренти вже пишуть"}`,
    `- Кут (${angle.kind}): ${angle.angle}`,
    "",
    "## Лід (готовий, можна правити)",
    b.lead || "—",
    "",
    "## Факти",
    ...(b.facts.length ? b.facts.map((f) => `- ${f.fact}${srcRef(c, f.source)}`) : ["- Беріть факти лише з джерел нижче."]),
    "",
    `## Структура (${b.blocks.length} блоки, ${fmt.words})`,
    ...b.blocks.map((o, i) => `${i + 1}. **${o.h2}** — ${o.note}`),
    "",
    "## Наш штрих (один абзац на пункт, не розділ)",
    ...(b.ourTouch.length ? b.ourTouch.map((x) => `- ${x}`) : ["- Одна порада або український контекст від редакції."]),
    "",
  ];
  if (b.todo.length) lines.push("## Автору перевірити (у джерелах цього немає)", ...b.todo.map((x) => `- ${x}`), "");
  lines.push(
    "## Фото (вирішує, чи покажуть у Discover)",
    ...b.photos.map((p, i) => `${i + 1}. ${p.shot}${i === 0 ? " — головне, 1200 px і ширше, герой у центрі" : ""}\n   файл: \`${p.file || "hero-detail.jpg"}\` · alt: ${p.alt}`),
    "- Звідки: офіційні пресфото, пресрелізи брендів, вбудований пост Instagram героя (кодом, з автором), фотобанк за ліцензією, Wikimedia Commons (CC, з автором). Не брати фото з сайтів-джерел: права належать агенціям.",
    "",
    "## Заголовки (оберіть один)",
    ...b.headlines.map((h) => `- [${h.type || "варіант"}] ${hl(h.text)}`),
    "",
    "## Title (до 60)",
    ...b.titles.map((t) => `- ${t} — ${check(t, 35, 60)}${clickbait(t) ? " ⚠ клікбейт" : ""}${heroIn(t) ? "" : " ⚠ без героя"}`),
    "",
    "## Description (110–155)",
    ...b.descriptions.map((d) => `- ${d} — ${check(d, 110, 155)}`),
    "",
    "## Slug",
    ...b.slugs.map((x) => `- ${x}${x.split("-").length > 7 ? " ⚠ довгий" : ""}`),
    "",
    `## Теги, рубрика, OG`,
    `- Теги: ${b.tags.join(", ") || "герой, бренд, подія"}`,
    `- Рубрика: ${b.rubric || "—"}`,
    `- OG 1200×630: ${b.og || "те саме, що головне фото"}`,
    "- Технічно: robots max-image-preview:large; schema NewsArticle (headline, image 16:9 / 4:3 / 1:1, datePublished, dateModified, author); article:published_time з таймзоною.",
    "",
    "## Чого не робити",
    ...(b.dont.length ? b.dont : ["не перетворювати на довідник", "не оцінювати зовнішність", "не вигадувати ціни й назви засобів"]).map((x) => `- ${x}`),
    "",
    "## Внутрішні посилання",
    ...(ours.length ? ours.map((o) => `- [${o.title}](${o.url})`) : ["- Підберіть 1–2 наші статті про героя чи тему (на сайті поки не знайдено)."]),
    "",
    "## Джерела",
    ...c.sources.slice(0, 8).map((x, i) => `${i + 1}. [${x.domain}: ${x.title}](${x.url})`),
    "",
    "## Довідково: стиль редакції",
    st.houseStyle,
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** Наши статьи по герою или теме: публичный поиск WordPress сайта проекта (без ключа). */
export async function ourArticles(siteUrl: string, query: string): Promise<OurArticle[]> {
  if (!siteUrl || !query.trim()) return [];
  try {
    const base = new URL(/^https?:/i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    const u = `${base.origin}/wp-json/wp/v2/posts?search=${encodeURIComponent(query.trim().slice(0, 80))}&per_page=12&_fields=link,title`;
    const r = await fetchText(u, { timeoutMs: 12_000, accept: "application/json" });
    if (!r.ok) return [];
    const j = JSON.parse(r.text) as { link?: string; title?: { rendered?: string } }[];
    // Поиск WordPress находит слова где угодно в тексте — оставляем статьи, где герой или тема есть в заголовке.
    const stems = query.toLowerCase().split(/[\s,.:;—–-]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, w.length - 2)));
    return (Array.isArray(j) ? j : [])
      .map((x) => ({ url: String(x.link ?? ""), title: String(x.title?.rendered ?? "").replace(/<[^>]+>/g, "").replace(/&#8217;|&rsquo;/g, "’").replace(/&#8211;/g, "–").replace(/&amp;/g, "&").trim() }))
      .filter((x) => x.url && x.title && stems.some((st) => x.title.toLowerCase().includes(st)))
      .slice(0, 3);
  } catch {
    return [];
  }
}
