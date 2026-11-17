/**
 * Автозапуск статей по командам (ArtTeamSettings): у каждой команды свои ключи ИИ, поэтому свои мастер-выключатели,
 * свой потолок одновременных статей и свой режим очереди сайтов. Общие правила — для воркера (worker/articles/queue.ts)
 * и экрана «Автозапуск сайтов» (automation.ts), чтобы диагностика говорила ровно то, что делает очередь.
 *
 * Режим очереди (queueSites = N > 0): вся мощность команды отдаётся N сайтам, у которых есть неначатые статьи
 * (PENDING на первом этапе — поиск фото или концепт). Порядок — кто раньше запущен (самая старая неначатая статья).
 * Остальные сайты с неначатыми статьями ждут: не начинают новые и не пишут начатые. Сайт, у которого неначатых не
 * осталось, дописывает начатое, а его место сразу получает следующий. В очереди участвуют сайты с включённым поиском фото;
 * сайт с выключенным поиском живёт по своим переключателям. Лимиты фото и написания у сайтов в работе поднимаются до
 * доли потолка команды (потолок / N), меньшие лимиты сайта не тормозят очередь.
 */
// Без серверных импортов: TEAM_LIMITS и типы берёт и экран (клиентский компонент), базу передаёт вызывающий.
import type { Prisma, PrismaClient } from "@prisma/client";

export type TeamAutostart = {
  photoMaster: boolean;
  writingMaster: boolean;
  publishMaster: boolean;
  /** Потолок одновременных статей команды «В работе»; 0 — без своего потолка (только воркер) */
  maxConcurrent: number;
  /** Режим очереди: 0 — выключен; N — сколько сайтов команды работают одновременно */
  queueSites: number;
};

export const DEFAULT_TEAM_AUTOSTART: TeamAutostart = { photoMaster: true, writingMaster: true, publishMaster: true, maxConcurrent: 0, queueSites: 0 };
export const TEAM_LIMITS = { maxConcurrent: [0, 300], queueSites: [0, 50] } as const;

/** Первые этапы цепочки: статья на них в PENDING — ещё не начата. */
export const START_STAGES = ["search", "concept"];

type Db = Prisma.TransactionClient | PrismaClient;

export async function loadTeamAutostart(db: Db): Promise<Map<string, TeamAutostart>> {
  const rows = await db.artTeamSettings.findMany();
  return new Map(rows.map((r) => [r.teamId, { photoMaster: r.photoMaster, writingMaster: r.writingMaster, publishMaster: r.publishMaster, maxConcurrent: r.maxConcurrent, queueSites: r.queueSites }]));
}

export function teamAutostart(map: Map<string, TeamAutostart>, teamId: string): TeamAutostart {
  return map.get(teamId) ?? DEFAULT_TEAM_AUTOSTART;
}

/** active — в работе; waiting — ждёт очереди (место №position); draining — неначатых нет, дописывает начатое; null — сайт вне очереди. */
export type QueueRole = { role: "active" | "waiting" | "draining"; position: number };

export type QueueSite = { id: string; name: string; teamId: string; isActive: boolean; photoEnabled: boolean };

/**
 * Роли сайтов в очередях команд. fresh — неначатые статьи по сайтам: число и самая старая (порядок очереди).
 * Возвращает роль только для сайтов команд с включённым режимом.
 */
export function queueRoles(sites: QueueSite[], fresh: Map<string, { count: number; oldest: Date }>, teams: Map<string, TeamAutostart>): Map<string, QueueRole> {
  const out = new Map<string, QueueRole>();
  const byTeam = new Map<string, QueueSite[]>();
  for (const s of sites) {
    if (!s.isActive || !s.photoEnabled || teamAutostart(teams, s.teamId).queueSites <= 0) continue;
    byTeam.set(s.teamId, [...(byTeam.get(s.teamId) ?? []), s]);
  }
  for (const [teamId, list] of byTeam) {
    const n = teamAutostart(teams, teamId).queueSites;
    const withNew = list
      .filter((s) => (fresh.get(s.id)?.count ?? 0) > 0)
      .sort((a, b) => fresh.get(a.id)!.oldest.getTime() - fresh.get(b.id)!.oldest.getTime() || a.name.localeCompare(b.name));
    withNew.forEach((s, i) => out.set(s.id, { role: i < n ? "active" : "waiting", position: i + 1 }));
    for (const s of list) if (!out.has(s.id)) out.set(s.id, { role: "draining", position: 0 });
  }
  return out;
}

/** Неначатые статьи по сайтам (для queueRoles). */
export async function freshBySite(db: Db, siteIds: string[]): Promise<Map<string, { count: number; oldest: Date }>> {
  if (!siteIds.length) return new Map();
  const rows = await db.article.groupBy({ by: ["siteId"], where: { siteId: { in: siteIds }, status: "PENDING", stage: { in: START_STAGES } }, _count: { _all: true }, _min: { createdAt: true } });
  return new Map(rows.map((r) => [r.siteId, { count: r._count._all, oldest: r._min.createdAt ?? new Date() }]));
}

/** Лимит фото и написания сайта в работе очереди: не меньше доли потолка команды (или воркера). */
export function queueLimit(team: TeamAutostart, workerCap: number, siteLimit: number): number {
  const cap = team.maxConcurrent > 0 ? team.maxConcurrent : workerCap;
  return cap > 0 && team.queueSites > 0 ? Math.max(siteLimit, Math.ceil(cap / team.queueSites)) : siteLimit;
}
