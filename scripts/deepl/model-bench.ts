/**
 * Стенд моделей OpenRouter для DeepL Articler: те же системные правила, промты и проверки, что в боевой цепочке,
 * на реальных статьях после цепочки переводов. Ничего не пишет в базу статей.
 * Запуск (в /root/zewex-check): npx tsx scripts/deepl/model-bench.ts <jobId> <outDir> [model,model,…]
 * Ключ — первый активный ключ OpenRouter (или OR_KEY_LABEL). Итог: таблица в консоли + <outDir>/report.md с текстами.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../src/lib/db";
import { decryptSecret } from "../../src/lib/crypto";
import {
  anchorsFromTokens, chunkBySections, detectMasculineVoice, protectHtml, repairPlaceholders, rewritePct, validateChunk, chunkIsFatal, visibleText, visibleTextLength,
} from "../../src/lib/deepl/html";
import { contextBlock, EDIT_SYSTEM, HEADINGS_SYSTEM, parseHeadings } from "../../src/lib/deepl/edit";
import { parseSettings } from "../../src/lib/deepl/types";

const DEFAULT_MODELS = [
  "qwen/qwen3.7-flash",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4.1-flash",
  "google/gemini-2.5-flash-lite",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6-luna",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-flash",
  "mistralai/mistral-small-3.2-24b-instruct",
  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash",
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

async function main() {
  const [jobId, outDir, list] = process.argv.slice(2);
  if (!jobId || !outDir) throw new Error("usage: model-bench.ts <jobId> <outDir> [models]");
  mkdirSync(outDir, { recursive: true });
  const models = list ? list.split(",") : DEFAULT_MODELS;
  const job = await prisma.deeplJob.findUniqueOrThrow({ where: { id: jobId } });
  const cfg = parseSettings(job.settings);
  const prompts = await prisma.deeplPrompt.findMany();
  const postPrompt = cfg.postEdit.prompt || prompts.find((p) => p.purpose === "post_edit")!.body;
  const h2Prompt = cfg.headings.prompt || prompts.find((p) => p.purpose === "headings")!.body;
  const items = await prisma.deeplItem.findMany({ where: { jobId }, orderBy: { position: "asc" }, take: 3 });

  const orKeys = await prisma.apiKey.findMany({ where: { provider: { slug: "openrouter" }, status: "ACTIVE" } });
  const keyRow = orKeys.find((k) => k.label === process.env.OR_KEY_LABEL) ?? orKeys[0];
  if (!keyRow) throw new Error("нет ключа OpenRouter");
  const key = decryptSecret(keyRow.secretEnc);

  // Образцы: одна H2-секция (заголовок + абзацы) после тройного перевода + исходник той же секции.
  type Sample = { title: string; h1: string | null; src: string; text: string; anchors: string[]; h2: string[] };
  const samples: Sample[] = [];
  for (const it of items) {
    const stages = (it.stages ?? []) as Array<{ key: string; html: string }>;
    const tr = [...stages].reverse().find((s) => s.key.startsWith("translate#"));
    if (!tr) continue;
    const { text, tokens } = protectHtml(tr.html);
    const secs = chunkBySections(text, 1, 9000);
    const srcSecs = chunkBySections(protectHtml(it.sourceHtml ?? "").text, 1, 9000);
    const idx = secs.length > 2 ? 2 : secs.length - 1;
    samples.push({
      title: it.title,
      h1: null,
      src: srcSecs[idx] ?? "",
      text: secs[idx]!,
      anchors: anchorsFromTokens(tokens).map((a) => a.text),
      h2: [...tr.html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    });
  }
  console.log(`samples: ${samples.length}, models: ${models.length}`);

  const rows: string[] = [];
  const report: string[] = [`# Стенд моделей — прогон ${job.name}\n`];
  for (const [si, s] of samples.entries()) {
    report.push(`\n## Статья ${si + 1}: ${s.title}\n\n**Исходник секции (до перевода):**\n\n> ${plain(s.src)}\n\n**После UK→EN→DE→UK (вход постредактуры):**\n\n> ${plain(s.text)}\n`);
  }

  const results = await Promise.all(models.map(async (model) => {
    let cost = 0, ms = 0, fatal = 0, rw: number[] = [], male = 0, errors: string[] = [], h2ok = 0, h2total = 0, h2len = 0;
    const texts: string[] = [];
    for (const s of samples) {
      const ctx = { title: s.title, h1: s.h1, lightTouch: true, anchors: s.anchors, reference: process.env.NO_REF ? undefined : visibleText(s.src) };
      const pe = await call(key, model, EDIT_SYSTEM, `${contextBlock(ctx)}Инструкция редактуры:\n${postPrompt}\n\nHTML-фрагмент:\n${s.text}`, 0.2);
      cost += pe.cost; ms += pe.ms;
      if (pe.error) { errors.push(pe.error); fatal++; texts.push(`(ошибка: ${pe.error})`); }
      else {
        const out = repairPlaceholders(s.text, pe.text);
        const issues = validateChunk(s.text, out);
        const growth = visibleTextLength(out) / Math.max(1, visibleTextLength(s.text)) - 1;
        const pct = rewritePct(s.text, out);
        rw.push(pct);
        const bad = chunkIsFatal(issues) || pct > 22 || growth > 0.12;
        if (bad) fatal++;
        male += detectMasculineVoice(out).length;
        texts.push(`${bad ? "❌ ОТКЛОНЕНО проверкой" : "✅ принято"} (переписано ${pct}%, объём ${growth >= 0 ? "+" : ""}${Math.round(growth * 100)}%${issues.length ? `, ${issues.map((x) => x.code).join(",")}` : ""}):\n\n> ${plain(out)}`);
      }
      const hd = await call(key, model, HEADINGS_SYSTEM, `Title статьи: ${s.title}\n\nИнструкция:\n${h2Prompt}\n\nЗаголовки H2:\n${s.h2.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nВ конце ответа обязательно дай итоговый список строго в формате "N. заголовок" — по одной строке на каждый H2, в исходном порядке.`, 0.4);
      cost += hd.cost; ms += hd.ms;
      const parsed = hd.error ? [] : parseHeadings(hd.text, s.h2.length);
      h2total += s.h2.length;
      h2ok += parsed.filter(Boolean).length;
      h2len += parsed.filter((x) => x && x.length >= 30 && x.length <= 70).length;
      texts.push(`**H2:** ${hd.error ? `ошибка ${hd.error}` : parsed.map((x, i) => `${i + 1}) ${x ?? "—"}`).join(" · ")}`);
    }
    return { model, cost, ms, fatal, rw, male, errors, h2ok, h2total, h2len, texts };
  }));

  for (const r of results) {
    const avgRw = r.rw.length ? Math.round(r.rw.reduce((a, b) => a + b, 0) / r.rw.length) : -1;
    rows.push(`${r.model.padEnd(42)} $${r.cost.toFixed(5).padStart(8)}  ${String(Math.round(r.ms / 1000)).padStart(4)}s  откл ${r.fatal}/${samples.length}  перепис ${avgRw}%  муж ${r.male}  H2 ${r.h2ok}/${r.h2total} (длина ок ${r.h2len})${r.errors.length ? "  ERR " + r.errors[0] : ""}`);
    report.push(`\n---\n\n### ${r.model} — $${r.cost.toFixed(5)}, ${Math.round(r.ms / 1000)} с\n`);
    r.texts.forEach((t) => report.push(`${t}\n`));
  }
  console.log(rows.join("\n"));
  writeFileSync(join(outDir, "report.md"), report.join("\n"));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
