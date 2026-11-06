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

/** Команды, к которым человек может привязать своего агента: админ — любые, остальные — свои. */
export async function agentTeamOptions(me: CurrentUser): Promise<Array<{ id: string; name: string }>> {
  return prisma.team.findMany({ where: me.role === "ADMIN" ? {} : { id: { in: me.teams.map((t) => t.id) } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
}
