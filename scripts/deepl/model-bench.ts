/**
 * Стенд моделей OpenRouter для постредактуры DeepL Articler: те же языковые пакеты, промты и проверки, что в боевой
 * цепочке, на реальных секциях статей после цепочки переводов. Ничего не пишет в базу статей.
 * Запуск (в каталоге приложения): npx tsx scripts/deepl/model-bench.ts <outDir> [model,model,…]
 * Параметры окружения: ARTICLES=4 (статей), SECTIONS=2 (секций на статью), OR_KEY_LABEL (ключ OpenRouter),
 * PROMPT_ID (промт постредактуры; по умолчанию — первый purpose=post_edit), H2=1 (ещё и стенд заголовков).
 * Итог: таблица в консоли, <outDir>/report.md с текстами и <outDir>/results.json с метриками.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../src/lib/db";
import { decryptSecret } from "../../src/lib/crypto";
import {
  anchorsFromTokens, chunkBySections, chunkIsFatal, countRussianisms, detectMasculineVoice, findRussianisms, matchDashStyle, protectHtml,
  repairPlaceholders, rewritePct, validateChunk, visibleText, visibleTextLength,
} from "../../src/lib/deepl/html";
import { contextBlock, parseHeadings } from "../../src/lib/deepl/edit";
import { langPack } from "../../src/lib/deepl/lang";

const DEFAULT_MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.7-flash",
  "qwen/qwen3.8-flash",
  "z-ai/glm-5.3-flash",
  "openai/gpt-6-luna",
  "openai/gpt-5.6-luna",
  "anthropic/claude-haiku-5.5",
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash",
  "mistralai/mistral-small-3.2-24b-instruct",
  "meta-llama/llama-4-scout",
  "minimax/minimax-m3.1-flash",
  "amazon/nova-lite-v1",
];

type Call = { text: string; cost: number; ms: number; inT: number; outT: number; error?: string };

async function call(key: string, model: string, system: string, user: string, temperature: number): Promise<Call> {
  const t = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "zewex deepl bench" },
      body: JSON.stringify({ model, temperature, messages: [{ role: "system", content: system }, { role: "user", content: user }], reasoning: { effort: "none" }, usage: { include: true } }),
      signal: AbortSignal.timeout(180_000),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
    if (!res.ok) return { text: "", cost: 0, ms: Date.now() - t, inT: 0, outT: 0, error: `${res.status} ${j.error?.message ?? ""}`.slice(0, 200) };
    const text = String(j.choices?.[0]?.message?.content ?? "").replace(/^\s*```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
    return { text, cost: j.usage?.cost ?? 0, ms: Date.now() - t, inT: j.usage?.prompt_tokens ?? 0, outT: j.usage?.completion_tokens ?? 0 };
  } catch (e) {
    return { text: "", cost: 0, ms: Date.now() - t, inT: 0, outT: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

const plain = (h: string) => h.replace(/<x-ph[^>]*><\/x-ph>/g, "[ссылка/фото]").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

type Sample = { title: string; h1: string | null; src: string; text: string; anchors: string[]; h2: string[]; words: number };
type ModelResult = {
  model: string; cost: number; ms: number; fatal: number; rw: number[]; ruAdded: number; ruFixed: number; male: number; errors: string[];
  h2ok: number; h2total: number; h2len: number; texts: string[]; words: number; inT: number; outT: number;
};

async function main() {
  const [outDir, list] = process.argv.slice(2);
  if (!outDir) throw new Error("usage: model-bench.ts <outDir> [models]");
  mkdirSync(outDir, { recursive: true });
  const models = list ? list.split(",") : DEFAULT_MODELS;
  const nArticles = Number(process.env.ARTICLES || 4);
  const nSections = Number(process.env.SECTIONS || 2);
  const prompts = await prisma.deeplPrompt.findMany();
  const postPrompt = (process.env.PROMPT_ID ? prompts.find((p) => p.id === process.env.PROMPT_ID) : prompts.find((p) => p.purpose === "post_edit"))!.body;
  const h2Prompt = prompts.find((p) => p.purpose === "headings")!.body;
  const L = langPack("UK");
  const items = await prisma.deeplItem.findMany({ where: { status: { in: ["done", "warning"] } }, orderBy: { finishedAt: "desc" }, take: nArticles * 3 });

  const orKeys = await prisma.apiKey.findMany({ where: { provider: { slug: "openrouter" }, status: "ACTIVE" } });
  const keyRow = orKeys.find((k) => k.label === process.env.OR_KEY_LABEL) ?? orKeys[0];
  if (!keyRow) throw new Error("нет ключа OpenRouter");
  const key = decryptSecret(keyRow.secretEnc);

  // Образцы: H2-секции (заголовок + абзацы) после тройного перевода + исходник той же секции. Одна статья — один раз.
  const samples: Sample[] = [];
  const seenTitles = new Set<string>();
  for (const it of items) {
    if (samples.length >= nArticles * nSections || seenTitles.has(it.title)) continue;
    const stages = (it.stages ?? []) as Array<{ key: string; html: string }>;
    const tr = [...stages].reverse().find((s) => s.key.startsWith("translate#"));
    if (!tr) continue;
    seenTitles.add(it.title);
    const { text, tokens } = protectHtml(tr.html);
    const secs = chunkBySections(text, 1, 9000);
    const srcSecs = chunkBySections(protectHtml(it.sourceHtml ?? "").text, 1, 9000);
    if (secs.length !== srcSecs.length) continue;
    const picks = [1, 3, 5, 2].filter((i) => i < secs.length).slice(0, nSections);
    for (const idx of picks) {
      samples.push({
        title: it.title, h1: null, src: srcSecs[idx] ?? "", text: secs[idx]!, anchors: anchorsFromTokens(tokens).map((a) => a.text),
        h2: [...tr.html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
        words: plain(secs[idx]!).split(/\s+/).length,
      });
    }
  }
  const totalWords = samples.reduce((a, s) => a + s.words, 0);
  console.log(`samples: ${samples.length} (${totalWords} слов), models: ${models.length}, prompt: ${postPrompt.slice(0, 60)}…`);

  const report: string[] = [`# Стенд постредактуры — ${new Date().toISOString().slice(0, 16)}\n\nОбразцов: ${samples.length}, слов: ${totalWords}. Промт: «${postPrompt.slice(0, 120)}…»\n`];
  for (const [si, s] of samples.entries()) {
    report.push(`\n## Образец ${si + 1}: ${s.title}\n\n**Исходник секции (до перевода):**\n\n> ${plain(s.src)}\n\n**После UK→EN→DE→UK (вход постредактуры), русизмов ${countRussianisms(s.text)}:**\n\n> ${plain(s.text)}\n`);
  }

  const results: ModelResult[] = await Promise.all(models.map(async (model) => {
    const r: ModelResult = { model, cost: 0, ms: 0, fatal: 0, rw: [], ruAdded: 0, ruFixed: 0, male: 0, errors: [], h2ok: 0, h2total: 0, h2len: 0, texts: [], words: totalWords, inT: 0, outT: 0 };
    for (const s of samples) {
      const ctx = { title: s.title, h1: s.h1, lang: "UK", lightTouch: true, anchors: s.anchors, reference: process.env.NO_REF ? undefined : visibleText(s.src) };
      const pe = await call(key, model, L.system, `${contextBlock(ctx)}${L.instructionLabel}\n${postPrompt}\n\n${L.fragmentLabel}\n${s.text}`, 0.2);
      r.cost += pe.cost; r.ms += pe.ms; r.inT += pe.inT; r.outT += pe.outT;
      if (pe.error) { r.errors.push(pe.error); r.fatal++; r.texts.push(`(ошибка: ${pe.error})`); }
      else {
        const out = repairPlaceholders(s.text, matchDashStyle(s.text, pe.text));
        const issues = validateChunk(s.text, out);
        const growth = visibleTextLength(out) / Math.max(1, visibleTextLength(s.text)) - 1;
        const pct = rewritePct(s.text, out);
        r.rw.push(pct);
        const ruIn = countRussianisms(s.text), ruOut = countRussianisms(out);
        const added = findRussianisms(out).filter((w) => !findRussianisms(s.text).includes(w));
        r.ruAdded += Math.max(0, ruOut - ruIn);
        r.ruFixed += Math.max(0, ruIn - ruOut);
        const bad = chunkIsFatal(issues) || pct > 22 || growth > 0.12 || ruOut > ruIn;
        if (bad) r.fatal++;
        r.male += detectMasculineVoice(out).length;
        r.texts.push(`${bad ? "❌ ОТКЛОНЕНО проверкой" : "✅ принято"} (переписано ${pct}%, объём ${growth >= 0 ? "+" : ""}${Math.round(growth * 100)}%, русизмов ${ruIn}→${ruOut}${added.length ? ` [+${added.slice(0, 5).join(", ")}]` : ""}${issues.length ? `, ${issues.map((x) => x.code).join(",")}` : ""}):\n\n> ${plain(out)}`);
      }
      if (process.env.H2) {
        const hd = await call(key, model, L.headingsSystem, `${L.titleLabel}: ${s.title}\n\n${L.headingsInstruction}\n${h2Prompt}\n\n${L.headingsList}\n${s.h2.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n${L.headingsTail}`, 0.4);
        r.cost += hd.cost; r.ms += hd.ms;
        const parsed = hd.error ? [] : parseHeadings(hd.text, s.h2.length);
        r.h2total += s.h2.length;
        r.h2ok += parsed.filter(Boolean).length;
        r.h2len += parsed.filter((x) => x && x.length >= 30 && x.length <= 70).length;
        r.texts.push(`**H2:** ${hd.error ? `ошибка ${hd.error}` : parsed.map((x, i) => `${i + 1}) ${x ?? "—"}`).join(" · ")}`);
      }
    }
    return r;
  }));

  // Цена за статью: средняя статья 1 700 слов (прогоны beautydaily 2026-11-03).
  const rows = results.map((r) => {
    const avgRw = r.rw.length ? Math.round(r.rw.reduce((a, b) => a + b, 0) / r.rw.length) : -1;
    const perArticle = r.words ? (r.cost / r.words) * 1700 : 0;
    return `${r.model.padEnd(42)} $${r.cost.toFixed(4).padStart(7)} (≈$${perArticle.toFixed(4)}/статья)  ${String(Math.round(r.ms / 1000 / samples.length)).padStart(3)}с/секц  откл ${r.fatal}/${samples.length}  перепис ${avgRw}%  русизмы +${r.ruAdded}/−${r.ruFixed}  муж ${r.male}${process.env.H2 ? `  H2 ${r.h2ok}/${r.h2total} (длина ок ${r.h2len})` : ""}${r.errors.length ? "  ERR " + r.errors[0] : ""}`;
  });
  for (const r of results) {
    report.push(`\n---\n\n### ${r.model} — $${r.cost.toFixed(4)}, ${Math.round(r.ms / 1000)} с, русизмы +${r.ruAdded}/−${r.ruFixed}\n`);
    r.texts.forEach((t) => report.push(`${t}\n`));
  }
  console.log(rows.join("\n"));
  writeFileSync(join(outDir, "report.md"), report.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ samples: samples.map((s) => ({ title: s.title, words: s.words, ruIn: countRussianisms(s.text) })), results: results.map(({ texts: _t, ...r }) => r) }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
