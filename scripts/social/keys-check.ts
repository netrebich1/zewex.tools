/** Какие ключи есть у команды WexOra (без секретов) и какие модели озвучки знает портал. Запуск на сервере с .env. */
import { prisma } from "@/lib/db";

async function main() {
  const team = await prisma.team.findUnique({ where: { slug: "wexora" } });
  if (!team) throw new Error("нет команды wexora");
  const keys = await prisma.apiKey.findMany({ where: { teamId: team.id }, include: { provider: true } });
  for (const k of keys) console.log(`${k.status} · ${k.provider.slug} · ${k.provider.adapter} · ${k.provider.baseUrl} · «${k.label}»`);
  const models = await prisma.model.findMany({ where: { OR: [{ modelId: { contains: "tts" } }, { modelId: { contains: "audio" } }] }, include: { provider: true } });
  for (const m of models) console.log(`model ${m.provider.slug}:${m.modelId} · ${m.capabilities}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
