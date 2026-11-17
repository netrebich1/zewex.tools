/**
 * Сквозная проверка «Соцсетей» через настоящую очередь воркера: создаёт прогон от имени владельца, ждёт готовности,
 * собирает файлы Metricool и печатает сводку. Прогон остаётся в списке как пример.
 * Запуск на сервере: set -a && . .env && set +a && npx tsx scripts/social/run-test.ts <url> [url…]
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { createRun, deleteRun, metricoolHeader } from "@/lib/social/runs";
import { buildExport, parseCsvLine } from "@/lib/social/metricool";
import { parseSettings, type SocialPosts } from "@/lib/social/types";

async function main() {
  // Аргументы: адреса статей, либо «сайт N» — тогда статьи подбираются по правилу тем (source.ts).
  const args = process.argv.slice(2);
  const auto = args.length === 2 && /^\d+$/.test(args[1]) ? { site: args[0], count: Number(args[1]) } : undefined;
  const urls = auto ? [] : args;
  if (!urls.length && !auto) throw new Error("Нужны адреса статей или «сайт N»");
  const owners = (process.env.ALLOWED_REGISTRATION_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const user = (owners.length ? await prisma.user.findFirst({ where: { email: { in: owners } } }) : null) ?? (await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } }));
  const me = { id: user.id, role: "ADMIN", teamIds: [], leadTeamIds: [] } as unknown as CurrentUser;
  const NAME = "Пример: мода, ногти, волосы — посты и видео";
  // Прошлые примеры этого скрипта убираем, чтобы в списке был один актуальный.
  for (const old of await prisma.socialRun.findMany({ where: { name: { startsWith: "Пример: " }, createdById: user.id }, select: { id: true } })) await deleteRun(me, old.id).catch(() => undefined);
  const settings = parseSettings({ networks: ["instagram", "threads", "facebook", "tiktok", "linkedin", "gbp", "ig_reel", "tiktok_video", "yt_short"], schedule: { perDay: 3 } });
  const id = await createRun(me, NAME, urls.join("\n"), settings, auto);
  console.log(`прогон ${id} — жду воркер…`);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const run = await prisma.socialRun.findUniqueOrThrow({ where: { id } });
    if (run.status === "DONE" || run.status === "FAILED") {
      console.log(`статус ${run.status} за ${Math.round((Date.now() - started) / 1000)} с, расход $${run.costUsd.toFixed(4)}${run.error ? `, ${run.error}` : ""}`);
      break;
    }
    if (Date.now() - started > 900_000) throw new Error(`воркер не закончил за 15 минут (статус ${run.status})`);
  }
  const items = await prisma.socialItem.findMany({ where: { runId: id }, orderBy: { position: "asc" } });
  for (const it of items) console.log(`  ${it.status} · ${it.title || it.url}${it.error ? ` · ${it.error}` : ""}`);
  const { header, custom } = await metricoolHeader();
  const files = buildExport(header, items.filter((i) => i.status === "done").map((i) => ({ id: i.id, position: i.position, posts: (i.posts ?? {}) as SocialPosts })), settings, "primer");
  console.log(`шаблон: ${custom ? "из аккаунта" : "из справки"}, файлов ${files.length}`);
  for (const f of files) {
    const lines = f.data.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    const head = parseCsvLine(lines[0]);
    const row = parseCsvLine(lines[1]);
    const col = (n: string) => row[head.indexOf(n)] ?? "";
    console.log(`  ${f.name}: строк ${f.rows}, колонок ${row.length}/${head.length}, ${col("Date")} ${col("Time")}, фото1 ${col("Picture Url 1")}, текст ${col("Text").length} зн.`);
  }
}

main().catch((e) => { console.error("ОШИБКА:", e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
