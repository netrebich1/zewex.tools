/**
 * Отладка прохода против повторов (мешап): тот же запрос, что в worker/articles/stages/copyDedupe.ts, но без записи в базу —
 * печатает длину ответа, число секций в JSON и первые строки. Запуск: npx tsx scripts/copy/dedupe-debug.ts <articleId> [model]
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { findRepeats } from "@/lib/copy/repeats";

async function main() {
  const [id, model = "openrouter:deepseek/deepseek-v4-flash"] = process.argv.slice(2);
  const a = await prisma.article.findUniqueOrThrow({ where: { id } });
  const secs = await prisma.artSection.findMany({ where: { articleId: id, position: { gte: 1, lt: 900 }, photoId: { not: null } }, orderBy: { position: "asc" } });
  const list = secs.map((s, i) => ({ n: i + 1, h2: s.heading, html: s.html }));
  const focusKeyword = a.focusKeyword || a.keyword || "";
  const rep = findRepeats(secs.map((s) => s.html || ""), focusKeyword.toLowerCase().split(/\s+/));
  console.log("повторы:", rep.phrases.map((p) => `${p.phrase} [${p.sections.join(",")}]`).join(" | "));
  console.log("зачины:", rep.openers.map((p) => `${p.phrase} [${p.sections.join(",")}]`).join(" | "));
  const keepIn = (secs2: number[]) => secs2.slice(0, 2);
  const tasks = [
    ...rep.phrases.map((p) => `"${p.phrase}" appears in sections ${p.sections.join(", ")}: keep it only in ${keepIn(p.sections).join(" and ")}, reword or cut it in the others`),
    ...rep.openers.map((p) => `sentences starting with "${p.phrase}" appear in sections ${p.sections.join(", ")}: keep that opener only in ${keepIn(p.sections).join(" and ")}, start the sentence differently in the others`),
  ];
  const system = `You edit a photo-led article about "${focusKeyword}" that was written section by section, so the sections repeat each other. You see the whole article at once. Your only job is variety across sections:
- The "tasks" list names the exact repeated phrases and sentence openers and the sections where they occur. Do every task: in the sections not listed as "keep", reword that sentence with different wording, or cut the sentence if it adds nothing new to that section.
- Every rewording must be different from all the others: never use the same replacement phrase or the same sentence opener in two sections. Vary the sentence shape (statement, instruction, a short aside), not only the words. For a salon or tech line, vary both the lead-in ("Bring this to your tech", "The words for the appointment", "Show your tech this photo and name", a plain description with no lead-in) and the way the design is named.
- Never add facts, never change a color, length, shape, technique, product, number or timing. Never change the meaning. Never change or move the heading. Keep the number of <p> paragraphs in each section exactly the same and keep every HTML tag as is. Keep US spelling, plain language, no praise words (no polished, chic, effortless, timeless, elevate, stunning, versatile, sophisticated).
- Do not rewrite sentences that are not part of a task. Return only the sections you changed, with their full html.
Return JSON only: {"sections":[{"n":1,"html":"<p>...</p>"}]}.`;
  console.log(`секций ${secs.length}, вход ≈ ${JSON.stringify(list).length} символов, модель ${model}`);
  const r = await aiChat({ userId: a.createdById ?? "", teamId: a.teamId, articleId: id, siteId: a.siteId }, { slot: SLOTS.textFast, model, system, user: JSON.stringify({ topic: focusKeyword, tasks, sections: list }), json: true, temperature: 0.5, maxTokens: 16_000, timeoutMs: 180_000 });
  console.log(`ответ: ${r.text.length} символов, json=${r.json ? typeof r.json : "null"}, in=${r.inputTokens} out=${r.outputTokens} $${r.costUsd}`);
  const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { sections?: unknown[] } | null;
  const rows = Array.isArray(out?.sections) ? out!.sections : [];
  console.log(`секций в ответе: ${rows.length}`);
  let same = 0;
  for (const row of rows as Array<{ n: number; html: string }>) {
    const src = secs[Number(row.n) - 1];
    if (src && String(row.html).trim() === (src.html || "").trim()) same++;
  }
  console.log(`из них без изменений: ${same}`);
  for (const row of (rows as Array<{ n: number; html: string }>).slice(0, 40)) {
    const src = secs[Number(row.n) - 1];
    if (src && String(row.html).trim() !== (src.html || "").trim()) console.log(`
--- ${row.n} было:
${src.html}
+++ стало:
${row.html}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
