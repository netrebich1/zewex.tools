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
export type Angle = { title: string; angle: string; why: string; novelty: number; usefulness: number; kind: string };
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

const ANGLE_KINDS = "як повторити | контекст і еволюція | практика й інструкція | експертний розбір | підбірка й порівняння | особиста історія | розбір обговорення | що всередині й де купити в Україні";

/** 3 угла для кластера (кнопка «В работу»). */
export async function makeAngles(ctx: AiCtx, st: NewsSettings, c: ClusterForAi, ours: OurArticle[]): Promise<{ angles: Angle[]; competitorsAngle: string; gaps: string[] }> {
  const system = `Ти шеф-редактор українського жіночого медіа. Про сайт: ${st.siteAbout}
Стиль редакції:
${st.houseStyle}

Перед тобою публікації про одну подію (українські та світові) і наші схожі статті. Завдання — не переказ новини, а свій кут, який дасть читачці користь і виділить нас серед конкурентів у Google Discover.
1. competitors_angle: одним реченням — під яким кутом уже написали інші.
2. gaps: 2–4 пункти — чого немає ні в кого (практика, контекст, порівняння, ціни в Україні, експерт, візуал).
3. angles: рівно 3 різні кути, тип кожного — один із: ${ANGLE_KINDS}. Для кожного:
   kind — тип; title — робочий заголовок українською до 70 символів, без клікбейту, герой у перших трьох словах; angle — одним-двома реченнями, що саме пишемо; why — чому це спрацює в Discover і для нашої аудиторії; novelty і usefulness — оцінки 1–5.
Для іноземної новини обов'язково — український контекст (ціни в гривнях, де купити в Україні, схожі українські зірки чи бренди).
Поверни лише JSON: {"competitors_angle":"…","gaps":["…"],"angles":[{"kind":"…","title":"…","angle":"…","why":"…","novelty":4,"usefulness":5}]}`;
  const user = `Тема: ${c.title}\nКатегорія: ${c.category ? CATEGORY_LABELS[c.category] ?? c.category : "—"}${c.subcategory ? ` (${c.subcategory})` : ""}${c.entity ? `\nГерой: ${c.entity}` : ""}\nСигнали: ${c.signals.join("; ") || "—"}\n\nПублікації:\n${srcText(c, 700)}\n\nНаші схожі статті:\n${ours.map((o) => `- ${o.title} (${o.url})`).join("\n") || "— немає"}`;
  const j = await chatJson(ctx, SLOT_BRIEF, system, user, st.briefModel, 2500);
  const angles = (Array.isArray(j.angles) ? (j.angles as Record<string, unknown>[]) : []).slice(0, 3).map((a) => ({
    kind: s(a.kind, 60), title: s(a.title, 160), angle: s(a.angle, 600), why: s(a.why, 600), novelty: n15(a.novelty), usefulness: n15(a.usefulness),
  })).filter((a) => a.title && a.angle);
  if (!angles.length) throw new Error("Модель не предложила углы — нажмите ещё раз");
  return { angles, competitorsAngle: s(j.competitors_angle, 400), gaps: (Array.isArray(j.gaps) ? j.gaps : []).map((g) => s(g, 300)).filter(Boolean).slice(0, 5) };
}

type BriefJson = {
  headline: string;
  alt: string[];
  angleSentence: string;
  better: string;
  facts: { fact: string; source: string }[];
  outline: { h2: string; note: string; h3: string[] }[];
  mustAdd: string[];
  images: { count: number; main: string; ideas: string[] };
  dont: string[];
  words: string;
  meta: { title: string; titleWhy: string; description: string; descriptionWhy: string; slug: string; tags: string[]; rubric: string; og: string };
};

/** ТЗ по выбранному углу: JSON модели → markdown-задание для Claude с проверкой длины метатегов. */
export async function makeBrief(ctx: AiCtx, st: NewsSettings, site: string, c: ClusterForAi, angle: Angle, ours: OurArticle[], summaryUk: string | null): Promise<string> {
  const system = `Ти шеф-редактор українського жіночого медіа ${site}. Про сайт: ${st.siteAbout}
Стиль редакції:
${st.houseStyle}

Склади ТЗ для автора за обраним кутом. Пиши українською. Факти — лише ті, що є в публікаціях (вкажи номер джерела), нічого не вигадуй.
Поверни лише JSON:
{"headline":"робочий H1 до 70 символів, герой у перших 3 словах","alt":["ще 2 варіанти заголовка"],"angle_sentence":"кут одним реченням","better":"чому наш кут кращий за конкурентів",
"facts":[{"fact":"факт","source":номер джерела}],
"outline":[{"h2":"підзаголовок","h3":["…"],"note":"що в цьому блоці одним реченням"}] — 5–8 блоків,
"must_add":["мінімум 3 речі, яких немає в конкурентів: порада, підбірка, ціни в Україні, де купити, експерт, наш старий матеріал"],
"images":{"count":3,"main":"сюжет головного кадру 1200 px і ширше","ideas":["інші кадри"]},
"dont":["чого не писати"],"words":"обсяг, напр. 500–700 слів",
"meta":{"title":"до 60 символів, герой у перших 3 словах + суть + користь/число, без «шок»","title_why":"чому так","description":"140–160 символів: що отримає читачка + 1 конкретна деталь","description_why":"чому так","slug":"транслітом 3–6 слів, з іменем героя, без дат","tags":["сутності"],"rubric":"рубрика","og":"сюжет OG-картинки 1200×630"}}`;
  const user = `Тема: ${c.title}${summaryUk ? `\nСуть: ${summaryUk}` : ""}\nОбраний кут (${angle.kind}): ${angle.title} — ${angle.angle}\nЧому цей кут: ${angle.why}\n\nПублікації (номер — джерело):\n${c.sources.slice(0, 8).map((x, i) => `${i + 1}. ${x.domain} — ${x.title}${x.lead ? `: ${x.lead.slice(0, 900)}` : ""}`).join("\n")}\n\nНаші статті для внутрішніх посилань:\n${ours.map((o) => `- ${o.title} (${o.url})`).join("\n") || "— немає"}`;
  const j = await chatJson(ctx, SLOT_BRIEF, system, user, st.briefModel, 4000, 150_000);
  const arr = <T>(v: unknown, f: (x: Record<string, unknown>) => T) => (Array.isArray(v) ? (v as Record<string, unknown>[]).map(f) : []);
  const m = (j.meta ?? {}) as Record<string, unknown>;
  const im = (j.images ?? {}) as Record<string, unknown>;
  const b: BriefJson = {
    headline: s(j.headline, 200) || angle.title,
    alt: (Array.isArray(j.alt) ? j.alt : []).map((x) => s(x, 200)).filter(Boolean).slice(0, 3),
    angleSentence: s(j.angle_sentence, 500) || angle.angle,
    better: s(j.better, 500),
    facts: arr(j.facts, (x) => ({ fact: s(x.fact, 500), source: s(x.source, 10) })).filter((x) => x.fact),
    outline: arr(j.outline, (x) => ({ h2: s(x.h2, 200), note: s(x.note, 400), h3: (Array.isArray(x.h3) ? x.h3 : []).map((h) => s(h, 200)).filter(Boolean) })).filter((x) => x.h2),
    mustAdd: (Array.isArray(j.must_add) ? j.must_add : []).map((x) => s(x, 400)).filter(Boolean),
    images: { count: Math.max(1, Math.min(10, Number(im.count) || 3)), main: s(im.main, 400), ideas: (Array.isArray(im.ideas) ? im.ideas : []).map((x) => s(x, 300)).filter(Boolean) },
    dont: (Array.isArray(j.dont) ? j.dont : []).map((x) => s(x, 300)).filter(Boolean),
    words: s(j.words, 60) || "500–700 слів",
    meta: { title: s(m.title, 120), titleWhy: s(m.title_why, 300), description: s(m.description, 300), descriptionWhy: s(m.description_why, 300), slug: s(m.slug, 120), tags: (Array.isArray(m.tags) ? m.tags : []).map((x) => s(x, 80)).filter(Boolean), rubric: s(m.rubric, 80), og: s(m.og, 300) },
  };
  return renderBrief(site, st, c, angle, b, ours, summaryUk);
}

function srcRef(c: ClusterForAi, ref: string): string {
  const i = Number(ref) - 1;
  const x = c.sources[i];
  return x ? ` — джерело ${i + 1}, ${x.domain}` : "";
}

function renderBrief(site: string, st: NewsSettings, c: ClusterForAi, angle: Angle, b: BriefJson, ours: OurArticle[], summaryUk: string | null): string {
  const warn: string[] = [];
  if (b.meta.title.length > 60) warn.push(`Title ${b.meta.title.length} символів — скоротіть до 60`);
  if (b.meta.description && (b.meta.description.length < 140 || b.meta.description.length > 160)) warn.push(`Description ${b.meta.description.length} символів — потрібно 140–160`);
  if (/шок|сенсац|не повірите|\.\.\.|…/i.test(b.meta.title + b.headline)) warn.push("У заголовку клікбейт-слова або трикрапка — приберіть");
  if (c.entity && !b.meta.title.toLowerCase().includes(c.entity.split(" ").pop()!.toLowerCase().slice(0, 5))) warn.push(`Героя «${c.entity}» немає в Title — Discover гірше зв'яже статтю з сутністю`);
  const lines: string[] = [
    `# ТЗ: ${b.headline}`,
    "",
    `> Напиши статтю для ${site} за цим ТЗ. Дотримуйся стилю редакції, використовуй лише факти з розділу «Факти» і джерел, нічого не вигадуй. Поверни: заголовок H1, лід, текст з підзаголовками H2/H3, метатеги з розділу «Метатеги».`,
    "",
    "## Стиль редакції",
    st.houseStyle,
    "",
    "## Новина коротко",
    summaryUk || c.title,
    "",
    "## Кут подачі",
    `**${angle.kind ? `${angle.kind}: ` : ""}${b.angleSentence}**`,
    b.better ? `Чому краще, ніж у конкурентів: ${b.better}` : "",
    "",
    "## Заголовок",
    `- H1: ${b.headline}`,
    ...b.alt.map((a) => `- Варіант: ${a}`),
    "",
    "## Факти (лише підтверджені, з джерелом)",
    ...(b.facts.length ? b.facts.map((f) => `- ${f.fact}${srcRef(c, f.source)}`) : ["- Беріть факти лише з джерел нижче."]),
    "",
    "## План статті",
    ...b.outline.flatMap((o) => [`### ${o.h2}`, o.note, ...o.h3.map((h) => `- H3: ${h}`), ""]),
    "## Обов'язково додати від себе",
    ...b.mustAdd.map((x) => `- ${x}`),
    "",
    "## Фото",
    `- Кількість: ${b.images.count}. Головне: ${b.images.main || "герой або предмет у центрі кадру, 1200 px і ширше"}.`,
    ...b.images.ideas.map((x) => `- ${x}`),
    "- Звідки брати: офіційні пресфото й пресрелізи брендів, вбудований пост Instagram героя (кодом вбудовування, з підписом автора), редакційні фотобанки за ліцензією, Wikimedia Commons з ліцензією CC і підписом автора, власна зйомка чи колаж із власних фото.",
    "- Не копіювати фото з сайтів-джерел і з чужих статей: права на них належать агенціям і фотографам.",
    "",
    "## Внутрішні посилання",
    ...(ours.length ? ours.map((o) => `- [${o.title}](${o.url})`) : ["- Додайте 2–3 наші статті про цього героя чи тему."]),
    "",
    "## Чого не писати",
    ...(b.dont.length ? b.dont : ["клікбейт", "непідтверджені чутки", "оцінки зовнішності", "медичні обіцянки"]).map((x) => `- ${x}`),
    "",
    "## Метатеги",
    `- Title (${b.meta.title.length}/60): ${b.meta.title}${b.meta.titleWhy ? ` — ${b.meta.titleWhy}` : ""}`,
    `- Description (${b.meta.description.length}, треба 140–160): ${b.meta.description}${b.meta.descriptionWhy ? ` — ${b.meta.descriptionWhy}` : ""}`,
    `- Slug: ${b.meta.slug}`,
    `- Теги: ${b.meta.tags.join(", ")}`,
    `- Рубрика: ${b.meta.rubric}`,
    `- OG-картинка 1200×630: ${b.meta.og}`,
    "- robots: max-image-preview:large; schema NewsArticle з датами публікації й оновлення та автором.",
    "",
    `## Обсяг: ${b.words}`,
    "",
    "## Джерела",
    ...c.sources.slice(0, 8).map((x, i) => `${i + 1}. [${x.domain}: ${x.title}](${x.url})`),
  ];
  if (warn.length) lines.splice(2, 0, `> ⚠ Перевірка: ${warn.join("; ")}`, "");
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
