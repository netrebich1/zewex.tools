/**
 * Автозапуск цепочек сайта (сервис «Статьи»): раз в минуту из worker/cron.ts.
 *
 * Для сайтов с autostart.autoRestart = true:
 *  - auto-restart (оригинал: триггер auto_enable_site_phase, db/schema.sql:95-115): цепочка выключена автоматически
 *    при простое (offReason = "idle"; без причины — тоже), а в её фазе появились PENDING → включить. Выключенную
 *    вручную (offReason = "manual", переключатель на экране «Автозапуск») не трогаем — как в оригинале;
 *  - idle auto-off (оригинал: queue-orchestrator/index.ts:807-840): цепочка включена, а работы по фазе нет 15 минут →
 *    выключить с пометкой offReason = "idle" и временем. Для «написания» PHOTO_REVIEW и INSUFFICIENT_PHOTOS считаются
 *    будущей работой, этап publish — частью написания. Отсчёт простоя — поле *IdleSince в настройках сайта.
 *
 * Дедупликация по ключу среди бегущих статей здесь не делается (она на постановке в очередь).
 * В лог воркера пишутся только изменения.
 */
import { prisma } from "@/lib/db";
import type { ArtStatus, Prisma } from "@prisma/client";
import { mergeSiteSettings, type ArtSiteSettings } from "@/lib/articles/types";
import { phaseOf } from "@/lib/articles/stages";
import { log } from "../log";

/** Через сколько простоя цепочка выключается сама (оригинал: 15 мин). */
export const IDLE_OFF_MS = 15 * 60_000;

/** Статусы, которые считаются работой или будущей работой для цепочек. */
const WORK_STATUSES: ArtStatus[] = ["PENDING", "RUNNING", "PHOTO_REVIEW", "INSUFFICIENT_PHOTOS"];

type Chain = "photo" | "writing";
type SiteWork = { pending: Record<Chain, number>; busy: Record<Chain, boolean> };

export type AutostartTickResult = { enabled: number; disabled: number; idleStarted: number };

/** Один проход: включить цепочки с ожидающими статьями, выключить простаивающие. */
export async function autostartTick(now = new Date()): Promise<AutostartTickResult> {
  const result: AutostartTickResult = { enabled: 0, disabled: 0, idleStarted: 0 };
  const sites = await prisma.artSite.findMany({ where: { isActive: true }, select: { id: true, name: true, settings: true } });
  if (!sites.length) return result;
  const ids = sites.map((s) => s.id);
  const groups = await prisma.article.groupBy({ by: ["siteId", "status", "stage"], where: { siteId: { in: ids }, status: { in: WORK_STATUSES } }, _count: { _all: true } });

  const work = new Map<string, SiteWork>();
  const emptyWork = (): SiteWork => ({ pending: { photo: 0, writing: 0 }, busy: { photo: false, writing: false } });
  for (const g of groups) {
    const w = work.get(g.siteId) ?? emptyWork();
    const chain: Chain = g.status === "PHOTO_REVIEW" || g.status === "INSUFFICIENT_PHOTOS" ? "writing" : phaseOf(g.stage) === "photos" ? "photo" : "writing";
    w.busy[chain] = true;
    if (g.status === "PENDING") w.pending[chain] += g._count._all;
    work.set(g.siteId, w);
  }

  for (const site of sites) {
    const settings = mergeSiteSettings(site.settings);
    const a = settings.autostart;
    if (!a.autoRestart) continue;
    const w = work.get(site.id) ?? emptyWork();
    const changes: string[] = [];
    const next: ArtSiteSettings["autostart"] = { ...a };

    for (const chain of ["photo", "writing"] as const) {
      const f = FIELDS[chain];
      const enabled = next[f.enabled];
      if (!enabled) {
        // auto-restart: выключенную при простое цепочку включаем, когда в её фазе ждут статьи.
        if (w.pending[chain] > 0 && next[f.offReason] !== "manual") {
          next[f.enabled] = true;
          delete next[f.offReason];
          delete next[f.offAt];
          delete next[f.idleSince];
          changes.push(`${f.label} включено: ждут ${w.pending[chain]}`);
          result.enabled++;
        }
        continue;
      }
      // idle auto-off
      if (w.busy[chain]) {
        if (next[f.idleSince]) { delete next[f.idleSince]; changes.push(`${f.label}: простой прерван`); }
        continue;
      }
      const since = next[f.idleSince] ? Date.parse(next[f.idleSince]!) : NaN;
      if (!Number.isFinite(since)) {
        next[f.idleSince] = now.toISOString();
        result.idleStarted++;
        continue; // начало отсчёта — не логируем, это не изменение поведения
      }
      if (now.getTime() - since >= IDLE_OFF_MS) {
        next[f.enabled] = false;
        next[f.offReason] = "idle";
        next[f.offAt] = now.toISOString();
        delete next[f.idleSince];
        changes.push(`${f.label} выключено: нет статей ${Math.round(IDLE_OFF_MS / 60_000)} мин`);
        result.disabled++;
      }
    }

    if (JSON.stringify(next) === JSON.stringify(a)) continue;
    await prisma.artSite.update({ where: { id: site.id }, data: { settings: { ...settings, autostart: next } as unknown as Prisma.InputJsonValue } });
    if (changes.length) log.info(`articles autostart [${site.name}]: ${changes.join("; ")}`);
  }
  return result;
}

const FIELDS = {
  photo: { label: "Поиск фото", enabled: "photoEnabled", offReason: "photoOffReason", offAt: "photoOffAt", idleSince: "photoIdleSince" },
  writing: { label: "Написание", enabled: "writingEnabled", offReason: "writingOffReason", offAt: "writingOffAt", idleSince: "writingIdleSince" },
} as const satisfies Record<Chain, { label: string; enabled: "photoEnabled" | "writingEnabled"; offReason: "photoOffReason" | "writingOffReason"; offAt: "photoOffAt" | "writingOffAt"; idleSince: "photoIdleSince" | "writingIdleSince" }>;
