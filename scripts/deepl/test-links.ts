// ТЕСТ починки фраз вокруг ссылок: отдельный шаг после редактуры. Анкор и href не меняются никогда.
// Запуск: npx tsx scripts/deepl/test-links.ts <jobId:position> [<jobId:position> …]
// Шаг 1: модель чинит только предложения со ссылкой (анкор показан как [[текст]] и неприкосновенен).
// Шаг 2: модель-контролёр отвечает, цело ли предложение. Не цело или анкор задет — берётся предложение оригинала.
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { decryptSecret } from "@/lib/crypto";
import { anchorSentences, placeholderLayout, protectHtml, restoreHtml } from "@/lib/deepl/html";

const MODEL = process.env.LINK_MODEL || "google/gemini-4-argon";
const PH = /<x-ph i="(\d+)"><\/x-ph>/g;
const BLOCK = /<\/?(?:p|li|h[1-6]|td|th|figcaption|blockquote|ul|ol|table|tr|div)\b[^>]*>|\[\/?caption[^\]]*\]/gi;
const SENT = /(?<=[.!?…])\s+(?=[A-ZА-ЯІЇЄҐ«"„<\[])/u;

const SYS_FIX = `Ти — коректорка українського онлайн-видання. Тобі дано речення статті після машинного перекладу («переклад») і те саме речення в оригіналі («оригінал»).
Слова в подвійних квадратних дужках [[…]] — це текст посилання. Він НЕЗМІННИЙ: його не можна змінювати, відмінювати, скорочувати, розривати чи прибирати, і він має лишитися в реченні рівно один раз, символ у символ.
Переклад робився без тексту посилання, тому слова довкола нього часто не складаються з ним в одне речення: загублено сполучник («я пояснювала]] тепло дає» замість «я пояснювала]], що тепло дає»), стоїть зайве дієслово чи прийменник, не той відмінок, прикметник без іменника («буде легким [[природні хвилі]]»), немає пробілу перед дужками.
Завдання: зроби речення граматично цілим РАЗОМ із текстом посилання. Будову довкола посилання бери з оригіналу, решту слів перекладу зберігай — оригінал дослівно не переписуй. Якщо речення вже ціле, поверни його без змін. HTML-теги всередині речення лишай як є.
Відповідай ТІЛЬКИ JSON-масивом: [{"id":1,"fixed":"речення"}] — по одному об'єкту на кожне речення.`;

const SYS_CHECK = `Ти — коректорка. Для кожного речення скажи, чи читається воно як одне граматично ціле українське речення разом зі словами в [[…]] (це текст посилання, частина речення). Помилка — це два присудки без сполучника, прикметник чи прийменник без іменника, не той відмінок біля посилання, обірване речення. Стиль не оцінюй.
Відповідай ТІЛЬКИ JSON-масивом: [{"id":1,"ok":true}]`;

async function ask(key: string, system: string, user: string): Promise<{ text: string; cost: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "zewex deepl links test" },
      body: JSON.stringify({ model: MODEL, temperature: 0.1, messages: [{ role: "system", content: system }, { role: "user", content: user }], reasoning: { effort: "minimal" }, usage: { include: true } }),
      signal: AbortSignal.timeout(180_000),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number } };
    const text = String(j.choices?.[0]?.message?.content ?? "").trim();
    if (res.ok && text) return { text, cost: j.usage?.cost ?? 0 };
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  return { text: "", cost: 0 };
}
const parse = <T,>(t: string): T[] => { try { return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)) as T[]; } catch { return []; } };
const count = (s: string, sub: string) => s.split(sub).length - 1;

type Row = { id: number; anchors: string[]; before: string; original: string; after: string; status: "как было" | "исправлено" | "взято из оригинала" | "пропущено" };

(async () => {
  const orKeys = await prisma.apiKey.findMany({ where: { provider: { slug: "openrouter" }, status: "ACTIVE" } });
  const key = decryptSecret(orKeys[0]!.secretEnc);
  const report: Record<string, unknown> = {};
  for (const arg of process.argv.slice(2)) {
    const [jobId, pos] = arg.split(":");
    const it = await prisma.deeplItem.findFirstOrThrow({ where: { jobId, position: Number(pos) } });
    const sourceHtml = it.sourceHtml!;
    const { text: prot, tokens } = protectHtml(it.finalHtml!);
    const anchorOf = (i: number): string | null => {
      const m = (tokens[i] ?? "").match(/^<a\b[^>]*>([\s\S]*?)<\/a\s*>$/i);
      if (!m || /<img\b/i.test(m[1]!)) return null;
      const t = m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return t || null;
    };
    // Блоки текста между блочными тегами; в каждом — предложения со ссылками.
    const cuts = [0, ...[...prot.matchAll(BLOCK)].flatMap((m) => [m.index!, m.index! + m[0].length]), prot.length];
    const rows: Row[] = [];
    const spans: { start: number; end: number; row: Row }[] = [];
    for (let c = 0; c + 1 < cuts.length; c++) {
      const seg = prot.slice(cuts[c]!, cuts[c + 1]!);
      if (!PH.test(seg)) { PH.lastIndex = 0; continue; }
      PH.lastIndex = 0;
      let offset = cuts[c]!;
      for (const sent of seg.split(SENT)) {
        const start = prot.indexOf(sent, offset);
        offset = start + sent.length;
        const ids = [...sent.matchAll(PH)].map((m) => Number(m[1]));
        const anchors = ids.map(anchorOf);
        if (!ids.length || anchors.some((a) => a === null)) continue; // без ссылок или с картинкой
        const list = anchors as string[];
        let shown = sent;
        ids.forEach((id, k) => { shown = shown.replace(`<x-ph i="${id}"></x-ph>`, `[[${list[k]}]]`); });
        const plainWords = shown.replace(/\[\[[^\]]*\]\]/g, " ").replace(/<[^>]+>/g, " ").split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;
        const origMap = anchorSentences(sourceHtml, list.map((t) => ({ text: t })));
        let original = origMap.get(list[0]!.toLowerCase()) ?? "";
        for (const a of list) { const at = original.toLowerCase().indexOf(a.toLowerCase()); if (at >= 0) original = `${original.slice(0, at)}[[${a}]]${original.slice(at + a.length)}`; }
        const row: Row = { id: rows.length + 1, anchors: list, before: shown.trim(), original, after: shown.trim(), status: "пропущено" };
        // Подпись «Джерело: [[@автор]]» и предложения без оригинала не трогаем.
        if (plainWords >= 3 && original && list.every((a) => original.includes(`[[${a}]]`))) row.status = "как было";
        rows.push(row);
        spans.push({ start, end: start + sent.length, row });
      }
    }
    const todo = rows.filter((r) => r.status === "как было");
    let cost = 0;
    const valid = (r: Row, s: string) => r.anchors.every((a) => count(s, `[[${a}]]`) === 1) && count(s, "[[") === r.anchors.length && s.length > r.before.length * 0.6 && s.length < r.before.length * 1.6 && (s.match(/<[^>]+>/g) ?? []).sort().join() === (r.before.match(/<[^>]+>/g) ?? []).sort().join();
    if (todo.length) {
      const fx = await ask(key, SYS_FIX, todo.map((r) => `id ${r.id}\nоригінал: ${r.original}\nпереклад: ${r.before}`).join("\n\n"));
      cost += fx.cost;
      for (const f of parse<{ id: number; fixed: string }>(fx.text)) {
        const r = todo.find((x) => x.id === Number(f.id));
        const s = String(f.fixed ?? "").trim();
        if (r && valid(r, s)) { r.after = s; if (s !== r.before) r.status = "исправлено"; }
      }
      const ck = await ask(key, SYS_CHECK, todo.map((r) => `id ${r.id}: ${r.after}`).join("\n"));
      cost += ck.cost;
      const verdict = new Map(parse<{ id: number; ok: boolean }>(ck.text).map((x) => [Number(x.id), x.ok !== false]));
      for (const r of todo) if (verdict.get(r.id) === false) { r.after = r.original; r.status = "взято из оригинала"; }
    }
    // Сборка: с конца, чтобы не сдвигать позиции.
    let out = prot;
    for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
      if (sp.row.after === sp.row.before) continue;
      const ids = [...out.slice(sp.start, sp.end).matchAll(PH)].map((m) => Number(m[1]));
      let s = sp.row.after;
      sp.row.anchors.forEach((a, k) => { s = s.replace(`[[${a}]]`, `<x-ph i="${ids[k]}"></x-ph>`); });
      const lead = out.slice(sp.start, sp.end).match(/^\s*/)![0];
      out = out.slice(0, sp.start) + lead + s + out.slice(sp.end);
    }
    const finalHtml = restoreHtml(out, tokens, "UK");
    const links = (h: string) => (h.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).join("\n");
    const linksOk = links(finalHtml) === links(sourceHtml) && placeholderLayout(out) === placeholderLayout(prot);
    const stages = [...(it.stages as unknown[]).filter((s) => (s as { key: string }).key !== "final"), { key: "links#0", label: "Фразы у ссылок", html: finalHtml, chars: finalHtml.length }, { key: "final", label: "Итоговый", html: finalHtml, chars: finalHtml.length }];
    const position = Number(pos) + 500;
    await prisma.deeplItem.deleteMany({ where: { jobId, position } });
    const n = (st: Row["status"]) => rows.filter((r) => r.status === st).length;
    const info = [{ code: "test_links", detail: `Фразы у ссылок · ${MODEL} · $${cost.toFixed(4)} · предложений со ссылками ${rows.length}: исправлено ${n("исправлено")}, взято из оригинала ${n("взято из оригинала")}, без изменений ${n("как было")}, пропущено ${n("пропущено")} · ссылки ${linksOk ? "совпадают с исходником" : "ОТЛИЧАЮТСЯ"}` }];
    await prisma.deeplItem.create({ data: { jobId: jobId!, position, title: `${String(position + 1)} · ссылки · ${it.title.split(" · ").slice(1).join(" · ")}`.slice(0, 250), sourceUrl: it.sourceUrl, sourceHtml, finalHtml, stages: stages as Prisma.InputJsonValue, warnings: info as Prisma.InputJsonValue, status: "done", stage: "done", costUsd: cost, startedAt: new Date(), finishedAt: new Date() } });
    console.log(arg, info[0]!.detail);
    report[arg] = { title: it.title, linksOk, cost, rows };
  }
  writeFileSync("/root/links-report.json", JSON.stringify(report));
  process.exit(0);
})();
