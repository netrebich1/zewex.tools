/**
 * Аудит текста мешап-статей: модель-судья читает всю статью (заголовки + текст, без фото) и оценивает качество.
 *   sudo -u zewex_tools_usr -H npx tsx scripts/copy/audit-text.ts --batch <id> | --article <id> … [--model openrouter:google/gemini-2.5-flash]
 * Оценки 1–10: specificity (конкретика), repetition (повторы: 10 = нет), fluff (маркетинговая вода: 10 = нет),
 * headings (качество и разнообразие H2), flow (читается как статья, а не как 25 карточек), accuracy_risk (10 = текст не
 * утверждает ничего, что нельзя знать по фото). Плюс найденные запрещённые слова, одинаковые зачины секций, список проблем.
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";

const args = process.argv.slice(2);
const get = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MODEL = get("--model", "openrouter:google/gemini-2.5-flash");
const BANNED = ["effortless", "chic", "elevate", "stunning", "timeless", "seamless", "game-changer", "must-have", "holy grail", "show-stopping", "whether you", "picture this", "here's the thing", "pro tip", "obsessed", "vibe", "curated", "perfect for", "polished", "sophisticated", "versatile", "reads as", "the honest downside", "catches the light", "pop of color", "i keep seeing", "i'm booking", "my go-to"];

const strip = (html: string) => html.replace(/<h2[^>]*>/gi, "\n## ").replace(/<\/h2>/gi, "\n").replace(/<li>/gi, "\n- ").replace(/<\/p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();

async function main() {
  const batchId = get("--batch");
  const ids = batchId
    ? (await prisma.copyBatchItem.findMany({ where: { batchId, status: "done", articleId: { not: null } }, orderBy: { position: "asc" } })).map((i) => i.articleId!)
    : args.flatMap((a, i) => (a === "--article" ? [args[i + 1]] : []));
  if (!ids.length) throw new Error("--batch <id> или --article <id>");
  const rows: Array<Record<string, unknown>> = [];
  let cost = 0;
  for (const id of ids) {
    const a = await prisma.article.findUnique({ where: { id }, select: { keyword: true, html: true, h1: true, teamId: true, createdById: true, siteId: true, wpUrl: true } });
    if (!a?.html || !a.createdById) continue;
    const text = strip(a.html);
    const lower = text.toLowerCase();
    const banned = BANNED.filter((w) => lower.includes(w));
    // Одинаковые зачины секций: первые три слова после каждого H2.
    const openers = [...text.matchAll(/## [^\n]+\n+([^\n]+)/g)].map((m) => m[1].split(/\s+/).slice(0, 3).join(" ").toLowerCase());
    const dupOpeners = [...new Set(openers.filter((o, i) => openers.indexOf(o) !== i))];
    const dashes = (text.match(/[—–]/g) ?? []).length;
    const words = text.split(/\s+/).length;
    try {
      const r = await aiChat({ userId: a.createdById, teamId: a.teamId, articleId: id, siteId: a.siteId }, {
        slot: SLOTS.textFast, model: MODEL, json: true, temperature: 0, maxTokens: 1500,
        system: `You are a demanding US magazine editor reviewing a photo-led listicle (one photo per H2; you do not see the photos). Score 1-10 and be strict; 8+ means publishable in a good blog without edits. Return JSON only:
{"specificity":n,"repetition":n,"fluff":n,"headings":n,"flow":n,"accuracy_risk":n,"overall":n,
"best":"one sentence: what works",
"problems":["up to 6 concrete problems, each quoting 3-8 words from the text"],
"heading_note":"one sentence on the H2 set: pattern, variety, naturalness",
"fix":"the single most valuable prompt-level instruction that would fix the worst problem"}
Scoring guide: specificity = concrete nouns, numbers, timings instead of adjectives; repetition = no recurring openings, idioms, sentence shapes across sections (10 = none); fluff = no marketing language, no empty praise (10 = none); headings = natural, varied, informative, not formulaic; flow = sections differ in angle and length and the article reads as edited by one person; accuracy_risk = the text claims only what a photo could show or general knowledge (10 = no risky claims such as exact lengths, hidden details, fabrics, 'invisible' parts).`,
        user: `Title: ${a.h1 ?? a.keyword}\nKeyword: ${a.keyword}\n\n${text.slice(0, 60000)}`,
      });
      cost += r.costUsd ?? 0;
      const j = (r.json ?? {}) as Record<string, unknown>;
      rows.push({ keyword: a.keyword, words, overall: j.overall, spec: j.specificity, rep: j.repetition, fluff: j.fluff, h2: j.headings, flow: j.flow, acc: j.accuracy_risk, banned: banned.join(",") || "-", dupOpen: dupOpeners.length, dashes });
      console.log(`\n=== ${a.keyword} (${a.wpUrl ?? id})\nbest: ${j.best}\nheadings: ${j.heading_note}\nfix: ${j.fix}\nproblems:\n- ${((j.problems as string[]) ?? []).join("\n- ")}${banned.length ? `\nbanned words: ${banned.join(", ")}` : ""}${dupOpeners.length ? `\nrepeated openers: ${dupOpeners.join(" | ")}` : ""}`);
    } catch (e) {
      console.log(`${a.keyword}: ОШИБКА ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("");
  console.table(rows);
  console.log(`расход $${cost.toFixed(3)}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
