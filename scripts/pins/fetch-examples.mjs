/**
 * Скачивает картинки примеров пинов (PinExample.sourceUrl — подписанные URL старого
 * Supabase) в хранилище pins/examples/<id>.<ext> и записывает imagePath.
 * Возобновляемый: уже скачанные пропускаются. Запуск: node scripts/pins/fetch-examples.mjs [--concurrency 6]
 */
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile, stat } from "fs/promises";
import { join } from "path";
import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

const prisma = new PrismaClient();
const root = process.env.PINS_STORAGE_DIR || "/var/www/zewex_tools_usr/data/storage";
const dir = join(root, "pins/examples");
await mkdir(dir, { recursive: true });
const args = process.argv.slice(2);
const concurrency = Number(args[args.indexOf("--concurrency") + 1] || 6);

const todo = await prisma.pinExample.findMany({ where: { imagePath: "", sourceUrl: { not: "" } }, select: { id: true, sourceUrl: true } });
console.log(`to download: ${todo.length}`);
let ok = 0, fail = 0, i = 0;

async function one(ex) {
  const u = new URL(ex.sourceUrl);
  const ext = (u.pathname.match(/\.(webp|png|jpe?g|gif)$/i)?.[1] || "webp").toLowerCase().replace("jpeg", "jpg");
  const rel = `pins/examples/${ex.id}.${ext}`;
  const abs = join(root, rel);
  try {
    await stat(abs);
  } catch {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(ex.sourceUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(abs, Buffer.from(await res.arrayBuffer()));
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  await prisma.pinExample.update({ where: { id: ex.id }, data: { imagePath: rel } });
}

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (i < todo.length) {
    const ex = todo[i++];
    try {
      await one(ex);
      ok++;
    } catch (e) {
      fail++;
      console.warn(`fail ${ex.id}: ${e.message}`);
    }
    if ((ok + fail) % 200 === 0) console.log(`progress ${ok + fail}/${todo.length}`);
  }
}));
console.log(`done: ok=${ok} fail=${fail}`);
await prisma.$disconnect();
