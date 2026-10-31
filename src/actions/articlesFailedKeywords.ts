"use server";
/**
 * Действия списка «Неудачные ключи»: отметка «не считать» и заметка. Доступ — по сайту строки (canAccessArtSite).
 * Вызываются напрямую из components/articles/FailedKeywordRowActions.tsx.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessArtSite } from "@/lib/articles/access";

async function rowForUser(id: string) {
  const me = await requireUser();
  const row = await prisma.artFailedKeyword.findUnique({ where: { id: String(id) }, select: { id: true, siteId: true } });
  if (!row) throw new Error("Строка не найдена");
  const site = await prisma.artSite.findUnique({ where: { id: row.siteId }, select: { teamId: true, accessId: true } });
  if (!site || !(await canAccessArtSite(me, site))) throw new Error("Нет доступа к сайту");
  return { me, row };
}

/** «Не считать»: ключ остаётся в списке, но не входит в счётчики, сводку и подсказки при запуске. */
export async function setFailedKeywordIgnored(id: string, ignored: boolean): Promise<{ error?: string }> {
  try {
    const { me, row } = await rowForUser(id);
    await prisma.artFailedKeyword.update({ where: { id: row.id }, data: { ignored: !!ignored, ignoredById: ignored ? me.id : null } });
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  revalidatePath("/pinterest/articles/failed-keywords");
  return {};
}

/** Заметка к ключу (до 1000 символов; пустая — удалить). */
export async function setFailedKeywordNote(id: string, note: string): Promise<{ error?: string }> {
  try {
    const { row } = await rowForUser(id);
    const text = String(note ?? "").trim().slice(0, 1000);
    await prisma.artFailedKeyword.update({ where: { id: row.id }, data: { note: text || null } });
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  revalidatePath("/pinterest/articles/failed-keywords");
  return {};
}
