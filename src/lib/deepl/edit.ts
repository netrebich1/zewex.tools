/**
 * ИИ-редактура DeepL Articler поверх прокси портала (resolveSlot → runSlot → UsageLog), слот `text_main` (OpenRouter).
 * Порт geminiEdit / runEdit / runHeadings из article-jumble-maker: те же системные правила, проверки фрагментов,
 * откат плохих фрагментов к исходнику. Отличие: независимые фрагменты постредактуры идут параллельно.
 */
import { disableKey, resolveSlot, runSlot, type ResolvedSlot } from "@/lib/run";
import { AiError, classifyAiError } from "@/lib/pins/ai/errors";
import { acquire } from "@/lib/pins/ai/limiter";
import {
  addressStats, changedWordCount, chunkBySections, chunkHtml, chunkIsFatal, countCliches, countKeyword, countRussianisms, detectMasculineVoice, dominantAddress,
  findRussianisms, matchDashStyle, protectHtml, repairPlaceholders, restoreHtml, rewritePct, sourceGlossary, stripKeywordQuotes, validateChunk, visibleText,
  visibleTextLength, type QualityIssue,
} from "./html";
import { mapLimit } from "./deepl";
import { langPack } from "./lang";
import { EDIT_SLOT, PROJECT_SLUG } from "./types";

/** Одновременных запросов к модели на один ключ (OpenRouter держит больше, чем общий лимит портала 6). */
const KEY_CONCURRENCY = Number(process.env.DEEPL_EDIT_KEY_CONCURRENCY || 12);
/** Фрагментов одной статьи в работе одновременно. */
const CHUNK_CONCURRENCY = Number(process.env.DEEPL_EDIT_CHUNK_CONCURRENCY || 4);

export type AiCtx = { userId: string; teamId?: string | null; refId?: string; model?: string; onCost?: (usd: number) => void };

/** Совместимость со стендом: системный промт — из языкового пакета (UK — украинский, остальные — английский). */
export const EDIT_SYSTEM = langPack("UK").system;

/** Добор ключей — отдельный проход только ради ключей, никакой другой редактуры (текст по языку статьи). */
export const KEYWORD_TOPUP_PROMPT = langPack("UK").topupPrompt;
export const keywordTopupPrompt = (lang?: string | null): string => langPack(lang).topupPrompt;

export interface EditContext {
  title?: string | null;
  h1?: string | null;
  /** язык итоговой статьи (код DeepL): выбирает языковой пакет служебных промтов */
  lang?: string | null;
  /** режим постредактуры: только точечная замена слов/словосочетаний */
  lightTouch?: boolean;
  /** тексты анкоров (неприкосновенны, но контекст вокруг согласуем) */
  anchors?: string[];
  /** ключи, которых не хватает в тексте: сколько вхождений нужно добавить */
  keywordDeficits?: { key: string; need: number }[];
  /** оригинал этого же фрагмента до цепочки переводов (видимый текст) — только для сверки смысла и терминов */
  reference?: string;
  /** слова оригинала, которых во фрагменте нет (перевод заменил синонимами) — вернуть термин там, где стоит синоним */
  glossary?: string[];
  /** "style" — стилистический проход (канцелярит и штампы) вместо чек-листа постредактуры */
  mode?: "edit" | "style";
}

/**
 * Служебные блоки промта на языке статьи. Без списка «что искать» и без оригинала модели возвращали текст почти
 * без правок (стенд 2026-10-15), а с русскоязычными блоками — правили украинский на суржик (2026-11-04).
 */
export function contextBlock(ctx?: EditContext): string {
  if (!ctx) return "";
  const L = langPack(ctx.lang);
  const lines: string[] = [];
  if (ctx.title) lines.push(`${L.titleLabel}: ${ctx.title}`);
  if (ctx.h1) lines.push(`${L.h1Label}: ${ctx.h1}`);
  let block = "";
  if (lines.length) block += `${L.contextHeader}\n${lines.join("\n")}\n\n`;
  if (ctx.lightTouch) {
    block += `${L.lightTouch}\n\n`;
    if (ctx.mode === "style") block += `${L.styleChecklist}\n\n`;
    else if (!ctx.keywordDeficits?.length) block += `${L.checklist}\n\n`;
  }
  if (ctx.reference?.trim()) block += `${L.reference}\n${L.referenceHeader}\n"""\n${ctx.reference.trim().slice(0, 8000)}\n"""\n\n`;
  if (ctx.glossary?.length) block += `${L.glossary}\n${L.glossaryHeader}\n${ctx.glossary.join(", ")}\n\n`;
  if (ctx.anchors?.length) block += `${L.anchors}\n${L.anchorsHeader}\n${ctx.anchors.slice(0, 40).map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n`;
  if (ctx.keywordDeficits?.length) block += `${L.keywords}\n${L.keywordsHeader}\n${ctx.keywordDeficits.slice(0, 20).map((k) => L.keywordLine(k.key, k.need)).join("\n")}\n\n`;
  if (ctx.lightTouch || ctx.anchors?.length) block += `${L.quotes}\n\n`;
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
  const L = langPack(ectx?.lang);
  return chat(ctx, L.system, `${contextBlock(ectx)}${L.instructionLabel}\n${prompt}\n\n${note}${L.fragmentLabel}\n${html}`, ectx?.lightTouch ? 0.2 : 0.6);
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
  /** после принятия фрагмента выровнять обращение «ти/ви» под оригинал отдельным проходом (нужен referenceHtml, UK) */
  alignAddress?: boolean;
  /** давать модели термины оригинала, которых нет во фрагменте (нужен referenceHtml) */
  glossary?: boolean;
  /** фрагмент с большим числом канцелярских штампов, чем на входе, отклоняется */
  noCliches?: boolean;
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
    if (!deficits.length) {
      if (!refs[i]) return ectx;
      // Термины оригинала, которых во фрагменте нет: перевод заменил их синонимами (каблучка → кільце, рубчик → ребристий).
      const glossary = opts.glossary ? sourceGlossary(refs[i]!, visibleText(chunks[i]!)) : [];
      return { ...(ectx ?? {}), reference: refs[i], ...(glossary.length ? { glossary } : {}) };
    }
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
    const isUk = langPack(ectx?.lang).code === "UK";
    const srcRu = isUk ? countRussianisms(src) : 0;
    const srcRuWords = new Set(isUk ? findRussianisms(src) : []);
    const srcCliches = opts.noCliches && isUk ? countCliches(src) : 0;
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
      // Украинский итог: правка не имеет права добавлять русизмы (deepseek-v4-flash с 2026-11 добавлял десятки на статью).
      if (isUk && countRussianisms(candidate) > srcRu) {
        const added = findRussianisms(candidate).filter((w) => !srcRuWords.has(w));
        list.push({ code: "russianisms", detail: `модель добавила русизмы: ${added.slice(0, 6).join(", ")}` });
      }
      // Канцелярит и рекламные штампы («ідеально підходить», «полягає в тому, що») правка добавлять не должна.
      if (opts.noCliches && isUk) {
        const n = countCliches(candidate);
        if (n > srcCliches) list.push({ code: "cliches", detail: `модель добавила канцелярские штампы: было ${srcCliches}, стало ${n}` });
      }
      return list;
    };
    // Чистка механики до проверки: тире как во фрагменте, ключи без кавычек.
    const clean = (raw: string) => {
      let s = matchDashStyle(src, raw);
      if (kctx?.keywordDeficits?.length) s = stripKeywordQuotes(src, s, kctx.keywordDeficits.map((k) => k.key));
      return repairPlaceholders(src, s);
    };
    const first = clean(await editChunk(ctx, prompt, src, "", kctx));
    const issues = grade(first);
    if (!chunkIsFatal(issues, opts.relaxTags)) {
      warnings.push(...issues.map((x) => ({ ...x, detail: `фрагмент ${i + 1}: ${x.detail}` })));
      out[i] = first;
      return;
    }
    // До 3 повторов, указание с каждым строже (было 1 повтор — фрагмент на 24% при пороге 22% оставался необработанным).
    // Ответ, у которого единственная беда — «переписано чуть больше порога», запоминаем: если все повторы не пройдут,
    // берём самый бережный из них (до 1,5 порога) вместо исходного фрагмента. Пустой/обрезанный/без разметки — никогда.
    const softMax = opts.maxRewritePct !== undefined ? Math.round(opts.maxRewritePct * 1.5) : 0;
    let best: { html: string; pct: number; issues: QualityIssue[] } | null = null;
    const consider = (html: string, list: QualityIssue[]) => {
      if (opts.maxRewritePct === undefined || chunkIsFatal(list.filter((x) => x.code !== "rewrite"), opts.relaxTags)) return;
      const pct = rewritePct(src, html);
      if (pct <= softMax && (!best || pct < best.pct)) best = { html, pct, issues: list };
    };
    consider(first, issues);
    let last = issues;
    const rewriteNotes = langPack(ectx?.lang).retryNotes.rewrite;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rewrote = last.some((x) => x.code === "rewrite" || x.code === "russianisms");
      const note = rewrote ? rewriteNotes[attempt]! : langPack(ectx?.lang).retryNotes.full;
      // Пересказ при сверке с оригиналом — обычно модель вернула формулировки оригинала (стенд: до 79% слов).
      // Повтор без оригинала: только чистка языка, уникализация перевода сохраняется.
      const retryCtx = rewrote && kctx?.reference ? { ...kctx, reference: undefined } : kctx;
      try {
        const retry = clean(await editChunk(ctx, prompt, src, note, retryCtx));
        const retryIssues = grade(retry);
        if (!chunkIsFatal(retryIssues, opts.relaxTags)) {
          warnings.push(...retryIssues.map((x) => ({ ...x, detail: `фрагмент ${i + 1}: ${x.detail}` })));
          out[i] = retry;
          return;
        }
        consider(retry, retryIssues);
        last = retryIssues;
      } catch (e) {
        if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      }
    }
    const pick = best as { html: string; pct: number; issues: QualityIssue[] } | null;
    if (pick) {
      out[i] = pick.html;
      // Не «chunk_rollback»: фрагмент обработан, статья не уходит в «Проверить» из-за пары лишних слов.
      warnings.push({ code: "rewrite_soft", detail: `фрагмент ${i + 1}: принят самый бережный из ${4} вариантов — переписано ${pick.pct}% слов при пороге ${opts.maxRewritePct}%` });
      return;
    }
    rolledBack++;
    warnings.push({ code: "chunk_rollback", detail: `фрагмент ${i + 1}: результат не прошёл проверку и после 3 повторов (${last.map((x) => x.detail).join("; ")}) — оставлен исходный фрагмент` });
  };

  /**
   * Обращение «ти/ви» как в оригинале. Цепочка переводов уводит «ти» в «ви», и ни одна модель в общей правке этого
   * не выравнивает (стенд 2026-11-04: «розтріпайте… попроси» в одном абзаце). Отдельный проход с единственной задачей;
   * принимается, только если «чужих» форм стало меньше, а остальное не переписано.
   */
  const fixAddress = async (i: number) => {
    const ref = refs[i];
    if (!opts.alignAddress || !ref || deficits.length || langPack(ectx?.lang).code !== "UK") return;
    const target = dominantAddress(ref);
    if (!target) return;
    const cur = out[i]!;
    const st = addressStats(cur);
    const refSt = addressStats(ref);
    const wrong = target === "ty" ? st.vy : st.ty;
    const wrongWords = target === "ty" ? st.vyWords : st.tyWords;
    if (wrong <= (target === "ty" ? refSt.vy : refSt.ty)) return;
    const L = langPack(ectx?.lang);
    try {
      const raw = await editChunk(ctx, L.addressNote(target, wrongWords).trim(), cur, "", { title: ectx?.title, h1: ectx?.h1, lang: ectx?.lang, anchors: ectx?.anchors });
      const fixed = repairPlaceholders(cur, matchDashStyle(cur, raw));
      const issues = validateChunk(cur, fixed);
      const after = addressStats(fixed);
      const afterWrong = target === "ty" ? after.vy : after.ty;
      const pct = rewritePct(cur, fixed);
      if (!chunkIsFatal(issues, opts.relaxTags) && countRussianisms(fixed) <= countRussianisms(cur) && afterWrong < wrong && pct <= 30) {
        out[i] = fixed;
        warnings.push({ code: "address_fixed", detail: `фрагмент ${i + 1}: звертання приведено до «${target === "ty" ? "ти" : "ви"}» як в оригіналі (форм на «${target === "ty" ? "ви" : "ти"}» було ${wrong}, лишилося ${afterWrong})` });
      } else {
        warnings.push({ code: "address_mixed", detail: `фрагмент ${i + 1}: в оригіналі «${target === "ty" ? "ти" : "ви"}», у тексті лишилися форми ${wrongWords.slice(0, 6).join(", ")} — вирівняти не вдалося (переписано ${pct}%)` });
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      warnings.push({ code: "address_mixed", detail: `фрагмент ${i + 1}: звертання не вирівняно — ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const indexes = chunks.map((_, i) => i);
  if (opts.retryKeywordDeficits) {
    for (const i of indexes) await doChunk(i);
  } else {
    await mapLimit(indexes, CHUNK_CONCURRENCY, async (i) => {
      await doChunk(i);
      await fixAddress(i);
    });
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

export const HEADINGS_SYSTEM = langPack("UK").headingsSystem;

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
  const L = langPack(ectx?.lang);
  const ctxLines: string[] = [];
  if (ectx?.title) ctxLines.push(`${L.titleLabel}: ${ectx.title}`);
  if (ectx?.h1) ctxLines.push(`${L.h1Label}: ${ectx.h1}`);
  const content = await chat(ctx, L.headingsSystem, `${ctxLines.length ? ctxLines.join("\n") + "\n\n" : ""}${L.headingsInstruction}\n${prompt}\n\n${L.headingsList}\n${list}\n\n${L.headingsTail}`, 0.4);
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
