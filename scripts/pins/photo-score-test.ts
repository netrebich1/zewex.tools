/**
 * Тест выбора фото для Canvas-пинов: A — как сейчас (фото подряд из запаса, модель только кадрирует),
 * B — модель оценивает до K кандидатов статьи (рамка + оценка качества одним вызовом), на пин идут лучшие.
 *   npx tsx scripts/pins/photo-score-test.ts <outDir> <runId> [K=10]
 * Ничего не пишет в базу пинов; расход ИИ пишется в журнал с refId "test-photo-score".
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import { installNodeCanvasHost } from "@/lib/pins/canvas/host.node";
import { guessAccent, renderPin, type AccentType } from "@/lib/pins/canvas";
import { toRecipe } from "@/lib/pins/canvas/styleSpec";
import { scriptForLanguage } from "@/lib/pins/canvas/fonts";
import { cachedPhoto } from "@/lib/pins/canvas/photos";
import type { SubjectBox } from "@/lib/pins/canvas/subject";
import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { SLOT_TEXT_FAST, mergeRecipe } from "@/lib/pins/types";
import { toCleanJpeg } from "@/lib/pins/images";
import { hash32 } from "@/lib/pins/plan/seed";
import type { StyleSpec } from "@/lib/pins/canvas/styleSpec";

setDefaultResultOrder("ipv4first");

const HINT: Record<string, string> = {
  auto: "the main subject of the photo",
  hair: "the head of the person including all of the hair",
  nails: "the hands with the manicured nails",
  makeup: "the whole face from the top of the hair to the chin",
  outfit: "the person from the top of the head to the shoes, including the whole outfit",
  decor: "the decorated objects or the decorated area",
  food: "the dish or the food and its plate",
  interior: "the main furniture and the decorated part of the room",
};
const PEOPLE = new Set(["hair", "makeup", "outfit", "auto"]);
const c01 = (v: number) => Math.max(0, Math.min(1, v));

function boxFrom(b: unknown, face: unknown, people: boolean): SubjectBox | null {
  const a = Array.isArray(b) ? b.map(Number) : [];
  if (a.length < 4 || a.some((n) => !Number.isFinite(n))) return null;
  const k = a.some((n) => n > 1) ? 1000 : 1;
  const [y0, x0, y1, x1] = a.map((n) => c01(n / k));
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return null;
  if (x0 <= 0.01 && y0 <= 0.01 && x1 >= 0.99 && y1 >= 0.99) return null;
  let fx = (x0 + x1) / 2, fy = (y0 + y1) / 2;
  const f = Array.isArray(face) ? face.map(Number) : [];
  if (people && f.length >= 4 && f.every(Number.isFinite)) { const kf = f.some((n) => n > 1) ? 1000 : 1; fx = (f[1] + f[3]) / 2 / kf; fy = (f[0] + f[2]) / 2 / kf; }
  return { x0, y0, x1, y1, fx: Math.max(x0, Math.min(x1, fx)), fy: Math.max(y0, Math.min(y1, fy)) };
}

async function small(photo: Buffer) {
  const s = await toCleanJpeg(photo, { maxSide: 768, quality: 80 });
  return `data:image/jpeg;base64,${s.data.toString("base64")}`;
}

/** A: тот же запрос, что в subject.ts (без кэша — чтобы измерить цену). */
async function detectA(ai: AiCtx, photo: Buffer, accent: string) {
  const people = PEOPLE.has(accent);
  const res = await aiChat(ai, SLOT_TEXT_FAST, {
    user: [
      { type: "text", text: `Detect ${HINT[accent] ?? HINT.auto} and label it "subject".${people ? ' If a person is visible, also detect the face and label it "face".' : ""} Output a json list where each entry contains the 2D bounding box in "box_2d" as [ymin, xmin, ymax, xmax] normalized to 0-1000 and a text label in "label". Do not output masks.` },
      { type: "image_url", image_url: { url: await small(photo) } },
    ],
    temperature: 0, maxTokens: 200, timeoutMs: 40_000,
  });
  const m = res.text.replace(/```[a-z]*\n?/gi, "").match(/\[[\s\S]*\]/);
  let arr: Array<{ box_2d?: unknown; label?: string }> = [];
  try { arr = m ? JSON.parse(m[0]) : []; } catch { /* */ }
  const subj = arr.find((d) => String(d.label).includes("subject")) ?? arr[0];
  const face = arr.find((d) => String(d.label).includes("face"));
  return { box: subj ? boxFrom(subj.box_2d, face?.box_2d, people) : null, cost: res.costUsd ?? 0 };
}

/** B: рамка + оценка качества для Pinterest одним вызовом (без json-режима — в нём Gemini портит рамку). */
async function detectB(ai: AiCtx, photo: Buffer, accent: string, topic: string) {
  const people = PEOPLE.has(accent);
  const res = await aiChat(ai, SLOT_TEXT_FAST, {
    user: [
      { type: "text", text: `You pick photos for a Pinterest collage about "${topic}".
1) Detect ${HINT[accent] ?? HINT.auto} and give its 2D bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000.${people ? " If a person is visible, also give the face box." : ""}
2) Rate the photo 0-10 as a Pinterest collage tile for this topic: sharp, well lit, the subject is clear, fully visible and on-topic, attractive. Give low scores to: blurry or dark photos, screenshots, photos with big text/watermarks/logos, collages or grids, product packshots on white with no subject, photos where the subject is cut off, off-topic images.
Output ONLY this json object: {"subject":[ymin,xmin,ymax,xmax],"face":[ymin,xmin,ymax,xmax] or null,"score":0-10,"flags":["blurry"|"text"|"collage"|"cut"|"offtopic"|"dark"]}` },
      { type: "image_url", image_url: { url: await small(photo) } },
    ],
    temperature: 0, maxTokens: 220, timeoutMs: 40_000,
  });
  const m = res.text.replace(/```[a-z]*\n?/gi, "").match(/\{[\s\S]*\}/);
  let o: { subject?: unknown; face?: unknown; score?: unknown; flags?: unknown } = {};
  try { o = m ? JSON.parse(m[0]) : {}; } catch { /* */ }
  const flags = Array.isArray(o.flags) ? o.flags.map(String) : [];
  return { box: boxFrom(o.subject, o.face, people), score: Number(o.score) || 0, flags, cost: res.costUsd ?? 0 };
}

/** K кандидатов, равномерно по статье (не подряд). */
function spread<T>(list: T[], k: number): Array<{ v: T; i: number }> {
  if (list.length <= k) return list.map((v, i) => ({ v, i }));
  return Array.from({ length: k }, (_, j) => { const i = Math.round((j * (list.length - 1)) / (k - 1)); return { v: list[i], i }; });
}

async function main() {
  const [outDir = "/tmp/photo-score", runId, kArg = "10"] = process.argv.slice(2);
  if (!runId) throw new Error("укажите runId");
  const K = Math.max(3, Number(kArg) || 10);
  installNodeCanvasHost(process.env.PINS_FONTS_DIR || "/var/www/zewex_tools_usr/data/storage/pins/fonts");
  await mkdir(outDir, { recursive: true });
  const run = await prisma.pinRun.findUniqueOrThrow({ where: { id: runId }, include: { site: true } });
  const recipe = mergeRecipe(run.settings);
  const seedBase = (run.settings as { seed?: number }).seed ?? 0;
  const ai: AiCtx = { userId: run.createdById ?? "", teamId: run.teamId, runId: "test-photo-score", siteId: run.siteId ?? undefined };

  // 10 пинов из разных статей: 2×1 фото, 3×2, 4×4, 1×6; у статьи в запасе ≥ 12 фото.
  const want: Record<number, number> = { 1: 2, 2: 3, 4: 4, 6: 1 };
  const items = await prisma.pinRunItem.findMany({ where: { runId, engine: "CANVAS", status: "READY" }, include: { page: true }, orderBy: { id: "asc" } });
  const pools = new Map<string, string[]>();
  const poolOf = async (pageId: string) => {
    if (!pools.has(pageId)) {
      const rows = await prisma.pinRunItem.findMany({ where: { runId, pageId, engine: "PHOTO", status: { in: ["POOL", "READY"] } }, orderBy: { sortOrder: "asc" }, select: { sourceImageUrl: true } });
      pools.set(pageId, [...new Set(rows.map((r) => r.sourceImageUrl).filter(Boolean))]);
    }
    return pools.get(pageId)!;
  };
  const picked: typeof items = [];
  const usedPages = new Set<string>();
  for (const it of items) {
    const n = Number((it.styleParams as { photoCount?: number })?.photoCount ?? 0);
    if (!want[n] || usedPages.has(it.pageId) || (hash32(it.id) % 7) !== 0) continue;
    if ((await poolOf(it.pageId)).length < 12) continue;
    picked.push(it); usedPages.add(it.pageId); want[n]--;
    if (Object.values(want).every((v) => v <= 0)) break;
  }
  console.log(`pins: ${picked.length}`);

  let costA = 0, callsA = 0, costB = 0, callsB = 0;
  const report: string[] = [];
  for (const [idx, it] of picked.entries()) {
    const params = (it.styleParams ?? {}) as { photos?: string[]; hook?: { title?: string; kicker?: string; cta?: string }; ideaCount?: number; tags?: { cta?: boolean; siteName?: boolean } };
    const style = await prisma.pinCanvasStyle.findUnique({ where: { id: it.styleId ?? "" } });
    if (!style) continue;
    const spec = style.data as unknown as StyleSpec;
    const accent = guessAccent(it.page.niche || run.site?.niche || "", it.page.keyword, it.page.topic, it.page.pageTitle) as AccentType;
    const seed = hash32(`${seedBase}|${it.page.id}|${it.styleId}|${it.sortOrder - 2000}`);
    const hook = params.hook ?? { title: it.page.keyword };
    const texts = { title: hook.title ?? it.page.keyword, kicker: hook.kicker, cta: params.tags?.cta ? hook.cta : undefined, domain: params.tags?.siteName ? (recipe.text.siteName || "lyntrico.com") : undefined, number: params.ideaCount && params.ideaCount >= 3 ? String(params.ideaCount) : undefined };
    const n = (params.photos ?? []).length;
    const tag = String(idx + 1).padStart(2, "0");

    // A — как сейчас
    const aUrls: string[] = [], aPhotos: Buffer[] = [], aBoxes: Array<SubjectBox | null> = [];
    for (const u of params.photos ?? []) {
      try { const p = await cachedPhoto(u); const d = await detectA(ai, p, accent); aUrls.push(u); aPhotos.push(p); aBoxes.push(d.box); costA += d.cost; callsA++; } catch { /* битое */ }
    }
    const rA = await renderPin({ recipe: { ...toRecipe(spec, seed, aPhotos.length, { script: scriptForLanguage(recipe.text.language) }), accent }, photos: aPhotos, subjects: aBoxes, texts, seed });
    await writeFile(join(outDir, `${tag}_A.jpg`), rA.jpeg);

    // B — оценка K кандидатов статьи, лучшие на пин
    const pool = await poolOf(it.pageId);
    const cands: Array<{ url: string; i: number; photo: Buffer; box: SubjectBox | null; score: number; flags: string[] }> = [];
    for (const { v: u, i } of spread(pool, K)) {
      try { const p = await cachedPhoto(u); const d = await detectB(ai, p, accent, it.page.keyword); costB += d.cost; callsB++; cands.push({ url: u, i, photo: p, box: d.box, score: d.score, flags: d.flags }); } catch { /* битое */ }
    }
    const bad = new Set(["text", "collage", "blurry", "offtopic"]);
    const ranked = [...cands].sort((a, b) => (b.score - (b.flags.some((f) => bad.has(f)) ? 3 : 0)) - (a.score - (a.flags.some((f) => bad.has(f)) ? 3 : 0)));
    const chosen: typeof cands = [];
    for (const c of ranked) { if (chosen.length >= n) break; if (chosen.some((x) => Math.abs(x.i - c.i) <= 1) && ranked.length - chosen.length > n) continue; chosen.push(c); }
    for (const c of ranked) { if (chosen.length >= n) break; if (!chosen.includes(c)) chosen.push(c); }
    const rB = await renderPin({ recipe: { ...toRecipe(spec, seed, chosen.length, { script: scriptForLanguage(recipe.text.language) }), accent }, photos: chosen.map((c) => c.photo), subjects: chosen.map((c) => c.box), texts, seed });
    await writeFile(join(outDir, `${tag}_B.jpg`), rB.jpeg);

    const aScores = aUrls.map((u) => cands.find((c) => c.url === u)?.score);
    report.push(`${tag} фото ${n} | статья: ${it.page.keyword} | запас ${pool.length} | оценки кандидатов: ${cands.map((c) => `${c.score}${c.flags.length ? `(${c.flags.join(",")})` : ""}`).join(" ")} | B взял: ${chosen.map((c) => c.score).join(",")} | A (если оценены): ${aScores.map((s) => s ?? "?").join(",")}`);
    console.log(report[report.length - 1]);
  }
  const lines = [
    `A: вызовов ${callsA}, $${costA.toFixed(5)}, на вызов $${(costA / Math.max(1, callsA)).toFixed(6)}`,
    `B: вызовов ${callsB}, $${costB.toFixed(5)}, на вызов $${(costB / Math.max(1, callsB)).toFixed(6)}`,
  ];
  console.log(lines.join("\n"));
  await writeFile(join(outDir, "report.txt"), [...report, ...lines].join("\n"));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
