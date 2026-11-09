import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";
import { UPLOADER } from "./types";

export { visiblePinSites, userAsCurrent, type SiteRow } from "./sites";

/** Заливка в Pinterest: обычный инструмент (`Permissions.tools`); сайты — по видимости сайтов, агенты — свои (админ видит все). */
export async function requireUploader(): Promise<CurrentUser> {
  const me = await requireUser();
  if (!canUseTool(me, UPLOADER)) redirect("/?denied=1");
  return me;
}

export async function uploaderUser(): Promise<CurrentUser | null> {
  const me = await getCurrentUser();
  return me && canUseTool(me, UPLOADER) ? me : null;
}

export const isAdmin = (me: CurrentUser) => me.role === "ADMIN";

/** Агент по id, если он принадлежит этому человеку (админ — любой). */
export async function agentFor(me: CurrentUser, agentId: string) {
  const a = await prisma.uplAgent.findUnique({ where: { id: agentId } });
  if (!a || a.revokedAt || (!isAdmin(me) && a.userId !== me.id)) throw new Error("Агент не найден или не ваш");
  return a;
}

/** Запуск, который этот человек может видеть: свой агент или админ. */
export async function runFor(me: CurrentUser, runId: string) {
  const run = await prisma.uplRun.findUnique({ where: { id: runId }, include: { agent: { select: { id: true, name: true, userId: true } } } });
  if (!run || (!isAdmin(me) && run.agent.userId !== me.id && run.userId !== me.id)) return null;
  return run;
}
