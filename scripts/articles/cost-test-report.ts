/**
 * Отчёт по тестовому запуску статей (cost-fixes-b, 2026-10-16): расход по этапам, воронка фото, поиски, сравнение
 * с базой волны 3 (zorvianix, норма 30) и контактные листы итоговых фото с описаниями — глазами проверить,
 * совпадает ли текст описания с кадром.
 *
 *   npx tsx scripts/articles/cost-test-report.ts <runId> --out=<папка> [--no-sheets]
 *
 * Запускать на сервере в копии (/root/zewex-check), файлы фото читаются из хранилища (PINS_STORAGE_DIR или
 * /var/www/zewex_tools_usr/data/storage); база только читается. Пишет <out>/report.md, <out>/report.json,
 * <out>/sheets/<ключ>.jpg (sharp) и <out>/sheets.json (тот же список для локального PIL-скрипта).
 *
 * Как считается этап вызова (как costs.ts): vision в окне ArtAiModerationResult (createdAt…updatedAt) → ai_moderation;
 * иначе окно ArtStageLog (startedAt…finishedAt, незакрытое — до следующего этапа или час) → этап; иначе «вне этапов».
 */
import { setDefaultResultOrder } from "dns";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { PROJECT_SLUG, type ArticleRecipeSnapshot } from "@/lib/articles/types";
import { absPath } from "@/lib/articles/storage";
import { sanitizeFacts } from "@/lib/articles/photo/factSanitize";

setDefaultResultOrder("ipv4first");
const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const has = (k: string) => process.argv.includes(`--${k}`);

/** База для сравнения: волна 3 zorvianix.com, 300 статей, норма 30 фото (cost-notes-zorvianix.md). */
const BASELINE = {
  total: 0.0752,
  stages: { rate: 0.0213, ai_moderation: 0.0185, search: 0.0133, sections: 0.0076, rank: 0.0048, section_plan: 0.0039, plan: 0.0036 } as Record<string, number>,
  calls: { rate: 15.8, rank: 13.1, search: 4.7 } as Record<string, number>,
  funnel: { found: 246, filter: 133, rated: 110, keep: 42, selected: 27, reserveUnused: 15, modMinus: 7.7, modPlus: 3.8, final: 25.4 },
};

const STAGE_ORDER = ["search", "filter", "rank", "rate", "select", "ai_moderation", "plan", "section_plan", "blueprint", "intro_outro", "sections", "meta", "assemble", "publish", "other"];

type Funnel = { found: number; filter: number; rated: number; keep: number; selected: number; reserve: number; reserveUnused: number; modMinus: number; modPlus: number; final: number; described: number };
type ArticleReport = {
  id: string; keyword: string; status: string; stage: string; photoCount: number; rateMode: string; sizeFilter: boolean;
  total: number; calls: number; byStage: Record<string, { cost: number; calls: number }>;
  searches: number; searchRequests: number; perQuery: Array<{ idx: number; found: number; passed: number }>;
  funnel: Funnel; sheet: string | null;
};

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r1 = (v: number) => Math.round(v * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function wrap(text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { out.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim();
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur.trim());
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[lines - 1] = out[lines - 1].replace(/.{0,3}$/, "…");
  return out;
}

/** Контактный лист: 4 колонки, под каждым фото номер и описание (6 строк). */
async function contactSheet(file: string, title: string, photos: Array<{ n: number; path: string | null; text: string; excluded: boolean }>): Promise<void> {
  const COLS = 4, W = 300, H = 400, TXT = 118, PAD = 10, HEAD = 40;
  const rows = Math.ceil(photos.length / COLS);
  const width = COLS * (W + PAD) + PAD;
  const height = HEAD + rows * (H + TXT + PAD) + PAD;
  const layers: sharp.OverlayOptions[] = [];
  const svgParts: string[] = [`<text x="${PAD}" y="28" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="bold" fill="#111">${esc(title)}</text>`];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const x = PAD + (i % COLS) * (W + PAD);
    const y = HEAD + Math.floor(i / COLS) * (H + TXT + PAD);
    if (p.path && existsSync(p.path)) {
      try {
        const buf = await sharp(p.path).rotate().resize({ width: W, height: H, fit: "contain", background: "#f2f2f2" }).jpeg({ quality: 80 }).toBuffer();
        layers.push({ input: buf, left: x, top: y });
      } catch { /* нет файла — серая плашка */ }
    }
    svgParts.push(`<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="none" stroke="${p.excluded ? "#d33" : "#999"}" stroke-width="${p.excluded ? 4 : 1}"/>`);
    svgParts.push(`<rect x="${x + 4}" y="${y + 4}" width="34" height="26" rx="4" fill="#ff7a00"/><text x="${x + 21}" y="${y + 23}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="17" font-weight="bold" fill="#fff">${p.n}</text>`);
    const lines = wrap(p.text || "(нет описания)", 46, 6);
    lines.forEach((ln, k) => svgParts.push(`<text x="${x}" y="${y + H + 16 + k * 16}" font-family="DejaVu Sans, Arial, sans-serif" font-size="12" fill="#222">${esc(ln)}</text>`));
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgParts.join("")}</svg>`);
  await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([...layers, { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 85 })
    .toFile(file);
}

async function main() {
  const runId = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!runId) throw new Error("Укажите runId: npx tsx scripts/articles/cost-test-report.ts <runId> --out=<папка>");
  const out = flag("out") || `reports/cost-test/${runId.slice(0, 8)}`;
  await mkdir(path.join(out, "sheets"), { recursive: true });
  const run = await prisma.artRun.findUnique({ where: { id: runId }, select: { id: true, name: true, createdAt: true, site: { select: { name: true } } } });
  if (!run) throw new Error("Запуск не найден");
  const project = await prisma.project.findUnique({ where: { slug: PROJECT_SLUG }, select: { id: true } });
  const arts = await prisma.article.findMany({ where: { runId }, orderBy: { createdAt: "asc" }, select: { id: true, keyword: true, status: true, stage: true, photoCount: true, recipe: true, cursor: true, costUsd: true } });
  const reports: ArticleReport[] = [];
  const sheetsJson: Array<{ keyword: string; photos: Array<{ n: number; file: string | null; text: string; excluded: boolean }> }> = [];

  for (const a of arts) {
    const recipe = a.recipe as unknown as ArticleRecipeSnapshot;
    const uses = await prisma.usageLog.findMany({ where: { refId: a.id, ...(project ? { projectId: project.id } : {}) }, select: { createdAt: true, costUsd: true, slot: { select: { key: true } } } });
    const logs = await prisma.artStageLog.findMany({ where: { articleId: a.id }, orderBy: { startedAt: "asc" }, select: { stage: true, startedAt: true, finishedAt: true } });
    const aiRes = await prisma.artAiModerationResult.findMany({ where: { articleId: a.id }, select: { createdAt: true, updatedAt: true } });
    const win = logs.map((l, i) => ({ from: l.startedAt.getTime(), to: l.finishedAt ? l.finishedAt.getTime() : Math.min(logs[i + 1]?.startedAt.getTime() ?? Infinity, l.startedAt.getTime() + 3_600_000), stage: l.stage }));
    const aiWin = aiRes.map((r) => ({ from: r.createdAt.getTime(), to: r.updatedAt.getTime() }));
    const byStage: Record<string, { cost: number; calls: number }> = {};
    let total = 0, searchRequests = 0;
    for (const u of uses) {
      const t = u.createdAt.getTime();
      const key = u.slot?.key ?? "";
      const inAi = aiWin.some((w) => t >= w.from && t <= w.to);
      let stage = key === "vision" && inAi ? "ai_moderation" : win.find((w) => t >= w.from && t <= w.to)?.stage ?? (inAi ? "ai_moderation" : "other");
      if (key === "photo_dfs" || key === "photo_serp") { searchRequests++; if (stage === "other") stage = "search"; }
      const s = byStage[stage] ?? (byStage[stage] = { cost: 0, calls: 0 });
      s.cost += u.costUsd ?? 0; s.calls++; total += u.costUsd ?? 0;
    }

    // Воронка по кандидатам и фото
    const cands = await prisma.artPhotoCandidate.findMany({ where: { articleId: a.id }, select: { status: true, rejectStage: true, aiScore: true, queryIndex: true, aiBreakdown: true } });
    const found = cands.length;
    const filter = cands.filter((c) => !(c.status === "rejected" && c.rejectStage === "filter")).length;
    const rated = cands.filter((c) => c.aiScore !== null || c.rejectStage === "rate").length;
    const keep = cands.filter((c) => ["keep", "selected", "reserve"].includes(c.status)).length;
    const selected = cands.filter((c) => c.status === "selected").length;
    const reserve = cands.filter((c) => c.status === "reserve").length;
    const photos = await prisma.artPhoto.findMany({ where: { articleId: a.id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, position: true, path: true, thumbPath: true, description: true, facts: true, excluded: true, candidateId: true } });
    const active = photos.filter((p) => !p.excluded);
    // Решения модерации: применённые результаты ИИ (removed/added) + ручные события (byAi=false); исключённые фото
    // после публикации из ArtPhoto удаляются, поэтому считать по `excluded` нельзя.
    const applied = aiRes.length ? await prisma.artAiModerationResult.findMany({ where: { articleId: a.id, status: "applied" }, select: { removed: true, added: true } }) : [];
    const human = await prisma.artModerationEvent.groupBy({ by: ["action"], where: { articleId: a.id, byAi: false, action: { in: ["exclude", "add"] } }, _count: true });
    const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    const modMinus = applied.reduce((s, r) => s + len(r.removed), 0) + (human.find((h) => h.action === "exclude")?._count ?? 0);
    const modPlus = applied.reduce((s, r) => s + len(r.added), 0) + (human.find((h) => h.action === "add")?._count ?? 0);
    const described = active.filter((p) => String(p.description || "").trim().split(/\s+/).length >= 8).length;
    const funnel: Funnel = { found, filter, rated, keep, selected, reserve, reserveUnused: reserve - modPlus, modMinus, modPlus, final: active.length, described };
    const perQueryMap = new Map<number, { found: number; passed: number }>();
    for (const c of cands) {
      let q = perQueryMap.get(c.queryIndex);
      if (!q) { q = { found: 0, passed: 0 }; perQueryMap.set(c.queryIndex, q); }
      q.found++;
      if (!(c.status === "rejected" && c.rejectStage === "filter")) q.passed++;
    }
    const perQuery = [...perQueryMap.entries()].sort((x, y) => x[0] - y[0]).map(([idx, v]) => ({ idx, ...v }));
    const searchLog = ((a.cursor as { searchLog?: Array<{ engine: string }> } | null)?.searchLog ?? []);
    const searches = searchLog.filter((e) => !/кэш/.test(e.engine)).length;

    // Контактный лист
    let sheet: string | null = null;
    const sheetPhotos = photos.map((p) => {
      const rel = p.thumbPath || p.path;
      const file = rel ? absPath(rel) : null;
      const facts = sanitizeFacts(p.facts);
      const text = String(p.description || "").trim() || (facts ? Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("; ") : "");
      return { n: p.position, path: file && existsSync(file) ? file : null, text, excluded: p.excluded };
    });
    if (!has("no-sheets") && photos.length) {
      const safe = a.keyword.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
      sheet = path.join(out, "sheets", `${safe}.jpg`);
      await contactSheet(sheet, `${a.keyword} — ${a.status} (${active.length} фото, описаны ${described}; красная рамка = исключено модерацией)`, sheetPhotos);
    }
    sheetsJson.push({ keyword: a.keyword, photos: sheetPhotos.map((p) => ({ n: p.n, file: p.path, text: p.text, excluded: p.excluded })) });

    reports.push({
      id: a.id, keyword: a.keyword, status: a.status, stage: a.stage, photoCount: a.photoCount,
      rateMode: recipe.photoSearch?.rateMode ?? "full", sizeFilter: recipe.photoSearch?.searchSizeFilter === true,
      total, calls: uses.length, byStage, searches, searchRequests, perQuery, funnel, sheet,
    });
  }

  // ── Сводка ──
  const done = reports.filter((r) => ["COMPLETED", "REVIEW_PENDING", "PUBLISHING"].includes(r.status) || r.stage === "done" || r.stage === "publish");
  const basis = done.length ? done : reports;
  const stages = STAGE_ORDER.filter((s) => reports.some((r) => r.byStage[s]));
  const avgStage = (s: string) => avg(basis.map((r) => r.byStage[s]?.cost ?? 0));
  const avgCalls = (s: string) => avg(basis.map((r) => r.byStage[s]?.calls ?? 0));
  const fk = Object.keys(BASELINE.funnel) as Array<keyof typeof BASELINE.funnel>;
  const md: string[] = [];
  md.push(`# Отчёт по тестовому запуску «${run.name}» (${run.site.name})`, "");
  md.push(`Запуск ${run.id}, создан ${run.createdAt.toISOString()}. Статей ${reports.length}, из них дошли до текста/публикации ${done.length}; средние — по ${basis.length} статьям${done.length ? " (дошедшим)" : ""}.`);
  md.push(`Флаги снимка: rateMode = ${[...new Set(reports.map((r) => r.rateMode))].join("/")}, searchSizeFilter = ${[...new Set(reports.map((r) => String(r.sizeFilter)))].join("/")}. Норма фото: ${[...new Set(reports.map((r) => r.photoCount))].join("/")}.`, "");
  md.push(`## Расход на статью (среднее) против базы волны 3 (zorvianix, норма 30, $${BASELINE.total})`, "");
  md.push(`| Этап | Тест $ | Вызовов | База $ | База вызовов | Δ |`, `|---|---|---|---|---|---|`);
  const totalAvg = avg(basis.map((r) => r.total));
  for (const s of stages) {
    const b = BASELINE.stages[s];
    const bc = BASELINE.calls[s];
    md.push(`| ${s} | ${r4(avgStage(s))} | ${r1(avgCalls(s))} | ${b != null ? b : "—"} | ${bc != null ? bc : "—"} | ${b != null ? (avgStage(s) - b >= 0 ? "+" : "") + r4(avgStage(s) - b) : "—"} |`);
  }
  md.push(`| **итого** | **${r4(totalAvg)}** | ${r1(avg(basis.map((r) => r.calls)))} | ${BASELINE.total} | | ${(totalAvg - BASELINE.total >= 0 ? "+" : "") + r4(totalAvg - BASELINE.total)} (${Math.round(((totalAvg - BASELINE.total) / BASELINE.total) * 100)}%) |`, "");
  md.push(`## Воронка фото на статью (среднее)`, "");
  md.push(`| | ${fk.join(" | ")} | described |`, `|---|${fk.map(() => "---").join("|")}|---|`);
  md.push(`| тест | ${fk.map((k) => r1(avg(basis.map((r) => r.funnel[k])))).join(" | ")} | ${r1(avg(basis.map((r) => r.funnel.described)))} |`);
  md.push(`| база | ${fk.map((k) => BASELINE.funnel[k]).join(" | ")} | — |`, "");
  md.push(`Поисков на статью: ${r1(avg(basis.map((r) => r.searches)))} (запросов к провайдерам ${r1(avg(basis.map((r) => r.searchRequests)))}; база ${BASELINE.calls.search}). Оценено фото: ${r1(avg(basis.map((r) => r.funnel.rated)))} (база ${BASELINE.funnel.rated}).`, "");
  const maxIdx = Math.max(0, ...reports.flatMap((r) => r.perQuery.map((q) => q.idx)));
  md.push(`## Кандидаты по номеру запроса (сумма по статьям: найдено / прошло фильтр)`, "");
  md.push(`| № запроса | найдено | прошло фильтр | доля |`, `|---|---|---|---|`);
  for (let i = 0; i <= Math.min(maxIdx, 12); i++) {
    const f = reports.reduce((s, r) => s + (r.perQuery.find((q) => q.idx === i)?.found ?? 0), 0);
    const p = reports.reduce((s, r) => s + (r.perQuery.find((q) => q.idx === i)?.passed ?? 0), 0);
    if (f) md.push(`| ${i === 99 ? "гео" : i} | ${f} | ${p} | ${Math.round((100 * p) / f)}% |`);
  }
  md.push("", `## По статьям`, "");
  md.push(`| Ключ | Статус | $ | search | rate | ai_mod | plan | sections | поисков | найдено→фильтр→оценено→keep→выбрано | мод −/+ | итог | описаны | лист |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of reports) {
    const c = (s: string) => r4(r.byStage[s]?.cost ?? 0);
    const f = r.funnel;
    md.push(`| ${r.keyword} | ${r.status} | ${r4(r.total)} | ${c("search")} | ${c("rate")} | ${c("ai_moderation")} | ${c("plan")} | ${c("sections")} | ${r.searches} | ${f.found}→${f.filter}→${f.rated}→${f.keep}→${f.selected} | −${f.modMinus}/+${f.modPlus} | ${f.final} | ${f.described} | ${r.sheet ? path.relative(out, r.sheet) : "—"} |`);
  }
  md.push("", `Контактные листы: оранжевый номер = позиция фото в статье, под кадром — описание из ArtPhoto.description (или факты, если описания нет); красная рамка — фото исключено модерацией.`);
  await writeFile(path.join(out, "report.md"), md.join("\n"), "utf8");
  await writeFile(path.join(out, "report.json"), JSON.stringify({ run, baseline: BASELINE, articles: reports }, null, 2), "utf8");
  await writeFile(path.join(out, "sheets.json"), JSON.stringify(sheetsJson, null, 2), "utf8");
  console.log(md.join("\n"));
  console.log(`\nФайлы: ${path.resolve(out)}/report.md, report.json, sheets/*.jpg, sheets.json`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
