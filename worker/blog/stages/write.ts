/**
 * Этап `write`: тексты секций по плану и брифу. Пачки по BATCH секций подряд (контекст: карта статьи, бриф знаний,
 * сводка уже написанного); 2 попытки на пачку, недостающие — по одной. Разрешённый HTML зависит от типа блока
 * (src/lib/blog/blocks.ts): чистка до разрешённых тегов, таблицы с <thead>, полировка (тире, US-орфография).
 * Промты: `writer_system` (персона, голос, правила точности) + `writer_user` (пачка). Частичный результат сохраняется.
 * `rewriteSection` — одна перепись секции по замечаниям проверки качества (зовёт сборка).
 */
import { prisma } from "@/lib/db";
import type { BlogSection } from "@prisma/client";
import { AiError, backoffMs } from "@/lib/pins/ai/errors";
import { aiChat } from "@/lib/blog/ai";
import { extractJsonFromResponse, toSectionList } from "@/lib/articles/text/jsonRepair";
import { usesUsSpelling, type PolishOpts } from "@/lib/articles/text/polish";
import { allowedTags, wantsTable } from "@/lib/blog/blocks";
import { fillPrompt, resolvePrompt, stageModel } from "@/lib/blog/prompts";
import { articleMap, briefShort, cleanSectionHtml, countWords, firstWords, looksLikeJunk, sectionBriefText } from "@/lib/blog/text";
import { SLOTS, VOICES, type OutlineSection } from "@/lib/blog/types";
import type { StageCtx, StageHandler } from "./index";

const SYSTEM_KEY = "writer_system";
const USER_KEY = "writer_user";
const BATCH = 4;
const MIN_WORDS = 40;

export const YMYL_RULE = `HEALTH/SAFETY TOPIC: no diagnoses, no dosages, no promises of cure. Use "may", "can help", "many people find". Say plainly when a doctor, dermatologist or other professional should be consulted. Never invent studies, percentages or expert quotes.`;
export const ACCURACY_RULE = `ACCURACY: use only facts from the research brief and widely known, uncontroversial knowledge. Never invent statistics, studies, brand tests, prices or personal medical outcomes. If a detail is uncertain, phrase it as a possibility or leave it out.`;

export function voiceText(voice: string, persona: string): string {
  const v = VOICES.find((x) => x.value === voice);
  const base = v ? `${v.label}: ${v.help}` : voice;
  if (voice === "blogger_first_person") return `${base} The author is ${persona}. First person is welcome for opinions and tips ("My tip:", "I usually…"), but never invent specific personal events, dates, purchases or medical results. Instructions address the reader as "you".`;
  if (voice === "warm_guide") return `${base} Never use "I". Address the reader as "you". Persona note for tone only: ${persona}.`;
  return `${base} No "I", no "you" except in instructions; plain, precise, calm.`;
}

type Written = { position: number; html: string };

export type WriterEnv = {
  ctx: StageCtx;
  system: string;
  userTpl: { system: string; text: string };
  model: string | undefined;
  pol: PolishOpts;
  allowLinks: boolean;
  outlineSections: OutlineSection[];
};

export function buildEnv(ctx: StageCtx): WriterEnv {
  const { post, recipe, brief, outline } = ctx;
  const params = recipe.params;
  const sys = resolvePrompt(recipe, SYSTEM_KEY);
  const usr = resolvePrompt(recipe, USER_KEY);
  const linksRule = params.links.mode === "allowlist" && params.links.allow.length
    ? `LINKS: you may add at most 3 <a href="https://…"> links to these domains only: ${params.links.allow.join(", ")}; anchor text natural, never "click here".`
    : `LINKS: do not add any links.`;
  const filled = fillPrompt(sys, {
    keyword: post.keyword, voice: voiceText(params.voice, params.persona), persona: params.persona, language: params.language,
    ymyl_rule: brief?.ymyl ? YMYL_RULE : "", links_rule: linksRule,
  }, { name: SYSTEM_KEY });
  const system = [filled.system, filled.user].filter((x) => x.trim()).join("\n\n") + `\n\n${ACCURACY_RULE}`;
  return {
    ctx, system, userTpl: usr, model: stageModel(recipe, USER_KEY) ?? stageModel(recipe, SYSTEM_KEY),
    pol: { usSpelling: usesUsSpelling(params.language, params.country) },
    allowLinks: params.links.mode === "allowlist" && params.links.allow.length > 0,
    outlineSections: outline?.sections ?? [],
  };
}

function outlineOf(env: WriterEnv, sec: BlogSection): OutlineSection {
  const o = env.outlineSections.find((s) => s.position === sec.position);
  const b = (sec.brief ?? {}) as { keyPoints?: string[]; targetWords?: number; notes?: string | null };
  return o ?? { position: sec.position, kind: sec.kind, heading: sec.heading, keyPoints: b.keyPoints ?? [], targetWords: b.targetWords ?? 150, notes: b.notes ?? undefined, image: sec.slotKey ? { query: "" } : null };
}

/** Текст из ответа модели → чистый HTML секции или причина отказа. */
export function acceptSectionHtml(env: WriterEnv, sec: BlogSection, raw: string): { html: string } | { why: string } {
  if (!raw.trim() || looksLikeJunk(raw)) return { why: "пустой или сырой ответ" };
  const html = cleanSectionHtml(raw, allowedTags(sec.kind), env.pol, { allowLinks: env.allowLinks });
  const o = outlineOf(env, sec);
  const words = countWords(html);
  const min = Math.max(MIN_WORDS, Math.round(o.targetWords * 0.5));
  if (words < min) return { why: `слишком коротко (${words} слов, нужно от ${min})` };
  if (words > o.targetWords * 2.2 + 80) return { why: `слишком длинно (${words} слов при цели ${o.targetWords})` };
  if (/\{\{|\}\}/.test(html)) return { why: "в тексте остались плейсхолдеры {{…}}" };
  return { html };
}

async function writeBatch(env: WriterEnv, batch: BlogSection[], all: BlogSection[]): Promise<{ written: number[]; missing: number[]; transient: boolean; reasons: string[] }> {
  const { ctx } = env;
  const { post, brief, outline } = ctx;
  const expected = batch.map((s) => s.position);
  const out = { written: [] as number[], missing: [...expected], transient: false, reasons: [] as string[] };
  const done = all.filter((s) => s.status === "written" && (s.html ?? "").trim());
  const briefs = batch.map((s) => sectionBriefText(outlineOf(env, s), allowedTags(s.kind), !!s.slotKey)).join("\n\n");
  const writtenSummary = done.length ? done.map((s) => `${s.position}. ${s.heading}: ${firstWords(s.html, 30)}…`).join("\n") : "nothing written yet";
  const userF = fillPrompt(env.userTpl, {
    keyword: post.keyword,
    article_map: articleMap(outline, all.map((s) => ({ position: s.position, kind: s.kind, heading: s.heading, status: s.status }))),
    brief_short: briefShort(brief),
    section_briefs: briefs,
    written_summary: writtenSummary,
  }, { name: USER_KEY });
  const system = userF.system.trim() ? `${userF.system}\n\n${ACCURACY_RULE}` : env.system;
  let user = userF.user;
  if (!/SECTION \d+ —/.test(user)) user += `\n\nSECTIONS TO WRITE NOW:\n${briefs}`;

  let best: { list: Array<{ position: number; html: string }>; missing: number[] } | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retry = attempt === 1 ? "" : `\n\nCRITICAL OUTPUT REQUIREMENTS: return STRICT JSON only: {"sections":[{"position":N,"html":"..."}]} with EVERY requested position. No markdown, no prose outside JSON.`;
    let text = "";
    let got = false;
    for (let rl = 0; rl < 3 && !got; rl++) {
      await ctx.tick(`Секции ${expected.join(",")} (попытка ${attempt}${rl ? `, повтор ${rl}` : ""})`);
      try {
        const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model: env.model, system, user: user + retry, json: true, temperature: 0.7, maxTokens: 12000, timeoutMs: 300_000 });
        text = r.text;
        got = true;
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        if (e.cls.kind === "fatal_run") throw e;
        if (e.cls.kind === "permanent") { out.reasons.push(`ошибка провайдера: ${e.message}`); return out; }
        const wait = e.cls.code === "rate_limited" ? 30_000 * (rl + 1) : backoffMs(rl);
        lastErr = `временная ошибка: ${e.message}`;
        ctx.log(`${lastErr} — ждём ${Math.round(wait / 1000)} с`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    if (!got) { out.transient = true; out.reasons.push(lastErr || "провайдер недоступен"); break; }
    try {
      const parsed = extractJsonFromResponse(text || "{}");
      const list = toSectionList(parsed).map((s) => ({ position: Number(s.position ?? s.section_number ?? s.section ?? NaN), html: String(s.html ?? s.html_content ?? s.content ?? s.text ?? "") })).filter((s) => Number.isFinite(s.position) && expected.includes(s.position));
      if (!list.length && expected.length === 1 && toSectionList(parsed).length === 1) {
        const only = toSectionList(parsed)[0];
        list.push({ position: expected[0], html: String(only.html ?? only.html_content ?? only.content ?? "") });
      }
      if (!list.length) throw new Error("JSON разобран, но секций в нём нет");
      const got2 = new Set(list.map((s) => s.position));
      const missing = expected.filter((n) => !got2.has(n));
      if (!best || list.length > best.list.length) best = { list, missing };
      if (!missing.length) break;
      lastErr = `модель вернула не все секции: нет ${missing.join(",")}`;
      ctx.log(`попытка ${attempt}: ${lastErr}`);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      ctx.log(`попытка ${attempt}: ответ не разобран — ${lastErr}`);
    }
  }
  if (!best) { out.reasons.push(lastErr || "ответ модели не разобран"); return out; }

  for (const got of best.list) {
    const sec = batch.find((s) => s.position === got.position);
    if (!sec) continue;
    const r = acceptSectionHtml(env, sec, got.html);
    if ("why" in r) { out.reasons.push(`секция ${sec.position}: ${r.why}`); ctx.log(`секция ${sec.position}: ${r.why} — не сохраняется`); continue; }
    const tableNote = wantsTable(sec.kind) && !/<table\b/i.test(r.html) ? "no table" : null;
    await prisma.blogSection.update({ where: { id: sec.id }, data: { html: r.html, wordCount: countWords(r.html), status: "written", error: tableNote } });
    out.written.push(sec.position);
  }
  out.missing = expected.filter((n) => !out.written.includes(n));
  return out;
}

export const write: StageHandler = async (ctx) => {
  const { post } = ctx;
  if (!ctx.outline?.sections?.length) return { next: "outline", summary: "Нет плана — возврат к плану" };
  const all = await prisma.blogSection.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });
  if (!all.length) return { next: "outline", summary: "Нет секций — возврат к плану" };
  const pending = all.filter((s) => !(s.status === "written" && (s.html ?? "").trim()));
  if (!pending.length) return { summary: `Все ${all.length} секций уже написаны — пропуск`, details: { skipped: true } };

  const env = buildEnv(ctx);
  const reasons: string[] = [];
  let transientSeen = false;
  let totalWritten = 0;
  const run = async (group: BlogSection[]): Promise<number[]> => {
    try {
      const fresh = await prisma.blogSection.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });
      const o = await writeBatch(env, group, fresh);
      totalWritten += o.written.length;
      if (o.transient) transientSeen = true;
      reasons.push(...o.reasons);
      return o.missing;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      if (e instanceof Error && e.name === "StopRequested") throw e;
      if (ctx.signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      reasons.push(`пачка ${group.map((s) => s.position).join(",")}: ${msg}`);
      ctx.log(`пачка упала: ${msg}`);
      return group.map((s) => s.position);
    }
  };

  // Пачки подряд (контекст предыдущих секций важен для связности)
  let missing = new Set<number>();
  for (let i = 0; i < pending.length; i += BATCH) {
    for (const n of await run(pending.slice(i, i + BATCH))) missing.add(n);
  }
  // Недостающие — по одной
  if (missing.size) {
    const byPos = new Map(pending.map((s) => [s.position, s]));
    const still = [...missing].sort((a, b) => a - b);
    missing = new Set();
    for (const n of still) for (const m of await run([byPos.get(n)!])) missing.add(m);
  }

  const finalRows = await prisma.blogSection.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });
  const empty = finalRows.filter((s) => !(s.status === "written" && (s.html ?? "").trim()));
  const writtenNow = finalRows.length - empty.length;
  const words = finalRows.reduce((n, s) => n + s.wordCount, 0);
  if (empty.length) {
    const positions = empty.map((s) => s.position).join(", ");
    if (transientSeen) return { retryInMs: backoffMs(ctx.retries.transient), retryKind: "transient", summary: `Написано ${writtenNow}/${finalRows.length}; провайдер был недоступен — повтор для секций ${positions}`, details: { reasons } };
    for (const s of empty) await prisma.blogSection.update({ where: { id: s.id }, data: { status: "failed", error: reasons.filter((r) => r.startsWith(`секция ${s.position}:`)).join("; ") || "Модель не вернула текст секции" } });
    return {
      retryInMs: 2 * 60_000, retryKind: "malformed",
      summary: `Написано ${writtenNow}/${finalRows.length}; модель не вернула текст секций ${positions}`,
      giveUp: `Секции без текста после всех попыток: ${positions}. Проверьте причины в журнале и повторите этап «Текст секций».`,
      details: { reasons: reasons.slice(0, 50), written: writtenNow, empty: empty.map((s) => s.position) },
    };
  }
  return { summary: `Написано ${totalWritten} секций (всего ${writtenNow}/${finalRows.length}), ${words} слов`, details: { written: totalWritten, total: finalRows.length, words, model: env.model, reasons: reasons.slice(0, 30) } };
};

/** Одна перепись секции по замечаниям проверки качества (сборка). Новый текст принимается, только если проходит те же проверки. */
export async function rewriteSection(ctx: StageCtx, sec: BlogSection, problems: string[]): Promise<{ ok: boolean; why?: string; costUsd: number }> {
  const env = buildEnv(ctx);
  const o = outlineOf(env, sec);
  const allowed = allowedTags(sec.kind);
  await ctx.tick(`Починка секции ${sec.position}`);
  const user =
    `Rewrite ONE section of the article "${ctx.post.keyword}". The section was rejected by a quality check: ${problems.join("; ")}.\n\n` +
    `${sectionBriefText(o, allowed, !!sec.slotKey)}\n\nRESEARCH BRIEF:\n${briefShort(ctx.brief)}\n\n` +
    (sec.html?.trim() ? `CURRENT HTML (keep the useful facts, fix the problems):\n${sec.html}\n\n` : "") +
    `Return ONLY JSON: {"html": "..."}`;
  const r = await aiChat(ctx.ai, { slot: SLOTS.textMain, model: env.model, system: env.system, user, json: true, temperature: 0.6, maxTokens: 4000, timeoutMs: 180_000 });
  const cost = r.costUsd ?? 0;
  let html = "";
  try {
    const parsed = extractJsonFromResponse(r.text || "{}") as Record<string, unknown>;
    html = String(parsed?.html ?? parsed?.html_content ?? "");
  } catch {
    return { ok: false, why: "ответ не JSON", costUsd: cost };
  }
  const acc = acceptSectionHtml(env, sec, html);
  if ("why" in acc) return { ok: false, why: acc.why, costUsd: cost };
  if (wantsTable(sec.kind) && !/<table\b/i.test(acc.html) && problems.some((p) => /таблиц/i.test(p))) return { ok: false, why: "снова без таблицы", costUsd: cost };
  await prisma.blogSection.update({ where: { id: sec.id }, data: { html: acc.html, wordCount: countWords(acc.html), status: "written", error: null } });
  return { ok: true, costUsd: cost };
}
