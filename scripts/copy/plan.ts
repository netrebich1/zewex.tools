/**
 * Article Copy: проверить или запустить автоподбор вручную.
 *   npx tsx scripts/copy/plan.ts --site <имя или id> [--core "almond nails"] [--n 3]          — только показать, что соберётся
 *   npx tsx scripts/copy/plan.ts --site <имя или id> --create [--review]                       — создать одну статью
 * --review: статья после сборки ждёт одобрения в модерации статей, сама не публикуется.
 */
import { prisma } from "@/lib/db";
import { copySettings } from "@/lib/copy/build";
import { buildForSite } from "@/lib/copy/auto";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? null : process.argv[i + 1] ?? ""; };
const has = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const q = arg("site");
  if (!q) throw new Error("нужен --site");
  const site = await prisma.artSite.findFirst({ where: { OR: [{ id: q }, { name: { contains: q } }] }, select: { id: true, teamId: true, name: true, nicheCode: true } });
  if (!site) throw new Error("сайт не найден");
  const st = await copySettings();
  const create = has("create");
  const n = create ? 1 : Number(arg("n") || 1);
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    const { result, tried } = await buildForSite(site, st, { dry: !create, review: has("review"), core: arg("core") || undefined });
    for (const r of tried) if (!r.ok) console.log(`  пропуск: ${r.core} — ${r.reason}`);
    console.log(result ? JSON.stringify(result) : "ничего не собралось", `(${Date.now() - t} мс)`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
