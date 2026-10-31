/**
 * Автозапуск цепочек сайта (сервис «Статьи») — с 2026-10-15 только разовая миграция старых настроек.
 *
 * Раньше (оригинал: auto_enable_site_phase + idle auto-off queue-orchestrator) цепочка «поиск фото» / «написание»
 * выключалась сама после 15 минут без статей и включалась при новых. Владелец: «пауза 15 минут сбоила очень часто
 * все процессы» — автовыключение убрано совсем. Цепочки включает и выключает только владелец (переключатели сайта
 * и мастер-выключатели). Этот модуль НИЧЕГО не выключает.
 *
 * Что делает autostartTick (вызывается из worker/cron.ts раз в минуту; работает, только пока на сайтах есть старые поля):
 *  - цепочку, выключенную автоматически при простое (offReason = "idle", или без причины при старом autoRestart ≠ false),
 *    включает обратно; выключенную вручную не трогает;
 *  - удаляет служебные поля autoRestart, *IdleSince, *OffReason, *OffAt;
 *  - старое значение «Запуск от» ИИ-модерации 20 (прежний дефолт: ждать пачку) меняет на 1 — проверять сразу.
 * Пишет только подобъекты autostart / aiModeration через updateSiteSettings (сравнение по updatedAt), не затирая
 * то, что владелец сохранил в форме в ту же секунду. В лог — только изменения.
 */
import { prisma } from "@/lib/db";
import { updateSiteSettings } from "@/lib/articles/automation";
import { log } from "../log";

/** Устаревшие ключи autostart, по которым узнаём неперенесённые настройки. */
const LEGACY_KEYS = ["autoRestart", "photoOffReason", "photoOffAt", "photoIdleSince", "writingOffReason", "writingOffAt", "writingIdleSince"] as const;

/** Прежнее значение «Запуск от» по умолчанию — ждать пачку из 20 статей. */
const OLD_DEFAULT_BATCH = 20;

export type AutostartTickResult = { enabled: number; disabled: number; idleStarted: number; migrated: number };

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});

/** Нужна ли сайту миграция (есть ли старые поля). */
function needsMigration(settings: unknown): boolean {
  const a = obj(obj(settings).autostart);
  return LEGACY_KEYS.some((k) => k in a);
}

/**
 * Перенос одного набора настроек. Чистая функция (для проверки без базы): возвращает новый JSON и список изменений
 * или null, если переносить нечего.
 */
export function migrateLegacyAutostart(raw: Raw): { next: Raw; changes: string[]; enabled: number } | null {
  const a = { ...obj(raw.autostart) };
  if (!LEGACY_KEYS.some((k) => k in a)) return null;
  const changes: string[] = [];
  let enabled = 0;
  const hadAutoRestart = a.autoRestart !== false;
  for (const [chain, label] of [["photo", "Поиск фото"], ["writing", "Написание"]] as const) {
    const on = `${chain}Enabled`;
    const reason = a[`${chain}OffReason`];
    // Выключена простоем (или без причины при включённом автовключении — так её выключал старый автозапуск) → включаем.
    if (a[on] === false && (reason === "idle" || (reason === undefined && hadAutoRestart))) {
      a[on] = true;
      enabled++;
      changes.push(`${label} включено снова (было выключено простоем)`);
    }
    for (const k of ["OffReason", "OffAt", "IdleSince"]) delete a[`${chain}${k}`];
  }
  delete a.autoRestart;
  const next: Raw = { ...raw, autostart: a };
  const m = obj(raw.aiModeration);
  if ("aiModeration" in raw && m.batchFrom === OLD_DEFAULT_BATCH) {
    next.aiModeration = { ...m, batchFrom: 1 };
    changes.push("ИИ-проверка: «Запуск от» 20 → 1 (проверять сразу)");
  }
  return { next, changes, enabled };
}

/** Один проход миграции по всем сайтам. Ничего не выключает. */
export async function autostartTick(): Promise<AutostartTickResult> {
  const result: AutostartTickResult = { enabled: 0, disabled: 0, idleStarted: 0, migrated: 0 };
  const sites = await prisma.artSite.findMany({ select: { id: true, name: true, settings: true } });
  for (const site of sites) {
    if (!needsMigration(site.settings)) continue;
    let changes: string[] = [];
    let enabled = 0;
    const wrote = await updateSiteSettings(site.id, (raw) => {
      const m = migrateLegacyAutostart(raw);
      if (!m) return null;
      changes = m.changes;
      enabled = m.enabled;
      return m.next;
    });
    if (!wrote) continue;
    result.migrated++;
    result.enabled += enabled;
    log.info(`articles autostart [${site.name}]: старые настройки автовыключения убраны${changes.length ? `; ${changes.join("; ")}` : ""}`);
  }
  return result;
}
