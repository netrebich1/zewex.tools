/**
 * Этап rank — «Сравнение кадров» (оригинал: stage-photo-rank/index.ts, шаг 12.5).
 *
 * Балльная оценка одной картинки сбивает все кадры в узкую полосу 70–85; когда модель видит 10 миниатюр разом
 * и обязана выстроить строгий порядок «какой сохранили бы в Pinterest первым», она различает хороший и очень
 * хороший кадр. Группы по 10 → локальный балл 95..25; «турнир чемпионов» (3 лучших из каждой группы, пул 12)
 * сшивает группы: чемпионы 100..72, остальные ≤70. Результат — `ArtPhotoCandidate.beautyRank`
 * (+ `aiBreakdown.beauty_note`), главный вес итогового ранга при отборе; `rankScore` пересчитывается тут же.
 *
 * С 2026-10-16 (волна 3 п.2) этап идёт ПОСЛЕ оценки `rate`: сравниваются только одобренные ею кадры
 * (keep / промо; после прежнего отбора — selected / reserve), ~42 вместо ~130, т.е. 5–6 вызовов вместо 13.
 * Статья, у которой оценённых кадров ещё нет (застала старый порядок на этапе rank), отправляется к `rate`;
 * реестр затем вернёт её сюда. Второй раз подряд не отправляем (cursor.rankToRate) — цикла быть не может.
 *
 * Идемпотентно: сравниваются только одобренные кадры без ранга. Ошибка сравнения не фатальна
 * (direct-pipeline:499 — только warn): группа без ответа получает средний балл 50 после второй попытки.
 * Исключение — отсутствие рабочего ключа и остановка: пробрасываются наверх.
 */
import { prisma } from "@/lib/db";
import type { ArtPhotoCandidate } from "@prisma/client";
import type { ContentPart } from "@/lib/articles/ai";
import { stageModel } from "@/lib/articles/prompts";
import { AiError } from "@/lib/pins/ai/errors";
import { getNicheProfile, specializeProfile, subjectLabel } from "@/lib/articles/photo/profile";
import { VisionImageCache, imageContent, listFromJson, mustRethrow, numberedTitles, visionJson } from "@/lib/articles/photo/vision";
import {
  RANK_CHAMPION_POOL,
  RANK_CHAMPIONS_PER_GROUP,
  RANK_FALLBACK,
  RANK_GROUP_SIZE,
  RANK_NON_CHAMPION_CAP,
  RANK_WAVE,
  beautyChampionScore,
  beautyLocalScore,
  finalPhotoRank,
  readBreakdown,
  seededShuffle,
  topicOf,
} from "@/lib/articles/photo/ranking";
import type { ArtStageHandler } from "./index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type GroupResult = { ids: string[]; notes: Record<string, string> };

/** статусы «одобрен оценкой» (после прежнего отбора keep делится на selected/reserve) */
const KEEP_STATUSES = ["keep", "selected", "reserve"];

export const rank: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const topic = topicOf(article);
  const profile = specializeProfile(await getNicheProfile(recipe.nicheCode, recipe.subnicheCode ?? null), topic);
  const SUBJECT = subjectLabel(profile);
  // Модель — из рецепта (08-plan §3 п.4; аудит 02 п.7.9), иначе модель правила слота vision.
  const model = stageModel(recipe, "rp_photo_rate");

  // Оценки ещё не было (статья застала старый порядок search → filter → rank → rate) — сначала оценка, иначе
  // реестр увёл бы её сразу к отбору без вердиктов. Один раз: после rate здесь всегда есть оценённые кадры
  // (иначе rate сам уходит к filter / search / ожиданию), но на случай неожиданного второй раз не отправляем.
  const rated = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, aiScore: { not: null } } });
  if (!rated && !ctx.cursor.rankToRate) {
    await ctx.save({ cursor: { ...ctx.cursor, rankToRate: true } });
    return { next: "rate", summary: "Кадры ещё не оценены — сначала ИИ-оценка, сравнение после неё", details: { ranked: 0, groups: 0, forced: 0, costUsd: 0, bounced: "rate" } };
  }
  if (ctx.cursor.rankToRate) {
    const cursor = { ...ctx.cursor };
    delete cursor.rankToRate;
    await ctx.save({ cursor });
  }

  // Берём только одобренные оценкой и ещё не сравнённые кадры (оригинал: :101-108 — там были все скачанные).
  const pending = await prisma.artPhotoCandidate.findMany({
    where: { articleId: article.id, status: { in: KEEP_STATUSES }, beautyRank: null },
    orderBy: { createdAt: "asc" },
  });
  const rankedBefore = await prisma.artPhotoCandidate.count({ where: { articleId: article.id, status: { in: KEEP_STATUSES }, beautyRank: { not: null } } });
  if (!pending.length) {
    return { summary: `Все одобренные кадры уже сравнены (${rankedBefore})`, details: { ranked: rankedBefore, groups: 0, forced: 0, costUsd: 0 } };
  }
  await ctx.tick(`Сравниваю ${pending.length} кадров`);

  // оригинал: stage-photo-rank/index.ts:137-152 (дословно по смыслу). Тема статьи — первой строкой user: системное
  // сообщение одинаково для всех статей (кэш промта, волна 3 п.3; здесь оно короче минимума кэша), смысл правил не менялся.
  const SYSTEM = `You are a Pinterest content curator ranking editorial photos for an article (the article topic is given in the user message).
You will see numbered photos. Put them in ORDER from the single most save-worthy pin to the least.

Judge ONLY save-appeal for a Pinterest feed:
- scroll-stopping power: does the frame make a viewer stop mid-scroll?
- aspirational pull: "I want this" — does the viewer want to copy/keep it?
- aesthetic quality: styling, colour harmony, clean attractive background, light
- thumbnail readability: is ${SUBJECT} instantly clear in a small vertical card?
- freshness: boring, generic, flat, cluttered, dated or catalogue-looking frames go LAST.

Do NOT judge topic accuracy — that is checked elsewhere. Do NOT reward a photo just for being sharp or large.
Every position must be unique: no ties, no omissions, no extra numbers.

Return ONLY JSON:
{"order":[{"n":4,"why":"max 8 words"},{"n":1,"why":"..."}]}
where the FIRST element is the best pin and the LAST is the weakest.`;

  const cache = new VisionImageCache();
  let cost = 0;
  let lastError: unknown = null;

  /** Одно сравнение группы: порядок id от лучшего к худшему (оригинал: :155-220). */
  const rankGroup = async (rows: ArtPhotoCandidate[], label: string): Promise<GroupResult | null> => {
    const inlined: Array<{ row: ArtPhotoCandidate; part: ContentPart }> = [];
    for (const row of rows) {
      const img = await cache.get(row, "thumb");
      if (img) inlined.push({ row, part: imageContent(img) });
    }
    if (inlined.length < 2) return inlined.length ? { ids: [inlined[0].row.id], notes: {} } : null;

    const parts: ContentPart[] = [
      { type: "text", text: `Article topic: "${topic}".\nRank these ${inlined.length} photos for Pinterest save-appeal, best first.\n` + numberedTitles(inlined.map((x) => x.row)) },
      ...inlined.map((x) => x.part),
    ];
    let json: unknown;
    try {
      // оригинал: temperature 0.1, maxTokens 1024, timeout 150 с (:173-184)
      const r = await visionJson(ctx.ai, { model, system: SYSTEM, parts, temperature: 0.1, maxTokens: 1024, timeoutMs: 150_000, cacheSystem: true });
      cost += r.costUsd;
      json = r.json;
    } catch (e) {
      if (ctx.signal.aborted || (e instanceof AiError && e.cls.kind === "fatal_run")) throw e;
      lastError = e;
      ctx.log(`группа ${label} не сравнена: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const raw = listFromJson(json, ["order", "photos"]);
    if (!raw.length) return null;

    const ids: string[] = [];
    const notes: Record<string, string> = {};
    const seen = new Set<number>();
    for (const it of raw) {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      const n = Number(typeof it === "number" ? it : o.n ?? o.index);
      if (!Number.isFinite(n) || n < 1 || n > inlined.length || seen.has(n)) continue;
      seen.add(n);
      const row = inlined[n - 1].row;
      ids.push(row.id);
      const why = String(o.why || o.reason || "").trim();
      if (why) notes[row.id] = why.slice(0, 120);
    }
    // кадры, которые модель пропустила, встают в конец в исходном порядке
    for (let i = 0; i < inlined.length; i++) {
      if (!seen.has(i + 1)) ids.push(inlined[i].row.id);
    }
    return ids.length ? { ids, notes } : null;
  };

  // ── Проход 1: пачки по GROUP_SIZE, внутри каждой — строгий порядок (оригинал: :222-255) ──
  const mixed = seededShuffle(pending, article.id);
  const groups: ArtPhotoCandidate[][] = [];
  for (let i = 0; i < mixed.length; i += RANK_GROUP_SIZE) groups.push(mixed.slice(i, i + RANK_GROUP_SIZE));

  const local = new Map<string, number>();
  const notes = new Map<string, string>();
  const champions: ArtPhotoCandidate[] = [];
  const byId = new Map(pending.map((p) => [p.id, p]));
  const applyGroup = (group: ArtPhotoCandidate[], res: GroupResult) => {
    const n = res.ids.length;
    res.ids.forEach((id, pos) => {
      local.set(id, beautyLocalScore(pos, n));
      if (res.notes[id]) notes.set(id, res.notes[id]);
    });
    res.ids.slice(0, RANK_CHAMPIONS_PER_GROUP).forEach((id) => {
      const row = byId.get(id) || group.find((g) => g.id === id);
      if (row) champions.push(row);
    });
  };

  const failed: ArtPhotoCandidate[][] = [];
  for (let gi = 0; gi < groups.length; gi += RANK_WAVE) {
    const wave = groups.slice(gi, gi + RANK_WAVE);
    const results = await Promise.all(wave.map((g, k) => rankGroup(g, `${gi + k + 1}/${groups.length}`)));
    results.forEach((res, k) => (res ? applyGroup(wave[k], res) : failed.push(wave[k])));
    await ctx.tick(`Сравнение кадров: группы ${Math.min(gi + RANK_WAVE, groups.length)}/${groups.length}`);
    if (gi + RANK_WAVE < groups.length) await sleep(400);
  }
  // Ни одна группа не сравнена из-за временной ошибки (лимиты, сеть) — не ставим всем 50, а повторим этап позже.
  if (!local.size && lastError instanceof AiError && lastError.cls.kind === "transient") throw lastError;

  // Второй шанс пропущенным группам (оригинал оставлял их следующему HTTP-вызову; у нас вызов один).
  const stillFailed: ArtPhotoCandidate[][] = [];
  for (const g of failed) {
    await sleep(1000);
    const res = await rankGroup(g, "retry");
    if (res) applyGroup(g, res);
    else stillFailed.push(g);
    await ctx.tick("Сравнение кадров: повтор пропущенных групп");
  }

  // ── Проход 2: турнир чемпионов — сшивает пачки в один общий порядок (оригинал: :257-276) ──
  const finalScore = new Map<string, number>(local);
  let championsRanked = 0;
  if (groups.length > 1 && champions.length > 2) {
    const pool = champions.slice(0, RANK_CHAMPION_POOL);
    const res = await rankGroup(pool, "champions");
    if (res) {
      const n = res.ids.length;
      championsRanked = n;
      res.ids.forEach((id, pos) => {
        finalScore.set(id, beautyChampionScore(pos, n));
        if (res.notes[id]) notes.set(id, res.notes[id]);
      });
      // остальные не могут обогнать чемпионов
      for (const [id, score] of local) {
        if (!res.ids.includes(id)) finalScore.set(id, Math.min(score, RANK_NON_CHAMPION_CAP));
      }
    }
  }

  // Запись (оригинал: :278-285). beautyRank в схеме целый — округляем.
  let written = 0;
  for (const [id, score] of finalScore) {
    const row = byId.get(id);
    if (!row) continue;
    const note = notes.get(id);
    const b = readBreakdown(row);
    await prisma.artPhotoCandidate.update({
      where: { id },
      data: { beautyRank: Math.round(score), aiBreakdown: { ...b, ...(note ? { beauty_note: note } : {}) } as object, rankScore: rankScoreOf(row, Math.round(score)) },
    });
    written++;
  }

  // Кадры, которые модель так и не сравнила, не должны блокировать шаг: средний балл (оригинал: :291-302).
  let forced = 0;
  for (const g of stillFailed) {
    for (const row of g) {
      if (finalScore.has(row.id)) continue;
      await prisma.artPhotoCandidate.update({
        where: { id: row.id },
        data: { beautyRank: RANK_FALLBACK, aiBreakdown: { ...readBreakdown(row), beauty_note: "не удалось сравнить" } as object, rankScore: rankScoreOf(row, RANK_FALLBACK) },
      });
      forced++;
    }
  }
  // Кадры без миниатюры/файла (не попали ни в одну группу) — тоже средний балл, чтобы оценка их увидела.
  for (const row of pending) {
    if (finalScore.has(row.id) || stillFailed.some((g) => g.includes(row))) continue;
    await prisma.artPhotoCandidate.update({
      where: { id: row.id },
      data: { beautyRank: RANK_FALLBACK, aiBreakdown: { ...readBreakdown(row), beauty_note: "не удалось сравнить" } as object, rankScore: rankScoreOf(row, RANK_FALLBACK) },
    });
    forced++;
  }

  const costUsd = Math.round(cost * 1e6) / 1e6;
  return {
    summary: `Сравнено ${written} кадров в ${groups.length} группах${championsRanked ? `, турнир из ${championsRanked}` : ""}${forced ? `, ${forced} без сравнения` : ""}`,
    details: { ranked: rankedBefore + written + forced, written, forced, groups: groups.length, champions: championsRanked, costUsd },
  };
};

/** Итоговый ранг кандидата с новым баллом красоты: оценка (`rate`) писала его без beautyRank — теперь он известен. */
function rankScoreOf(row: ArtPhotoCandidate, beauty: number): number {
  const b = readBreakdown(row);
  return finalPhotoRank({ beauty_rank: beauty, ai_quality: b.ai_quality ?? null, tech_quality: row.techScore, ai_score: row.aiScore });
}
