import { prisma } from "@/lib/db";
import { resolveSlot } from "@/lib/run";
import { probeCache, reenableHealedKeys } from "@/lib/keyHealth";
import { enqueueJob, JobConflict } from "../jobs";
import { PROJECT_SLUG, SLOT_IMAGE_MAIN, SLOT_TEXT_FAST, SLOT_TEXT_MAIN, type JobStage } from "../types";

/** Пометка в причине блокировки: автопродолжение не переходит на более дорогую модель картинок. */
export const COSTLIER_IMAGE_MARK = "Запасной ключ картинок дороже";
/** Во сколько раз новая модель может быть дороже прежней без вопроса человеку. */
const MAX_IMAGE_PRICE_RATIO = 1.2;
const PRICE_DAYS = 60;

/**
 * Автопродолжение прогонов, вставших из-за ключа ИИ (нет баланса, ключ отклонён и автоотключён, не осталось рабочего ключа).
 * Воркер раз в 10 мин: включает обратно вылечившиеся ключи, проверяет ключи, которые достанутся прогону,
 * и если все отвечают — ставит заблокированный этап заново (как кнопка «Продолжить»). Остальные причины блокировки не трогаются.
 */

/** Тексты причин из `handleFailure` (`Ключ «…»: …`) и `resolveSlot` (нет ни одного правила — все ключи слота выключены). */
const KEY_REASON = /Ключ «[^»]*»:|не настроено ни одного правила|работает только через/;
/** Старые блокировки не воскрешаем: владелец мог уже забыть про прогон. */
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;

export async function autoResumeKeyBlockedRuns(): Promise<{ keysEnabled: string[]; resumed: string[]; waiting: number }> {
  const probe = probeCache();
  const { enabled: keysEnabled } = await reenableHealedKeys(probe);

  const runs = await prisma.pinRun.findMany({
    where: { status: "BLOCKED", stopRequested: false, updatedAt: { gte: new Date(Date.now() - MAX_AGE_MS) } },
    select: { id: true, name: true, teamId: true, createdById: true, blockedReason: true },
  });
  const resumed: string[] = [];
  let waiting = 0;
  for (const run of runs) {
    if (!run.blockedReason || !KEY_REASON.test(run.blockedReason) || !run.createdById) continue;
    if (!(await keysReady(run.createdById, run.teamId, run.blockedReason, probe))) {
      waiting++;
      continue;
    }
    // Ключи есть, но картинки пойдут другой моделью дороже прежней — ждём, пока вылечится прежний ключ,
    // или пока человек сам нажмёт «Продолжить» (прогон bellaromakitchen 2026-10-23: OpenAI пуст → Gemini через OpenRouter, ×6.6).
    const costlier = await costlierImageModel(run.id, run.createdById, run.teamId, run.blockedReason);
    if (costlier) {
      waiting++;
      if (!run.blockedReason.includes(COSTLIER_IMAGE_MARK)) {
        await prisma.pinRun.update({ where: { id: run.id }, data: { blockedReason: `${run.blockedReason}\n${costlier}`.slice(0, 2000) } });
      }
      continue;
    }
    const lastJob = await prisma.pinJob.findFirst({ where: { runId: run.id }, orderBy: { createdAt: "desc" }, select: { stage: true } });
    try {
      await enqueueJob(run.id, (lastJob?.stage as JobStage) ?? "meta");
      await prisma.pinRun.update({ where: { id: run.id }, data: { blockedReason: null } });
      resumed.push(run.name);
    } catch (e) {
      if (!(e instanceof JobConflict)) throw e;
    }
  }
  return { keysEnabled, resumed, waiting };
}

/**
 * Прогон встал на первой же картинке, удачных ещё нет: прежней считаем модель того правила картинок команды,
 * чей ключ назван в причине блокировки («Ключ «…»: …»). Иначе новый прогон на пустом OpenAI молча ушёл бы на дорогой ключ.
 */
async function blockingImageBinding(teamId: string, reason: string) {
  const label = reason.match(/Ключ «([^»]*)»:/)?.[1];
  if (!label) return null;
  const b = await prisma.binding.findFirst({
    where: { slot: { key: SLOT_IMAGE_MAIN, project: { slug: PROJECT_SLUG } }, apiKey: { label }, OR: [{ teamId }, { teamId: null }] },
    orderBy: { createdAt: "asc" },
    select: { modelId: true, provider: { select: { name: true } }, model: { select: { modelId: true } }, apiKey: { select: { label: true } } },
  });
  return b?.modelId ? b : null;
}

/** Средняя цена одного успешного вызова картинки по модели за `PRICE_DAYS` дней (журнал расхода, слот image_main пинов). */
async function imagePricePerCall(modelDbId: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ cost: number | null; n: bigint }>>`
    SELECT SUM(u.costUsd) AS cost, COUNT(*) AS n
    FROM UsageLog u JOIN Slot s ON s.id = u.slotId JOIN Project p ON p.id = s.projectId
    WHERE p.slug = ${PROJECT_SLUG} AND s.\`key\` = ${SLOT_IMAGE_MAIN} AND u.ok = 1 AND u.costUsd IS NOT NULL
      AND u.modelId = ${modelDbId} AND u.createdAt >= ${new Date(Date.now() - PRICE_DAYS * 86_400_000)}`;
  const n = Number(rows[0]?.n ?? 0);
  return n >= 5 ? Number(rows[0]?.cost ?? 0) / n : null;
}

/**
 * Картинки прогона уже рисовались одной моделью, а слот сейчас выдаёт другую, заметно дороже (или с неизвестной ценой).
 * Возвращает текст для причины блокировки; null — можно продолжать (картинок ещё не было, модель та же или не дороже).
 */
export async function costlierImageModel(runId: string, userId: string, teamId: string, reason = ""): Promise<string | null> {
  const last = (await prisma.usageLog.findFirst({
    where: { refId: runId, ok: true, slot: { key: SLOT_IMAGE_MAIN, project: { slug: PROJECT_SLUG } } },
    orderBy: { createdAt: "desc" },
    select: { modelId: true, provider: { select: { name: true } }, model: { select: { modelId: true } }, apiKey: { select: { label: true } } },
  })) ?? (await blockingImageBinding(teamId, reason));
  if (!last?.modelId) return null;
  const now = await resolveSlot(userId, PROJECT_SLUG, SLOT_IMAGE_MAIN, teamId);
  if (!now.ok || !now.value.binding.model) return null;
  const b = now.value.binding;
  const model = b.model!;
  if (model.id === last.modelId) return null;
  const [oldPrice, newPrice] = await Promise.all([imagePricePerCall(last.modelId), imagePricePerCall(model.id)]);
  if (oldPrice != null && newPrice != null && newPrice <= oldPrice * MAX_IMAGE_PRICE_RATIO) return null;
  const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}`;
  const how = oldPrice != null && newPrice != null
    ? `≈ ${usd(newPrice)} за картинку против ${usd(oldPrice)}, в ${(newPrice / oldPrice).toFixed(1)} раза дороже`
    : "цену новой модели сравнить не с чем";
  return `${COSTLIER_IMAGE_MARK}: основной ключ картинок прогона — ${last.provider.name} (${last.model?.modelId ?? "?"}, ключ «${last.apiKey?.label ?? "?"}»), ` +
    `а сейчас достаётся ${b.provider.name} (${model.modelId}, ключ «${b.apiKey.label}») — ${how}. ` +
    `Автопродолжение ждёт, пока снова заработает прежний ключ. Чтобы рисовать дороже, нажмите «Продолжить».`;
}

/** Все слоты, которые находятся для пользователя по команде прогона, ведут на работающие ключи, и слот из причины блокировки снова находится. */
async function keysReady(userId: string, teamId: string, reason: string, probe: ReturnType<typeof probeCache>): Promise<boolean> {
  for (const slot of [SLOT_TEXT_MAIN, SLOT_TEXT_FAST, SLOT_IMAGE_MAIN]) {
    const r = await resolveSlot(userId, PROJECT_SLUG, slot, teamId);
    if (!r.ok) {
      // Слот без правил не нужен прогону, если блокировка не про него (например, сайт только на Canvas).
      if (reason.includes(r.error)) return false;
      // Картинки только через OpenAI, а ключа OpenAI нет: прогон, вставший из-за ключа картинок, ждёт его.
      if (slot === SLOT_IMAGE_MAIN && /работает только через/.test(r.error) && /Ключ «[^»]*»:|работает только через/.test(reason)) return false;
      continue;
    }
    if (!(await probe(r.value.binding.apiKey.id)).ok) return false;
  }
  return true;
}
