/**
 * Скачивает статические TTF (latin + cyrillic) для всех семейств/начертаний
 * Canvas-движка через google-webfonts-helper (gwfh.mranftl.com) в
 *   $PINS_STORAGE_DIR/pins/fonts/<Family-With-Dashes>/<weight>.ttf
 * Возобновляемый: существующие файлы не качаются. В конце печатает, чего нет,
 * и пишет manifest.json в папку шрифтов.
 *
 * Запуск на сервере: node scripts/pins/fetch-fonts.mjs [--concurrency 4] [--only "Playfair Display"] [--dry]
 */
import { mkdir, writeFile, stat, readFile, rm } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { inflateRawSync } from "zlib";
import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const listPath = join(here, "..", "..", "src", "data", "pins", "canvas-fonts.json");
const root = process.env.PINS_STORAGE_DIR || "/var/www/zewex_tools_usr/data/storage";
const fontsDir = join(root, "pins", "fonts");
const tmpDir = join(fontsDir, ".tmp");

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const concurrency = Math.max(1, Number(flag("--concurrency", 4)) || 4);
const only = flag("--only", "");
const dry = args.includes("--dry");

const families = JSON.parse(await readFile(listPath, "utf8"));
await mkdir(fontsDir, { recursive: true });
await mkdir(tmpDir, { recursive: true });

/** Имя папки: пробелы → дефисы (host.node.ts делает обратное). */
const folderOf = (family) => family.trim().replace(/\s+/g, "-");
/** id в gwfh: строчные, пробелы → дефисы. */
const gwfhId = (family) => family.trim().toLowerCase().replace(/\s+/g, "-");
/** Только стандартные веса 100..900 (в пакете есть «1» у вариативных). */
const normWeights = (ws) => [...new Set(ws.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900 && w % 100 === 0))].sort((a, b) => a - b);
const variantOf = (w) => (w === 400 ? "regular" : String(w));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

/* ---------- мини-читалка zip (stored / deflate), запасной путь — unzip CLI ---------- */
function unzipBuffer(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: не найден конец центрального каталога");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip: битый центральный каталог");
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    const ln = buf.readUInt16LE(lho + 26), le = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + ln + le;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
  }
  return out;
}

async function unzipViaCli(zipPath) {
  const dir = `${zipPath}.d`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await execFileAsync("unzip", ["-o", "-q", "-j", zipPath, "-d", dir]);
  const { readdir } = await import("fs/promises");
  const names = await readdir(dir);
  const out = [];
  for (const n of names) out.push({ name: n, data: await readFile(join(dir, n)) });
  await rm(dir, { recursive: true, force: true });
  return out;
}

async function download(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) { const e = new Error("нет в gwfh (404)"); e.fatal = true; throw e; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Вес из имени файла gwfh: ...-regular.ttf → 400, ...-700.ttf → 700; italic пропускаем. */
function weightFromName(name) {
  const m = /-(regular|[1-9]00)\.ttf$/i.exec(name);
  if (!m) return null;
  return m[1].toLowerCase() === "regular" ? 400 : Number(m[1]);
}

const manifest = { generatedAt: new Date().toISOString(), root: fontsDir, families: {}, missingFamilies: [], missingWeights: [] };

async function one(def) {
  const family = def.family;
  const folder = folderOf(family);
  const dir = join(fontsDir, folder);
  const want = normWeights(def.weights);
  const entry = { folder, ok: [], missing: [], skipped: [] };
  manifest.families[family] = entry;
  const need = [];
  for (const w of want) {
    if (await exists(join(dir, `${w}.ttf`))) entry.ok.push(w);
    else need.push(w);
  }
  if (!need.length) { entry.skipped = want; return; }
  if (dry) { entry.missing = need; return; }

  const id = gwfhId(family);
  const url = `https://gwfh.mranftl.com/api/fonts/${id}?download=zip&subsets=latin,cyrillic&variants=${need.map(variantOf).join(",")}&formats=ttf`;
  let zip;
  try {
    zip = await download(url);
  } catch (e) {
    entry.error = e.message;
    entry.missing = need;
    return;
  }
  const zipPath = join(tmpDir, `${id}.zip`);
  let files;
  try {
    files = unzipBuffer(zip);
  } catch {
    await writeFile(zipPath, zip);
    try { files = await unzipViaCli(zipPath); } catch (e) { entry.error = `unzip: ${e.message}`; entry.missing = need; return; }
    finally { await rm(zipPath, { force: true }); }
  }
  await mkdir(dir, { recursive: true });
  const got = new Set();
  for (const f of files) {
    const w = weightFromName(f.name);
    if (w === null || !need.includes(w) || !f.data.length) continue;
    const target = join(dir, `${w}.ttf`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, f.data);
    const { rename } = await import("fs/promises");
    await rename(tmp, target);
    got.add(w);
  }
  for (const w of need) (got.has(w) ? entry.ok : entry.missing).push(w);
  entry.ok.sort((a, b) => a - b);
}

const todo = families.filter((f) => !only || f.family === only);
console.log(`families: ${todo.length}, target: ${fontsDir}${dry ? " (dry run)" : ""}`);
let i = 0, done = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (i < todo.length) {
    const def = todo[i++];
    try {
      await one(def);
    } catch (e) {
      manifest.families[def.family] = { folder: folderOf(def.family), ok: [], missing: normWeights(def.weights), error: e.message };
    }
    done++;
    const e = manifest.families[def.family];
    const tag = e.error ? `FAIL ${e.error}` : e.missing.length ? `partial (missing ${e.missing.join(",")})` : e.skipped?.length ? "cached" : "ok";
    console.log(`[${done}/${todo.length}] ${def.family}: ${tag}`);
  }
}));

for (const [family, e] of Object.entries(manifest.families)) {
  if (!e.ok.length && !e.skipped?.length) manifest.missingFamilies.push(family);
  else if (e.missing.length) manifest.missingWeights.push({ family, weights: e.missing });
}
await rm(tmpDir, { recursive: true, force: true });
if (!dry) await writeFile(join(fontsDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("\n=== итог ===");
console.log(`семейств без файлов: ${manifest.missingFamilies.length}`);
for (const f of manifest.missingFamilies) console.log(`  - ${f}: ${manifest.families[f].error || "нет файлов"}`);
console.log(`семейств с неполным набором начертаний: ${manifest.missingWeights.length}`);
for (const m of manifest.missingWeights) console.log(`  - ${m.family}: ${m.weights.join(", ")}`);
if (!dry) console.log(`manifest: ${join(fontsDir, "manifest.json")}`);
