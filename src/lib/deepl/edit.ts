/**
 * ИИ-редактура DeepL Articler поверх прокси портала (resolveSlot → runSlot → UsageLog), слот `text_main` (OpenRouter).
 * Порт geminiEdit / runEdit / runHeadings из article-jumble-maker: те же системные правила, проверки фрагментов,
 * откат плохих фрагментов к исходнику. Отличие: независимые фрагменты постредактуры идут параллельно.
 */
import { disableKey, resolveSlot, runSlot, type ResolvedSlot } from "@/lib/run";
import { AiError, classifyAiError } from "@/lib/pins/ai/errors";
import { acquire } from "@/lib/pins/ai/limiter";
import {
  changedWordCount, chunkBySections, chunkHtml, chunkIsFatal, countKeyword, detectMasculineVoice, protectHtml, repairPlaceholders,
  restoreHtml, rewritePct, validateChunk, visibleText, visibleTextLength, type QualityIssue,
} from "./html";
import { mapLimit } from "./deepl";
import { EDIT_SLOT, PROJECT_SLUG } from "./types";

/** Одновременных запросов к модели на один ключ (OpenRouter держит больше, чем общий лимит портала 6). */
const KEY_CONCURRENCY = Number(process.env.DEEPL_EDIT_KEY_CONCURRENCY || 12);
/** Фрагментов одной статьи в работе одновременно. */
const CHUNK_CONCURRENCY = Number(process.env.DEEPL_EDIT_CHUNK_CONCURRENCY || 4);

export type AiCtx = { userId: string; teamId?: string | null; refId?: string; model?: string; onCost?: (usd: number) => void };

export const EDIT_SYSTEM = `Ты — профессиональный редактор HTML-статей.
СТРОГИЕ ПРАВИЛА:
1. Возвращай ТОЛЬКО HTML-фрагмент, без markdown-обёрток и пояснений.
2. Сохраняй всю разметку, порядок и структуру тегов один в один.
3. НИКОГДА не меняй, не удаляй, не дублируй и не добавляй: атрибуты src, href, class, id, srcset, теги <img>, <a>, <iframe>, шорткоды в квадратных скобках и служебные теги <x-ph i="N"></x-ph> — переноси их в ответ ровно один раз, в том же месте и с тем же номером.
4. Не добавляй новые блоки и не удаляй существующие абзацы.
5. Редактируй только текстовое содержимое согласно инструкции пользователя.
6. ГОЛОС АВТОРА — ЖЕНСКИЙ: статья написана от лица девушки/женщины. ВСЕ обороты от первого лица («я», «меня», «мне», действия и чувства автора) должны стоять в ЖЕНСКОМ роде: «я обрала», «я була рада», «я спробувала», «як для мене», «я замовила». Если после перевода появились формы мужского рода («я обрав», «я був радий», «я попробовал») — исправь их на женский род, даже если инструкция пользователя этого не упоминает. Это правило приоритетнее сохранения исходных формулировок.`;

const ANCHOR_RULE = `ССЫЛКИ И АНКОРЫ (обязательно):
- Ссылки скрыты служебными тегами <x-ph i="N"></x-ph>. Текст анкора менять НЕЛЬЗЯ — он уже задан.
- Ниже дан список анкоров в том виде, в каком они стоят в тексте. Фразу ВОКРУГ служебного тега согласуй с анкором: правильный падеж, предлог, порядок слов, чтобы предложение читалось естественно.
- Убирай осиротевшие предлоги, тире и точки рядом со ссылкой («...пасує, я показала у своїй добірці на — джинси ...» — так быть не должно).
- Служебный тег переноси ровно один раз, на том же месте.`;

const QUOTE_RULE = `КАВЫЧКИ: не добавляй новых кавычек. Пустых кавычек («», "") быть не должно.`;

/** Добор ключей — отдельный проход только ради ключей, никакой другой редактуры. */
export const KEYWORD_TOPUP_PROMPT = `Задача — только вписать недостающие SEO-ключи из списка ниже.
- Ничего другого не меняй: ни стиль, ни порядок, ни объём предложений.
- Ключ вставляй ТОЛЬКО заменой существующего синонима или описательного оборота (например «ці штани» → «жіночі легінси»).
- Новых предложений, абзацев, списков и вводных штампов добавлять нельзя.
- Ключ можно склонять. В подписях к фото и внутри анкоров ключи не вставляй.
- Если ключ не подходит фрагменту по смыслу — пропусти его: лучше не вставить, чем вставить нелепо.
- Если во фрагменте вставить нечего — верни его без изменений.`;

export interface EditContext {
  title?: string | null;
  h1?: string | null;
  /** режим постредактуры: только точечная замена слов/словосочетаний */
  lightTouch?: boolean;
  /** тексты анкоров (неприкосновенны, но контекст вокруг согласуем) */
  anchors?: string[];
  /** ключи, которых не хватает в тексте: сколько вхождений нужно добавить */
  keywordDeficits?: { key: string; need: number }[];
  /** оригинал этого же фрагмента до цепочки переводов (видимый текст) — только для сверки смысла и терминов */
  reference?: string;
}

/**
 * Что именно искать после цепочки переводов. Без этого списка и без оригинала модели возвращали текст почти без правок
 * (стенд 2026-10-15: 0–1 правка на секцию у 10 моделей из 11), а смысловые сдвиги перевода оставались.
 */
const REFERENCE_RULE = `СВЕРКА С ОРИГИНАЛОМ (обязательно):
Ниже дан оригинал этого же фрагмента ДО цепочки машинных переводов. Текст после перевода специально перефразирован — так и должно остаться: формулировки оригинала НЕ возвращай и предложения из него НЕ копируй.
Сверяйся с оригиналом только чтобы найти и исправить искажения перевода:
- предмет или термин подменён (было «каблучка» — стало «обручка»; «плащ» → «дощовик»; «мигдаль» как форма нігтів) — верни правильный термин;
- цвет, материал, число, бренд, название, ситуация передаёт другое (было «рудий» — стало «червоний») — верни как в оригинале;
- обращение к читателю изменилось (в оригинале «ви» — в тексте «ти», или наоборот) — приведи к оригиналу во всём фрагменте;
- появилось то, чего в оригинале нет («на моєму пальці», лишнее «я»), или пропало важное уточнение — исправь коротко, в пределах предложения;
- разорванные или лишние кавычки вокруг названий («Vogue Ukraine без закрывающей) — исправь.
Если фрагмент передаёт смысл оригинала верно — меняй только язык.`;

const FIX_CHECKLIST = `ЧТО ИСПРАВЛЯТЬ (пройди фрагмент по каждому пункту):
1. Кальки и машинные обороты после перевода («є гарною відправною точкою», «у зоні кутикули», «привертає погляд уздовж»), русизмы, неестественная сочетаемость.
2. Термины тематики (мода, волосся, нігті, догляд) — как говорят в живих українських фешн-медіа.
3. Граматика, відмінки, узгодження роду й числа.
4. Женский род автора в формах первого лица.
5. Смысловые искажения против оригинала (если оригинал дан).
Правок обычно несколько в каждом абзаце: машинный перевод почти никогда не бывает чистым.`;

export function contextBlock(ctx?: EditContext): string {
  if (!ctx) return "";
  const lines: string[] = [];
  if (ctx.title) lines.push(`Title статьи: ${ctx.title}`);
  if (ctx.h1) lines.push(`H1 статьи: ${ctx.h1}`);
  let block = "";
  if (lines.length) {
    block += `Контекст статьи (используй, чтобы определить основные ключевые слова и LSI-фразы и сохранить их в тексте):\n${lines.join("\n")}\n\n`;
  }
  if (ctx.lightTouch) {
    block += `РЕЖИМ ПОСТРЕДАКТУРЫ — ТОЧЕЧНАЯ ПРАВКА (обязательно):
- Это НЕ рерайт. Запрещено переписывать предложения своими словами, пересказывать, укорачивать, объединять или разбивать их, менять порядок предложений и абзацев.
- Каркас каждого предложения остаётся прежним: не менее 80% слов фрагмента должны остаться дословно на своих местах.
- Разрешена ТОЛЬКО замена отдельных слов и коротких словосочетаний ради чистоты языка: грамматика, падежи, согласование, кальки и машинные обороты после перевода, неестественная сочетаемость.
- Не «улучшай стиль» ради стиля: правка нужна там, где есть ошибка, калька, искажение смысла или неестественная фраза.
- ОСОБО РАЗРЕШЕНО и обязательно: исправлять формы первого лица на ЖЕНСКИЙ род (автор — девушка): «я обрав/був/зробив» → «я обрала/була/зробила» и т.п. во всём фрагменте.
- Ключевые слова и LSI из Title/H1 сохраняй и используй в естественной форме, не переспамливай.\n\n`;
    if (!ctx.keywordDeficits?.length) block += `${FIX_CHECKLIST}\n\n`;
  }
  if (ctx.reference?.trim()) {
    block += `${REFERENCE_RULE}\nОРИГИНАЛ ФРАГМЕНТА (только для сверки, не копировать):\n"""\n${ctx.reference.trim().slice(0, 8000)}\n"""\n\n`;
  }
  if (ctx.anchors?.length) {
    block += `${ANCHOR_RULE}\nАнкоры в статье:\n${ctx.anchors.slice(0, 40).map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n`;
  }
  if (ctx.keywordDeficits?.length) {
    block += `SEO-КЛЮЧИ (обязательно):
- Ниже ключи, которых в тексте не хватает, и сколько вхождений нужно добавить во всей статье.
- Добавляй ключ ТОЛЬКО заменой уже существующего синонима или описательного оборота на ключ. Новых предложений, абзацев и перечислений добавлять НЕЛЬЗЯ.
- Запрещены вводные штампы («Кроме того», «Важно отметить», «Стоит подчеркнуть»), повтор ключа в соседних предложениях, ключ в подписях к фото и внутри анкоров.
- Ключ можно склонять и согласовывать по падежу. Все формы от первого лица — строго в женском роде (автор — девушка).
- Если ключ не подходит этому фрагменту по смыслу — пропусти его, его вставят в другом месте статьи.
- Ключи ниже закреплены именно за этим фрагментом: постарайся разместить их здесь, по одному в разных абзацах.
- Объём фрагмента не должен вырасти более чем на 6%.
Ключи:\n${ctx.keywordDeficits.slice(0, 20).map((k) => `- «${k.key}» — добавить примерно ${k.need}`).join("\n")}\n\n`;
  }
  if (ctx.lightTouch || ctx.anchors?.length) block += `${QUOTE_RULE}\n\n`;
  return block;
}

/* ---------------- вызов модели ---------------- */

const resolved = new Map<string, { at: number; value: ResolvedSlot }>();

/** Правило на минуту: по пользователю и команде задания (списание с ключей этой команды). */
async function resolveFor(userId: string, teamId: string | null | undefined): Promise<ResolvedSlot> {
  const cacheKey = `${userId}|${teamId ?? ""}`;
  const hit = resolved.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const r = await resolveSlot(userId, PROJECT_SLUG, EDIT_SLOT, teamId);
  if (!r.ok) throw new AiError({ code: r.status === 409 ? "no_binding" : "resolve", kind: "fatal_run", message: r.error }, r.status);
  resolved.set(cacheKey, { at: Date.now(), value: r.value });
  return r.value;
}

function extractText(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const raw = d?.choices?.[0]?.message?.content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((p) => p?.text ?? "").join("");
  return "";
}

/** Один запрос к модели с повторами на временные сбои (3 попытки, пауза 1.5·n с). */
export async function chat(ctx: AiCtx, system: string, user: string, temperature: number): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pre = await resolveFor(ctx.userId, ctx.teamId);
    const release = await acquire(`deepl:${pre.binding.apiKey.id}`, KEY_CONCURRENCY);
    try {
      const res = await runSlot({
        userId: ctx.userId,
        projectSlug: PROJECT_SLUG,
        slotKey: EDIT_SLOT,
        payload: { messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature, reasoning: { effort: "none" } },
        model: ctx.model || undefined,
        timeoutMs: 150_000,
        meta: { teamId: ctx.teamId ?? undefined, refId: ctx.refId },
        pre,
      });
      if (res.meta?.costUsd) ctx.onCost?.(res.meta.costUsd);
      if (!res.ok) {
        const cls = classifyAiError(res.status, res.error ?? "");
        if (cls.kind === "fatal_run" && (cls.code === "no_credits" || cls.code === "auth")) {
          await disableKey(pre.binding.apiKey.id, `Автоотключён: ${cls.code === "no_credits" ? "закончился баланс" : "ключ отклонён провайдером"} (${cls.message.slice(0, 120)})`);
          resolved.delete(ctx.userId);
          cls.message = `Ключ «${pre.binding.apiKey.label}»: ${cls.message}`;
        }
        throw new AiError(cls, res.status);
      }
      const text = extractText(res.data).replace(/^\s*```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
      if (!text) throw new AiError({ code: "empty", kind: "transient", message: "Модель вернула пустой ответ" }, 502);
      return text;
    } catch (e) {
      lastErr = e;
      if (e instanceof AiError && e.cls.kind !== "transient") throw e;
      await sleep(1500 * (attempt + 1));
    } finally {
      release();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function editChunk(ctx: AiCtx, prompt: string, html: string, note: string, ectx?: EditContext): Promise<string> {
  return chat(ctx, EDIT_SYSTEM, `${contextBlock(ectx)}Инструкция редактуры:\n${prompt}\n\n${note}HTML-фрагмент:\n${html}`, ectx?.lightTouch ? 0.2 : 0.6);
}

export type EditOpts = {
  /** батчи по H2-секциям вместо нарезки по размеру */
  sections?: number;
  maxTextGrowthPct?: number;
  maxRewritePct?: number;
  /** ключи пересчитываются после каждого фрагмента (фрагменты идут по очереди) */
  retryKeywordDeficits?: boolean;
  relaxTags?: boolean;
  /** исходная статья до переводов (защищённый HTML): каждому фрагменту даётся его же секция для сверки */
  referenceHtml?: string;
};

/** Статья по секциям: [0] — всё до первого H2, дальше по одной секции на каждый H2. */
export function sectionsOf(html: string): string[] {
  const idx = [...html.matchAll(/<h2\b/gi)].map((m) => m.index ?? 0);
  if (!idx.length) return [html];
  return [html.slice(0, idx[0]), ...idx.map((s, i) => html.slice(s, idx[i + 1] ?? html.length))];
}

/** Оригинал для каждого фрагмента по номерам H2; если число H2 не совпало — сверки нет. */
export function referencesFor(chunks: string[], referenceHtml: string): (string | undefined)[] {
  const ref = sectionsOf(referenceHtml);
  const h2 = (h: string) => (h.match(/<h2\b/gi) ?? []).length;
  if (ref.length - 1 !== chunks.reduce((a, c) => a + h2(c), 0)) return chunks.map(() => undefined);
  let before = 0;
  return chunks.map((c) => {
    const n = h2(c);
    const start = /^\s*<h2\b/i.test(c) ? before + 1 : before;
    const part = ref.slice(start, before + n + 1).join("");
    before += n;
    const text = visibleText(part);
    return text || undefined;
  });
}

export type EditResult = { html: string; warnings: QualityIssue[]; done: number; total: number; rolledBack: number; changedWords: number };

/**
 * Редактура HTML по фрагментам. html может быть уже защищён плейсхолдерами (preProtected) — так работает воркер.
 * Плохой фрагмент повторяется один раз, затем остаётся исходным (chunk_rollback), содержимое не теряется.
 */
export async function runEdit(ctx: AiCtx, html: string, prompt: string, ectx: EditContext | undefined, preProtected: boolean, opts: EditOpts = {}): Promise<EditResult> {
  const { text: protectedHtml, tokens } = preProtected ? { text: html, tokens: [] as string[] } : protectHtml(html);
  const chunks = opts.sections ? chunkBySections(protectedHtml, opts.sections, 9000) : chunkHtml(protectedHtml, 7000);
  const warnings: QualityIssue[] = [];
  const out: string[] = [...chunks];
  let rolledBack = 0;

  // Ключи распределяем по фрагментам: иначе каждый фрагмент пытается вставить весь список.
  const deficits = ectx?.keywordDeficits ?? [];
  const perChunk: { key: string; need: number }[][] = chunks.map(() => []);
  if (deficits.length && chunks.length) {
    const slots: { key: string; need: number }[] = [];
    for (const d of deficits) for (let n = 0; n < Math.max(1, Math.min(3, d.need)); n++) slots.push({ key: d.key, need: 1 });
    slots.forEach((s, i) => {
      const bucket = perChunk[i % chunks.length]!;
      const exist = bucket.find((b) => b.key === s.key);
      if (exist) exist.need += 1;
      else bucket.push({ key: s.key, need: 1 });
    });
  }
  const keywordTargets = new Map(deficits.map((d) => [d.key, countKeyword(protectedHtml, d.key) + d.need]));
  const refs = opts.referenceHtml ? referencesFor(chunks, opts.referenceHtml) : [];
  const ctxFor = (i: number): EditContext | undefined => {
    if (!deficits.length) return refs[i] ? { ...(ectx ?? {}), reference: refs[i] } : ectx;
    if (!opts.retryKeywordDeficits) return { ...(ectx as EditContext), keywordDeficits: perChunk[i] };
    // Пересчёт после каждого фрагмента: ключ, пропущенный в одной секции, предлагается следующим.
    const current = out.join("");
    const remaining = deficits
      .map((d) => ({ key: d.key, need: Math.max(0, (keywordTargets.get(d.key) || 0) - countKeyword(current, d.key)) }))
      .filter((d) => d.need > 0);
    const offset = remaining.length ? i % remaining.length : 0;
    return { ...(ectx as EditContext), keywordDeficits: [...remaining.slice(offset), ...remaining.slice(0, offset)].slice(0, 6) };
  };

  const doChunk = async (i: number) => {
    const src = chunks[i]!;
    const kctx = ctxFor(i);
    if (deficits.length && !kctx?.keywordDeficits?.length) return; // добор: этому фрагменту вставлять нечего
    const beforeText = visibleTextLength(src);
    const grade = (candidate: string): QualityIssue[] => {
      const list = validateChunk(src, candidate);
      const afterText = visibleTextLength(candidate);
      if (opts.maxTextGrowthPct !== undefined && afterText > beforeText * (1 + opts.maxTextGrowthPct / 100) + 80) {
        list.push({ code: "text_growth", detail: `видимый текст вырос на ${Math.round((afterText / Math.max(1, beforeText) - 1) * 100)}%` });
      }
      if (opts.maxRewritePct !== undefined) {
        const pct = rewritePct(src, candidate);
        if (pct > opts.maxRewritePct) list.push({ code: "rewrite", detail: `переписано ${pct}% слов (допустимо до ${opts.maxRewritePct}%) — это пересказ, а не точечная правка` });
      }
      return list;
    };
    const first = repairPlaceholders(src, await editChunk(ctx, prompt, src, "", kctx));
    const issues = grade(first);
    if (!chunkIsFatal(issues, opts.relaxTags)) {
      warnings.push(...issues.map((x) => ({ ...x, detail: `фрагмент ${i + 1}: ${x.detail}` })));
      out[i] = first;
      return;
    }
    const rewrote = issues.some((x) => x.code === "rewrite");
    const note = rewrote
      ? "ВАЖНО: предыдущий ответ переписал текст. Верни ПОЛНЫЙ фрагмент целиком, меняя ТОЛЬКО отдельные слова и словосочетания; структуру предложений и их порядок сохрани дословно.\n\n"
      : "Верни ПОЛНЫЙ фрагмент целиком.\n\n";
    // Пересказ при сверке с оригиналом — обычно модель вернула формулировки оригинала (стенд: до 79% слов).
    // Второй заход без оригинала: только чистка языка, уникализация перевода сохраняется.
    const retryCtx = rewrote && kctx?.reference ? { ...kctx, reference: undefined } : kctx;
    try {
      const retry = repairPlaceholders(src, await editChunk(ctx, prompt, src, note, retryCtx));
      const retryIssues = grade(retry);
      if (!chunkIsFatal(retryIssues, opts.relaxTags)) {
        warnings.push(...retryIssues.map((x) => ({ ...x, detail: `фрагмент ${i + 1}: ${x.detail}` })));
        out[i] = retry;
        return;
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
    }
    rolledBack++;
    warnings.push({ code: "chunk_rollback", detail: `фрагмент ${i + 1}: результат не прошёл проверку (${issues.map((x) => x.detail).join("; ")}) — оставлен исходный фрагмент` });
  };

  const indexes = chunks.map((_, i) => i);
  if (opts.retryKeywordDeficits) {
    for (const i of indexes) await doChunk(i);
  } else {
    await mapLimit(indexes, CHUNK_CONCURRENCY, (i) => doChunk(i));
  }

  const joined = out.join("");
  const male = detectMasculineVoice(joined);
  if (male.length) warnings.push({ code: "voice_masculine", detail: `остались формы мужского рода от первого лица (${male.length}): ${male.slice(0, 5).join(", ")}` });
  return {
    html: preProtected ? joined : restoreHtml(joined, tokens),
    warnings,
    done: chunks.length,
    total: chunks.length,
    rolledBack,
    changedWords: changedWordCount(protectedHtml, joined),
  };
}

/* ---------------- H2 ---------------- */

export const HEADINGS_SYSTEM = `Ты — редактор заголовков H2 в статье.
СТРОГИЕ ПРАВИЛА:
1. Тебе дан нумерованный список заголовков. Верни РОВНО столько же строк в том же порядке и той же нумерации.
2. Формат строки: "N. новый заголовок". Без markdown, без пояснений, без пустых строк.
3. Не объединяй, не удаляй и не добавляй заголовки.
4. Не добавляй HTML-теги и не трогай служебные теги <x-ph i="N"></x-ph>.
5. Если заголовок уже хорош — верни его без изменений.
6. Автор статьи — девушка. Если в заголовке есть форма первого лица, она должна быть женского рода («я обрала», «мій вибір»), мужской род запрещён.`;

/**
 * Ответ модели → новые H2 по номерам. Если промт просит несколько вариантов и «РЕКОМЕНДОВАНИЙ НАБІР»
 * (промт «H2» владельца), берём только рекомендованный набор — иначе варианты «1) 2) 3)» перезаписали бы номера.
 */
export function parseHeadings(content: string, count: number): string[] {
  const marker = content.search(/РЕКОМЕНДОВАН[А-ЯІЇЄҐA-Z ]*НАБ[ІИ]Р|РЕКОМЕНДУЕМЫЙ НАБОР|RECOMMENDED SET/i);
  const body = marker >= 0 ? content.slice(marker).replace(/^[^\n]*\n?/, "") : content;
  const parsed: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(?:H2\s*)?№?\s*(\d+)\s*[.):—–-]\s*(.+?)\s*$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count) continue;
    const text = m[2]!
      .replace(/<[^>]+>/g, "")
      .replace(/\s*\((?:було|было|was)\s*:[^)]*\)\s*$/i, "")
      .replace(/^[«"“]+|[»"”]+$/g, "")
      .trim();
    if (text) parsed[n - 1] = text;
  }
  return parsed;
}

/** Редактура только текстов H2 (идёт после переводов, на языке итога). */
export async function runHeadings(ctx: AiCtx, html: string, prompt: string, ectx?: EditContext): Promise<{ html: string; warnings: QualityIssue[]; changedWords: number }> {
  const warnings: QualityIssue[] = [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) return { html, warnings: [{ code: "headings_none", detail: "H2 в статье не найдены" }], changedWords: 0 };
  const originals = matches.map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const list = originals.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const ctxLines: string[] = [];
  if (ectx?.title) ctxLines.push(`Title статьи: ${ectx.title}`);
  if (ectx?.h1) ctxLines.push(`H1 статьи: ${ectx.h1}`);
  const content = await chat(ctx, HEADINGS_SYSTEM, `${ctxLines.length ? ctxLines.join("\n") + "\n\n" : ""}Инструкция:\n${prompt}\n\nЗаголовки H2:\n${list}\n\nВ конце ответа обязательно дай итоговый список строго в формате "N. заголовок" — по одной строке на каждый H2, в исходном порядке.`, 0.4);
  const parsed = parseHeadings(content, originals.length);
  let replaced = 0;
  let idx = 0;
  const out = html.replace(re, (full, inner: string) => {
    const i = idx++;
    const next = parsed[i];
    if (!next || next === originals[i]) return full;
    if (/<[a-zA-Z]/.test(inner)) {
      warnings.push({ code: "headings_html", detail: `H2 #${i + 1} содержит теги — оставлен как есть` });
      return full;
    }
    replaced++;
    return `${full.slice(0, full.indexOf(">") + 1)}${next}</h2>`;
  });
  if (!replaced) warnings.push({ code: "headings_noop", detail: "Заголовки H2 не изменились" });
  else if (replaced < originals.length) warnings.push({ code: "headings_partial", detail: `изменено ${replaced} из ${originals.length} H2` });
  return { html: out, warnings, changedWords: changedWordCount(html, out) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
