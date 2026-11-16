/**
 * Визиты агента только за аналитикой Pinterest (фаза `stats`): для сайтов с сопоставленным профилем, по которым статистика
 * не снималась дольше 20 часов. Сайты, которые заливаются в этот день, отдают аналитику в том же визите (AgentTask.stats),
 * отдельный визит им не нужен. Окна по Киеву: ночь 03:00–07:00 (если ПК с агентом включён) и «догоняющее» после 15:00.
 * В одном окне — один запуск на агента, даже если часть визитов упала. Сохранение — `savePinStats` (src/lib/projects/stats.ts).
 */
import { prisma } from "@/lib/db";
import { agentTeamId } from "./teams";

export const STATS_AGENT_VERSION = "0.1.8";
/** Аналитику в визите заливки снимаем, если её не снимали дольше этого. */
export const STATS_WITH_UPLOAD_MS = 12 * 3600_000;
const STALE_MS = 20 * 3600_000;

export function versionGte(v: string | null | undefined, min: string): boolean {
  const a = (v ?? "").split(".").map((x) => parseInt(x, 10) || 0), b = min.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

/** Тик воркера (из uploaderTick, раз в минуту): создать запуски «только аналитика» для агентов на связи. */
export async function statsRunsTick(now = new Date()): Promise<number> {
  const k = now.toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" });
  const hour = Number(k.slice(11, 13)), minute = Number(k.slice(14, 16));
  const from = hour >= 3 && hour < 7 ? 3 : hour >= 15 ? 15 : null;
  if (from == null) return 0;
  const since = new Date(now.getTime() - ((hour - from) * 60 + minute) * 60_000);
  let created = 0;
  const agents = await prisma.uplAgent.findMany({ where: { revokedAt: null, status: { not: "offline" } } });
  for (const a of agents) {
    if (!versionGte(a.version, STATS_AGENT_VERSION)) continue;
    const blocked = await prisma.uplRun.count({ where: { agentId: a.id, OR: [{ status: { in: ["QUEUED", "RUNNING", "VERIFYING"] } }, { source: "stats", createdAt: { gte: since } }] } });
    if (blocked) continue;
    const teamId = await agentTeamId(a);
    if (!teamId) continue;
    const [profiles, sites] = await Promise.all([
      prisma.uplProfile.findMany({ where: { teamId }, select: { id: true } }),
      prisma.pinSite.findMany({ where: { teamId, isActive: true }, select: { id: true } }),
    ]);
    if (!profiles.length || !sites.length) continue;
    const accounts = await prisma.uplAccount.findMany({
      where: { pinSiteId: { in: sites.map((s) => s.id) }, profileId: { in: profiles.map((p) => p.id) }, status: { notIn: ["needs_login", "off", "banned"] }, OR: [{ statsAt: null }, { statsAt: { lt: new Date(now.getTime() - STALE_MS) } }] },
      select: { pinSiteId: true, profileId: true },
    });
    if (!accounts.length) continue;
    const open = new Set((await prisma.uplTask.findMany({ where: { pinSiteId: { in: accounts.map((x) => x.pinSiteId) }, status: { in: ["QUEUED", "LEASED"] } }, select: { pinSiteId: true } })).map((t) => t.pinSiteId));
    const todo = accounts.filter((x) => !open.has(x.pinSiteId));
    if (!todo.length) continue;
    const day = k.slice(0, 10);
    await prisma.uplRun.create({
      data: {
        agentId: a.id, userId: null, source: "stats", day, phase: "stats", parallel: 1, total: todo.length,
        tasks: { createMany: { data: todo.map((x, i) => ({ pinSiteId: x.pinSiteId, profileId: x.profileId!, day, phase: "stats", steps: [{ kind: "analytics" }], status: "QUEUED", order: i })) } },
      },
    });
    created++;
  }
  return created;
}
