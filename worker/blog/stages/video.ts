/**
 * Этап `video` (после research, до outline): одно хорошее видео YouTube для статьи — по содержанию, а не по названию.
 * Режимы рецепта: params.video.embed = auto — вставить, если найдётся достойное; params.source = video — «статья по видео»:
 * метод из лучшего видео становится основным источником (бриф дополняется методом видео). Статья по видео — только для
 * инструкций (intent how_to) и не для тем здоровья/денег (YMYL); не нашлось годного видео — обычная статья, запись в журнал.
 * Стоимость: выдача ~$0.002 + субтитры ~$0.006 × 3 + оценка ~$0.0015 × 3 (+ метод ~$0.002) ≈ $0.025–0.03.
 * Идемпотентен: если выбор уже сделан (или видео выбрал/убрал человек) — пропуск.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AiError } from "@/lib/pins/ai/errors";
import { aiChat, dfsRequest } from "@/lib/blog/ai";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { stageModel } from "@/lib/blog/prompts";
import { SLOTS, type BlogBrief } from "@/lib/blog/types";
import { candidatesFromDfs, judgeDecision, prefilterVideos, transcriptFromDfs, VIDEO_LIMITS, type BlogVideoState, type VideoBrief, type VideoCandidate, type VideoJudge } from "@/lib/blog/video";
import type { StageHandler } from "./index";

const JUDGE_SYSTEM = `You check whether a YouTube video is good enough to embed in a blog article and would not embarrass it. You see the article topic, the research summary and the video transcript with timestamps.
Judge the CONTENT, not the title: does the video actually teach what the article is about, accurately and clearly, as a helpful demonstration? Red flags (list them literally if present): "mostly a product ad or haul", "heavy sponsor reads", "long rambling intro", "different technique than the article", "wrong topic", "low effort", "clickbait", "unsafe advice", "misleading".
start_at_seconds = where the actual how-to starts (skip intros and sponsor reads).
Return ONLY JSON: {"relevance":0-10,"quality":0-10,"start_at_seconds":0,"covers":["..."],"red_flags":["..."],"verdict":"embed|maybe|reject","why":"one sentence"}`;

const BRIEF_SYSTEM = `You extract the method from a how-to video transcript for a writer who will write an article based on it. Paraphrase in your own words, keep concrete numbers the creator says (sizes, minutes, temperatures, amounts).
Return ONLY JSON: {"steps":["one step per item, in the video's order"],"tips":["..."],"mistakes":["mistakes or warnings the creator mentions"],"not_covered":["important parts of the topic the video does not cover"]}`;

const arr = (v: unknown, n: number, len = 240) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim().slice(0, len)).filter(Boolean).slice(0, n) : []);

export const videoStage: StageHandler = async (ctx) => {
  const { post, recipe } = ctx;
  const source = recipe.params.source ?? "research";
  const embed = recipe.params.video?.embed ?? "off";
  if (source !== "video" && embed === "off") return { summary: "Видео выключено в рецепте" };
  const prev = (post.video ?? null) as BlogVideoState | null;
  if (prev && (prev.manual || prev.at)) return { summary: prev.chosen ? `Видео уже выбрано: «${prev.chosen.title}»` : `Видео уже подбиралось: ${prev.note ?? "не найдено"}`, details: { skipped: true } };

  const brief = ctx.brief as (BlogBrief & { video?: unknown }) | null;
  let videoFirst = source === "video";
  let note = "";
  if (videoFirst && brief && (!["how_to", "problem_fix"].includes(brief.intent) || brief.ymyl)) {
    videoFirst = false;
    note = brief.ymyl ? "тема здоровья/денег — статья по исследованию, видео только как вставка" : `интент «${brief.intent}» — статья по исследованию, видео только как вставка`;
  }
  let cost = 0;
  const model = stageModel(recipe, "research");

  // 1) Выдача YouTube
  await ctx.tick("Видео: выдача YouTube");
  const s = await dfsRequest(ctx.ai, "serp/youtube/organic/live/advanced", [{ keyword: post.keyword, location_code: 2840, language_code: "en", device: "desktop", block_depth: 20 }]);
  cost += s.costUsd ?? 0;
  if (!s.ok) {
    const st: BlogVideoState = { source, embed, videoFirst: false, note: `выдача YouTube не получена: ${s.error ?? s.status}`, candidates: [], chosen: null, costUsd: cost, at: new Date().toISOString() };
    await prisma.blogPost.update({ where: { id: post.id }, data: { video: st as unknown as Prisma.InputJsonValue } });
    return { summary: `Видео: ${st.note} — статья без видео` };
  }
  const all = candidatesFromDfs(s.data);
  const pre = prefilterVideos(all);

  // 2) Встраивание разрешено (oEmbed) — до трёх кандидатов
  const picked: VideoCandidate[] = [];
  for (const v of pre) {
    if (picked.length >= VIDEO_LIMITS.judgeTop) break;
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v.id}`)}`, { signal: AbortSignal.timeout(10_000) });
      v.embeddable = r.ok;
    } catch { v.embeddable = false; }
    if (v.embeddable) picked.push(v); else { v.decision = "reject"; v.reason = "владелец запретил встраивание"; }
  }

  // 3) Субтитры + 4) оценка содержания
  const topic = `Article topic: "${post.keyword}"\nResearch summary: ${brief?.summary?.slice(0, 600) ?? "-"}\nKey materials: ${(brief?.materials ?? []).slice(0, 8).join("; ") || "-"}\nKey dos: ${(brief?.dos ?? []).slice(0, 6).join("; ") || "-"}`;
  const transcripts = new Map<string, string>();
  for (const v of picked) {
    await ctx.tick(`Видео: субтитры и оценка «${v.title.slice(0, 40)}»`);
    const t = await dfsRequest(ctx.ai, "serp/youtube/video_subtitles/live/advanced", [{ video_id: v.id, language_code: "en", location_code: 2840 }]);
    cost += t.costUsd ?? 0;
    const tr = transcriptFromDfs(t.data);
    v.transcriptWords = tr.words;
    if (tr.words < 80) { v.decision = "reject"; v.reason = "нет английских субтитров"; continue; }
    transcripts.set(v.id, tr.text);
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model, system: JUDGE_SYSTEM, user: `${topic}\n\nVideo: "${v.title}" by ${v.channel}, ${v.sec}s, ${v.views} views\nTranscript:\n${tr.text.slice(0, 14000)}`, json: true, temperature: 0.2, maxTokens: 700, timeoutMs: 120_000 });
      cost += r.costUsd ?? 0;
      const j = (parseModelJsonSafe(r.text) ?? {}) as Record<string, unknown>;
      const judge: VideoJudge = {
        relevance: Math.max(0, Math.min(10, Number(j.relevance) || 0)),
        quality: Math.max(0, Math.min(10, Number(j.quality) || 0)),
        startAt: Math.max(0, Math.min(v.sec - 10, Math.round(Number(j.start_at_seconds) || 0))),
        covers: arr(j.covers, 10, 120),
        redFlags: arr(j.red_flags, 8, 120),
        verdict: String(j.verdict ?? ""),
        why: String(j.why ?? "").slice(0, 300),
      };
      v.judge = judge;
      const d = judgeDecision(judge, { videoFirst, words: tr.words });
      v.decision = d.ok ? "embed" : "reject";
      v.reason = d.reason;
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      v.decision = "reject";
      v.reason = `оценка не получена: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }
  }
  const passed = picked.filter((v) => v.decision === "embed").sort((a, b) => (b.judge!.relevance * 0.6 + b.judge!.quality * 0.4) - (a.judge!.relevance * 0.6 + a.judge!.quality * 0.4));
  const chosen = passed[0] ?? null;

  // 5) Метод из видео для «статьи по видео»
  let videoBrief: VideoBrief | null = null;
  if (chosen && videoFirst) {
    await ctx.tick("Видео: метод для статьи");
    try {
      const r = await aiChat(ctx.ai, { slot: SLOTS.textFast, model, system: BRIEF_SYSTEM, user: `Topic: "${post.keyword}"\nVideo: "${chosen.title}" by ${chosen.channel}\nTranscript:\n${(transcripts.get(chosen.id) ?? "").slice(0, 16000)}`, json: true, temperature: 0.3, maxTokens: 1500, timeoutMs: 120_000 });
      cost += r.costUsd ?? 0;
      const j = (parseModelJsonSafe(r.text) ?? {}) as Record<string, unknown>;
      videoBrief = { steps: arr(j.steps, 14), tips: arr(j.tips, 8), mistakes: arr(j.mistakes, 8), notCovered: arr(j.not_covered, 6) };
      if (videoBrief.steps.length < 3) { videoBrief = null; note = "метод из видео не извлечён — статья по исследованию с видео-вставкой"; }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      note = `метод из видео не получен — статья по исследованию с видео-вставкой`;
    }
  }
  if (videoFirst && !chosen) note = "годного видео нет — статья по исследованию";
  if (brief && videoBrief && chosen) await ctx.save({ brief: { ...brief, video: { id: chosen.id, title: chosen.title, channel: chosen.channel, ...videoBrief } } as BlogBrief });

  const st: BlogVideoState = { source, embed, videoFirst: !!videoBrief, note: note || undefined, candidates: [...picked, ...pre.filter((v) => !picked.includes(v) && v.decision === "reject")].slice(0, 8), chosen, costUsd: Math.round(cost * 1e5) / 1e5, at: new Date().toISOString() };
  await prisma.blogPost.update({ where: { id: post.id }, data: { video: st as unknown as Prisma.InputJsonValue } });
  return {
    summary: chosen
      ? `Видео: «${chosen.title}» (${chosen.channel}), релевантность ${chosen.judge?.relevance}/10, старт ${chosen.judge?.startAt}s${videoBrief ? " · статья по видео" : ""}${note ? ` · ${note}` : ""} · $${st.costUsd}`
      : `Видео не подошло (${picked.map((v) => `${v.channel}: ${v.reason}`).join("; ") || `после фильтра 0 из ${all.length}`})${note ? ` · ${note}` : ""} · $${st.costUsd}`,
    details: { chosen: chosen?.id ?? null, videoFirst: !!videoBrief, found: all.length, prefiltered: pre.length, judged: picked.length, costUsd: st.costUsd },
  };
};
