/**
 * Аудит мешап-статей: соответствует ли каждая секция (заголовок + текст) своему фото. Модель зрения смотрит кадр и
 * текст секции и отвечает match: yes | partial | no с пояснением. Расход пишется на владельца ключей сайта.
 *   sudo -u zewex_tools_usr -H npx tsx scripts/copy/audit-photos.ts --batch <id> | --article <id> [--article <id>] [--model openrouter:google/gemini-2.5-flash-lite] [--limit 300]
 * Печатает сводку по статьям и все «partial»/«no».
 */
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { aiChat, imagePart } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { absPath, exists } from "@/lib/articles/storage";

const args = process.argv.slice(2);
const get = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MODEL = get("--model", "openrouter:google/gemini-2.5-flash-lite");
const LIMIT = Number(get("--limit", "400"));

type Section = { heading: string; text: string; img: string | null };
/** Секции статьи из html: h2 → (img, p…) до следующего h2. */
function sections(html: string): Section[] {
  const out: Section[] = [];
  const parts = html.split(/<h2[^>]*>/i).slice(1);
  for (const p of parts) {
    const heading = p.slice(0, p.indexOf("</h2>")).replace(/<[^>]+>/g, "").trim();
    const rest = p.slice(p.indexOf("</h2>") + 5);
    const img = /<img[^>]+src="([^"]+)"/i.exec(rest)?.[1] ?? null;
    const text = rest.replace(/<img[^>]*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
    out.push({ heading, text, img });
  }
  return out;
}

async function main() {
  const batchId = get("--batch");
  const articleIds = args.flatMap((a, i) => (a === "--article" ? [args[i + 1]] : []));
  if (!batchId && !articleIds.length) throw new Error("--batch <id> или --article <id> …");
  const items = batchId
    ? await prisma.copyBatchItem.findMany({ where: { batchId, status: "done", articleId: { not: null } }, orderBy: { position: "asc" } })
    : articleIds.map((id) => ({ articleId: id }));
  let checked = 0, cost = 0;
  const bad: string[] = [];
  const perArticle: Array<{ keyword: string; yes: number; partial: number; no: number; skipped: number }> = [];
  for (const it of items) {
    const a = await prisma.article.findUnique({ where: { id: it.articleId! }, select: { id: true, keyword: true, html: true, teamId: true, createdById: true, siteId: true, photos: { where: { excluded: false }, orderBy: { position: "asc" } } } });
    if (!a?.html || !a.createdById) continue;
    const secs = sections(a.html);
    const row = { keyword: a.keyword, yes: 0, partial: 0, no: 0, skipped: 0 };
    perArticle.push(row);
    const byFile = new Map(a.photos.map((p) => [p.fileName?.replace(/\.jpg$/i, "") ?? "", p]));
    for (let i = 0; i < secs.length; i++) {
      if (checked >= LIMIT) break;
      const s = secs[i];
      // Фото секции: по имени файла в src (publish сохраняет имя с хэшем) или по порядку.
      const fname = s.img ? decodeURIComponent(s.img.split("/").pop() ?? "") : "";
      const hash = /-([0-9a-f]{8})(?:-\d+)?\.(?:jpg|jpeg|webp|png)$/i.exec(fname)?.[1];
      const p = (hash && a.photos.find((x) => x.sha256?.startsWith(hash))) ?? [...byFile.values()].find((x) => fname && fname.includes(x.fileName || "∅")) ?? a.photos[i];
      if (!p || !s.text) { row.skipped++; continue; }
      let part;
      if (p.path && (await exists(p.path))) part = imagePart(await readFile(absPath(p.path)), "image/jpeg", "low");
      else if (p.wpUrl || p.publicUrl) part = { type: "image_url" as const, image_url: { url: p.wpUrl || p.publicUrl, detail: "low" as const } };
      else { row.skipped++; continue; }
      try {
        const r = await aiChat({ userId: a.createdById, teamId: a.teamId, articleId: a.id, siteId: a.siteId }, {
          slot: SLOTS.vision, model: MODEL, json: true, temperature: 0, maxTokens: 300,
          system: `You audit an article section against its photo. Judge ONLY whether the section's heading and text describe what is visible in THIS photo (colors, shapes, items, length, style). Ignore marketing tone. Return JSON {"match":"yes"|"partial"|"no","issue":"<=25 words, what contradicts the photo, or empty"}.`,
          user: [{ type: "text", text: `Article: ${a.keyword}\nHeading: ${s.heading}\nText: ${s.text}` }, part],
        });
        cost += r.costUsd ?? 0;
        checked++;
        const j = (r.json ?? {}) as { match?: string; issue?: string };
        const m = j.match === "yes" ? "yes" : j.match === "no" ? "no" : "partial";
        row[m]++;
        if (m !== "yes") bad.push(`${m.toUpperCase()} · ${a.keyword} · секция ${i + 1} «${s.heading}»: ${j.issue ?? ""} ${p.wpUrl ?? p.publicUrl ?? ""}`);
      } catch (e) { row.skipped++; bad.push(`ERR · ${a.keyword} · секция ${i + 1}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  console.table(perArticle);
  console.log(`проверено ${checked} секций, расход $${cost.toFixed(3)}`);
  console.log(bad.join("\n") || "расхождений нет");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
