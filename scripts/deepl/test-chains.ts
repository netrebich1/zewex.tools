// ТЕСТ связок языков: одна статья × N цепочек переводов DeepL (без редактуры). Результат — тестовый прогон в системе.
// Запуск: npx tsx scripts/deepl/test-chains.ts <blog|ideas> [номера через запятую]
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { protectHtml, restoreHtml, fixTranslationArtifacts } from "@/lib/deepl/html";
import { runTranslate, mapLimit } from "@/lib/deepl/deepl";
import { DEFAULT_SETTINGS } from "@/lib/deepl/types";

const CHAINS: string[][] = [
  ["EN"], ["DE"], ["FR"], ["ES"], ["IT"], ["PL"], ["CS"], ["NL"], ["TR"], ["JA"],
  ["EN", "DE"], ["EN", "FR"], ["EN", "ES"], ["EN", "PL"], ["EN", "CS"], ["EN", "NL"], ["EN", "JA"], ["EN", "TR"],
  ["DE", "EN"], ["DE", "PL"], ["FR", "EN"], ["FR", "PL"], ["PL", "EN"], ["PL", "DE"], ["ES", "PL"], ["IT", "PL"], ["JA", "EN"], ["JA", "PL"],
  ["EN", "DE", "PL"], ["EN", "JA", "PL"],
];
const ARTICLES = {
  blog: { jobId: "c4a72cae-2441-4b2c-ac37-f680ffdfcf37", position: 0, kind: "блог" },
  ideas: { jobId: "aa830ba7-d399-4306-80f1-641359f72d15", position: 2, kind: "подборка" },
} as const;
const tgt = (l: string) => (l === "EN" ? "EN-GB" : l === "PT" ? "PT-PT" : l);

(async () => {
  const which = process.argv[2] as keyof typeof ARTICLES;
  const only = process.argv[3] ? new Set(process.argv[3].split(",").map(Number)) : null;
  const a = process.env.SRC_JOB ? { jobId: process.env.SRC_JOB, position: Number(process.env.SRC_POS || 0), kind: "подборка" } : ARTICLES[which];
  if (!a) throw new Error("blog|ideas");
  const src = await prisma.deeplItem.findFirstOrThrow({ where: { jobId: a.jobId, position: a.position }, include: { job: true } });
  const sourceHtml = src.sourceHtml!;
  const name = `ТЕСТ связок · ${a.kind} · ${src.title}`.slice(0, 120);
  let job = await prisma.deeplJob.findFirst({ where: { name } });
  if (!job) job = await prisma.deeplJob.create({ data: {
    teamId: src.job.teamId, createdById: src.job.createdById, accessId: null, siteName: src.job.siteName, name, status: "DONE", total: CHAINS.length,
    settings: { ...DEFAULT_SETTINGS, headings: { ...DEFAULT_SETTINGS.headings, enabled: false }, postEdit: { ...DEFAULT_SETTINGS.postEdit, enabled: false }, seo: { ...DEFAULT_SETTINGS.seo, enabled: false }, quality: { ...DEFAULT_SETTINGS.quality, address: false, style: false, judge: false } } as unknown as Prisma.InputJsonValue,
    startedAt: new Date(), finishedAt: new Date(),
  } });
  console.log("job", job.id, name);
  const { text: prot, tokens } = protectHtml(sourceHtml);
  const todo = CHAINS.map((c, i) => ({ c, i })).filter((x) => !only || only.has(x.i + 1));
  // сначала короткие цепочки: их переводы попадут в кэш и станут началом длинных
  await mapLimit(todo, 2, async ({ c, i }) => {
    const label = `${String(i + 1).padStart(2, "0")} · UK→${c.join("→")}→UK`;
    const title = `${label} · ${src.title}`;
    if (await prisma.deeplItem.findFirst({ where: { jobId: job!.id, position: i, status: "done" } })) { console.log("skip", label); return; }
    await prisma.deeplItem.deleteMany({ where: { jobId: job!.id, position: i } });
    const hops = [...c, "UK"]; let h = prot; let from = "UK"; let chars = 0; const warnings: unknown[] = [];
    const stages: unknown[] = [{ key: "source", label: "Исходный", html: sourceHtml, chars: sourceHtml.length }];
    try {
      for (let k = 0; k < hops.length; k++) {
        const to = tgt(hops[k]!);
        const r = await runTranslate(h, to, from, true);
        h = fixTranslationArtifacts(r.html, to); chars += r.chars; warnings.push(...r.warnings.map((w) => ({ ...w, detail: `${from}→${to}: ${w.detail}` })));
        if (r.rolledBack) warnings.push({ code: "chunk_rollback_count", detail: `${from}→${to}: откатано фрагментов ${r.rolledBack}` });
        const restored = restoreHtml(h, tokens, to);
        stages.push({ key: `translate#${k}:${from}>${to}`, label: `Перевод ${k + 1} (${to})`, html: restored, chars: restored.length });
        from = hops[k]!;
      }
      const finalHtml = restoreHtml(h, tokens, "UK");
      stages.push({ key: "final", label: "Итоговый", html: finalHtml, chars: finalHtml.length });
      await prisma.deeplItem.create({ data: { jobId: job!.id, position: i, title, sourceUrl: src.sourceUrl, sourceHtml, finalHtml, stages: stages as Prisma.InputJsonValue, warnings: warnings as Prisma.InputJsonValue, status: "done", stage: "done", deeplChars: chars, startedAt: new Date(), finishedAt: new Date() } });
      console.log("ok", label, "chars", chars);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.deeplItem.create({ data: { jobId: job!.id, position: i, title, sourceHtml, stages: stages as Prisma.InputJsonValue, status: "error", stage: "error", error: msg, deeplChars: chars } });
      console.log("ERR", label, msg.slice(0, 200));
    }
  });
  console.log("done", job.id);
  process.exit(0);
})();
