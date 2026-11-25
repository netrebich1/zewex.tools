import { prisma } from "@/lib/db";
import { TEAM_SLUG } from "./consts";

/** Команда Zewex: ей принадлежат образы, с её ключей идёт ИИ. */
export async function teamId(): Promise<string | null> {
  return (await prisma.team.findUnique({ where: { slug: TEAM_SLUG }, select: { id: true } }))?.id ?? null;
}
