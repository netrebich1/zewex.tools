/** Общее для скриптов семантики на языках. */
import { prisma } from "@/lib/db";

export const NICHE_LABEL: Record<string, string> = { nails: "nail designs, manicure and nail care", hair: "haircuts, hairstyles and hair color", outfits: "women's clothing and outfits", interior: "home interior and decor" };

/** Контекст ИИ: администратор + команда, которая собирает мешап-статьи (у неё настроены слоты моделей). */
export async function aiCtxForLocale(teamOverride?: string): Promise<{ userId: string; teamId: string }> {
  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!user) throw new Error("нет администратора");
  const lastCopy = await prisma.copyArticle.findFirst({ orderBy: { id: "desc" }, select: { teamId: true } });
  const teamId = teamOverride ?? lastCopy?.teamId;
  if (!teamId) throw new Error("нет команды с мешап-статьями — укажите --team");
  return { userId: user.id, teamId };
}

/** Свёртка для сравнения фраз: строчные, без диакритики, одиночные пробелы. */
export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
