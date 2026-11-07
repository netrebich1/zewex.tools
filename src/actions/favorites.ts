"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canUseTool } from "@/lib/permissions";

/** Поставить или снять звёздочку с инструмента. Возвращает новое состояние. */
export async function toggleFavorite(projectId: string): Promise<{ favorite: boolean }> {
  const me = await requireUser();
  const key = { userId_projectId: { userId: me.id, projectId } };
  const existing = await prisma.favoriteTool.findUnique({ where: key });
  if (existing) {
    await prisma.favoriteTool.delete({ where: key });
  } else {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true } });
    if (!project || !canUseTool(me, project.slug)) throw new Error("Инструмент не найден");
    await prisma.favoriteTool.create({ data: { userId: me.id, projectId } });
  }
  revalidatePath("/");
  return { favorite: !existing };
}
