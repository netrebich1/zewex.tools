/**
 * Проба «Соцсетей» на живой статье без создания прогона: загрузка статьи + посты (настоящий вызов модели, ~$0.005).
 * Запуск на сервере: set -a && . .env && set +a && npx tsx scripts/social/try.ts <url> [сети через запятую]
 */
import { prisma } from "@/lib/db";
import { loadArticle } from "@/lib/social/article";
import { generatePosts } from "@/lib/social/generate";
import { hostedImages } from "@/lib/social/images";
import { parseSettings, type NetworkKey } from "@/lib/social/types";

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("Нужен адрес статьи");
  const nets = (process.argv[3] ?? "instagram,threads,x,facebook").split(",") as NetworkKey[];
  const owners = (process.env.ALLOWED_REGISTRATION_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const user = (owners.length ? await prisma.user.findFirst({ where: { email: { in: owners } } }) : null) ?? (await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } }));
  const article = await loadArticle(url);
  console.log(`Статья: ${article.title}\nязык ${article.lang || "?"}, текст ${article.text.length} знаков, фото ${article.images.length}`);
  for (const im of article.images.slice(0, 6)) console.log(`  ${im.url}`);
  const settings = parseSettings({ networks: nets });
  const started = Date.now();
  const { posts, costUsd } = await generatePosts({ userId: user.id, runId: "try", url, article, settings, nets, prepareImages: (net, images) => hostedImages("try", net, images) });
  console.log(`\nГотово за ${Math.round((Date.now() - started) / 1000)} с, $${costUsd.toFixed(4)}`);
  for (const [net, p] of Object.entries(posts)) {
    console.log(`\n── ${net} (${p!.text.length} зн., фото ${p!.images.length}${p!.trimmed ? ", обрезан" : ""}${p!.skipped ? `, пропущен: ${p!.skipped}` : ""})\n${p!.text}\n${p!.images.join("\n")}`);
  }
}

main().catch((e) => { console.error("ОШИБКА:", e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
