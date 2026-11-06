/**
 * Dolphin по командам (2026-11-06): у каждой команды портала свой аккаунт Dolphin и свой токен API (`UplTeamToken`).
 * Агент привязан к команде (`UplAgent.teamId`), получает только её токен, присланные им профили помечаются этой командой
 * (`UplProfile.teamId`), и в сопоставлении сайту предлагаются только профили его команды. Раньше токен был один на весь
 * портал (`UplSettings.dolphinTokenEnc`): токен Никиты (PinOra) заменил токен Zewex у всех агентов.
 * Без next/* — файл нужен API агента.
 */
import type { UplAgent } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";

/** Команда агента; у старых агентов без команды — единственная команда владельца (если она одна). */
export async function agentTeamId(agent: Pick<UplAgent, "teamId" | "userId">): Promise<string | null> {
  if (agent.teamId) return agent.teamId;
  const m = await prisma.teamMember.findMany({ where: { userId: agent.userId }, select: { teamId: true } });
  return m.length === 1 ? m[0].teamId : null;
}

/** Расшифрованный токен Dolphin команды (только агенту этой команды). */
export async function teamDolphinToken(teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  const t = await prisma.uplTeamToken.findUnique({ where: { teamId } });
  if (!t) return null;
  try { return decryptSecret(t.tokenEnc); } catch { return null; }
}

export type TeamTokenRow = { teamId: string; teamName: string; hint: string | null; updatedAt: Date | null; canEdit: boolean };

/** Команды, токены которых человек видит: админ — все, остальные — свои; менять — админ и лид своей команды. */
export async function teamTokenRows(me: CurrentUser): Promise<TeamTokenRow[]> {
  const admin = me.role === "ADMIN";
  const teams = await prisma.team.findMany({ where: admin ? {} : { id: { in: me.teams.map((t) => t.id) } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const tokens = new Map((await prisma.uplTeamToken.findMany({ where: { teamId: { in: teams.map((t) => t.id) } } })).map((t) => [t.teamId, t]));
  const lead = new Set(me.teams.filter((t) => t.lead).map((t) => t.id));
  return teams.map((t) => ({ teamId: t.id, teamName: t.name, hint: tokens.get(t.id)?.hint ?? null, updatedAt: tokens.get(t.id)?.updatedAt ?? null, canEdit: admin || lead.has(t.id) }));
}

export type TeamReadiness = {
  teamId: string; teamName: string; token: string | null; sites: number; mapped: number;
  agents: Array<{ name: string; online: boolean; state: string | null }>; profiles: number; profilesAt: Date | null;
};

/**
 * Готовность каждой команды к заливке — по цепочке «аккаунт Dolphin команды → токен → агент команды → профили → сайты».
 * Показывается на «Сопоставлении», «Агентах» и в инструкции, чтобы сразу было видно, на каком звене разрыв.
 */
export async function teamReadiness(teamIds: string[]): Promise<TeamReadiness[]> {
  if (!teamIds.length) return [];
  const [teams, tokens, agents, profiles, sites] = await Promise.all([
    prisma.team.findMany({ where: { id: { in: teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.uplTeamToken.findMany({ where: { teamId: { in: teamIds } }, select: { teamId: true, hint: true } }),
    prisma.uplAgent.findMany({ where: { teamId: { in: teamIds }, revokedAt: null }, select: { teamId: true, name: true, status: true, state: true } }),
    prisma.uplProfile.groupBy({ by: ["teamId"], where: { teamId: { in: teamIds } }, _count: { _all: true }, _max: { seenAt: true } }),
    prisma.pinSite.findMany({ where: { teamId: { in: teamIds }, isActive: true }, select: { id: true, teamId: true } }),
  ]);
  const mapped = new Set((await prisma.uplAccount.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) }, profileId: { not: null } }, select: { pinSiteId: true } })).map((a) => a.pinSiteId));
  return teams.map((t) => {
    const p = profiles.find((x) => x.teamId === t.id);
    const ts = sites.filter((s) => s.teamId === t.id);
    return {
      teamId: t.id, teamName: t.name, token: tokens.find((x) => x.teamId === t.id)?.hint ?? null,
      sites: ts.length, mapped: ts.filter((s) => mapped.has(s.id)).length,
      agents: agents.filter((a) => a.teamId === t.id).map((a) => ({ name: a.name, online: a.status !== "offline", state: a.state })),
      profiles: p?._count._all ?? 0, profilesAt: p?._max.seenAt ?? null,
    };
  });
}

/** Готовность команд, которые сейчас видит человек: выбранная в шапке, иначе свои (админ — все команды с сайтами пинов). */
export async function myReadiness(me: CurrentUser): Promise<TeamReadiness[]> {
  if (me.activeTeamId) return teamReadiness([me.activeTeamId]);
  if (me.role === "ADMIN") return teamReadiness((await prisma.pinSite.findMany({ where: { isActive: true }, distinct: ["teamId"], select: { teamId: true } })).map((s) => s.teamId));
  return teamReadiness(me.teamIds);
}

/** Команды, к которым человек может привязать своего агента: админ — любые, остальные — свои. */
export async function agentTeamOptions(me: CurrentUser): Promise<Array<{ id: string; name: string }>> {
  return prisma.team.findMany({ where: me.role === "ADMIN" ? {} : { id: { in: me.teams.map((t) => t.id) } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
}
