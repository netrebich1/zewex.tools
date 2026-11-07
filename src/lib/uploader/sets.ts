/** Наборы сайтов (галочки): свои у каждого пользователя, админ видит все. Используются формой запуска и расписанием агента. */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";

export type SetRow = { id: string; userId: string; name: string; siteIds: string[]; updatedAt: Date };

export const parseSiteIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function setRows(me: CurrentUser): Promise<SetRow[]> {
  const rows = await prisma.uplSet.findMany({ where: me.role === "ADMIN" ? {} : { userId: me.id }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ id: r.id, userId: r.userId, name: r.name, siteIds: parseSiteIds(r.siteIds), updatedAt: r.updatedAt }));
}

export async function setFor(me: CurrentUser, id: string): Promise<SetRow | null> {
  const r = await prisma.uplSet.findUnique({ where: { id } });
  if (!r || (me.role !== "ADMIN" && r.userId !== me.id)) return null;
  return { id: r.id, userId: r.userId, name: r.name, siteIds: parseSiteIds(r.siteIds), updatedAt: r.updatedAt };
}

/** Сайты набора для расписания агента (без проверки сессии — крон). */
export async function setSiteIds(setId: string): Promise<string[] | null> {
  const r = await prisma.uplSet.findUnique({ where: { id: setId } });
  return r ? parseSiteIds(r.siteIds) : null;
}
