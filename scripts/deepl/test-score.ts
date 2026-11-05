// Оценка тестовых связок: метрики кодом + строгий судья (ИИ) по секциям, эталон живости — исходник.
// Запуск: npx tsx scripts/deepl/test-score.ts <jobId> [judgeModel]
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { chat, sectionsOf, type AiCtx } from "@/lib/deepl/edit";
import { mapLimit } from "@/lib/deepl/deepl";
import { overlapPct, visibleText, countRussianisms, mixedScriptWords, addressStats, placeholderLayout, protectHtml } from "@/lib/deepl/html";

const SYSTEM = `Ти — головна редакторка українського жіночого онлайн-видання, дуже вимоглива до мови. Перед тобою ОРИГІНАЛ секції статті (написаний живо, коротко, з голосом авторки) і ВАРІАНТ — той самий текст після ланцюжка машинних перекладів. Формулювання у варіанті МАЮТЬ відрізнятися від оригіналу — це мета, за це бали не знижуй. Оціни, чи варіант лишився таким самим живим, точним і природним українським текстом.
Відповідай ТІЛЬКИ JSON без пояснень:
{"mova":1-5,"fakty":1-5,"terminy":1-5,"zvertannia":1-5,"styl":1-5,"issues":[{"k":"mova|fakty|terminy|styl","q":"точна цитата з варіанта, до 12 слів","fix":"у чому огріх, коротко"}]}
Шкали (5 — на рівні оригіналу або краще; 4 — дрібні огріхи; 3 — помітно гірше; 2 — багато огріхів; 1 — читати неможливо). Оцінюй суворо, 5 став рідко.
- mova: природна українська — без кальок, русизмів, неузгоджень, зламаних речень, неприродного порядку слів, чужих слів.
- fakty: зміст як в оригіналі — предмети, дії, числа, кольори, з/без, напрямок, адресат; нічого не перекручено, не загублено і не додано.
- terminy: предметна лексика точна й така сама за змістом, як в оригіналі (назва предмета статті, деталі, прийоми, назви видань та імена); один предмет — одним словом.
- zvertannia: звертання (ти/ви), рід авторки, наказовий спосіб в інструкціях — як в оригіналі.
- styl: живість — короткі речення, дієслова дії, без канцеляриту («слід», «необхідно», «протягом», «з використанням», «оскільки», «тоді як», «завдяки чому», «є»), без зайвих «ваш/свій/цей», без води й штампів. Порівнюй з оригіналом: довше й офіційніше — нижчий бал.
issues — до 6 найпоказовіших огріхів.`;

const MARK = /оскільки|тоді як|(?<!\p{L})слід(?!\p{L})|протягом|з використанням|за допомогою|завдяки чому|таким чином|для того,? щоб|необхідно|відповідн\p{L}+|(?<!\p{L})є(?!\p{L})|у разі|в області|у зоні|забезпечу\p{L}+|здійсню\p{L}+/giu;
const words = (t: string) => t.toLowerCase().split(/[^\p{L}\d'’]+/u).filter(Boolean);
const stem = (w: string) => w.replace(/[’']/g, "").slice(0, 5);

(async () => {
  const jobId = process.argv[2]!;
  const model = process.argv[3] || "openai/gpt-6-luna";
  const job = await prisma.deeplJob.findUniqueOrThrow({ where: { id: jobId } });
  const items = await prisma.deeplItem.findMany({ where: { jobId, status: "done" }, orderBy: { position: "asc" } });
  const rows: string[] = [];
  await mapLimit(items, 4, async (it) => {
    const src = it.sourceHtml!;
    const fin = it.finalHtml!;
    const st = visibleText(src);
    const ft = visibleText(fin);
    const sw = words(st);
    const fw = words(ft);
    const sent = (t: string) => t.split(/[.!?…]+\s/).filter((x) => x.trim().length > 15);
    // термины: содержательные слова исходника (≥6 букв, ≥3 раз) — доля сохранённых по корню
    const freq = new Map<string, number>();
    for (const w of sw) if (w.length >= 6) freq.set(stem(w), (freq.get(stem(w)) ?? 0) + 1);
    const terms = [...freq].filter(([, n]) => n >= 3).map(([k]) => k);
    const fset = new Set(fw.map(stem));
    const termKeep = terms.length ? Math.round((terms.filter((t) => fset.has(t)).length / terms.length) * 100) : 100;
    const nums = (t: string) => (t.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(" ");
    const sSent = new Set(sent(st).map((x) => x.trim()));
    const metrics = {
      overlapIn: overlapPct(src, fin, 5),
      overlap3: overlapPct(src, fin, 3),
      sameSent: Math.round((sent(ft).filter((x) => sSent.has(x.trim())).length / Math.max(1, sent(ft).length)) * 100),
      growth: Math.round((fw.length / sw.length - 1) * 1000) / 10,
      sentLen: Math.round((fw.length / Math.max(1, sent(ft).length)) * 10) / 10,
      marks: (ft.match(MARK) ?? []).length,
      marksSrc: (st.match(MARK) ?? []).length,
      termKeep,
      numsOk: nums(st) === nums(ft),
      russianisms: countRussianisms(fin),
      mixed: mixedScriptWords(fin).length,
      latin: (ft.match(/[A-Za-z]{3,}/g) ?? []).length - (st.match(/[A-Za-z]{3,}/g) ?? []).length,
      layoutOk: placeholderLayout(protectHtml(src).text) === placeholderLayout(protectHtml(fin).text),
      ty: addressStats(fin).ty,
      vy: addressStats(fin).vy,
    };
    let cost = 0;
    const ctx: AiCtx = { userId: job.createdById, teamId: job.teamId, refId: it.id, model, onCost: (u) => (cost += u) };
    const a = sectionsOf(src).map(visibleText);
    const b = sectionsOf(fin).map(visibleText);
    const pairs: [string, string][] =
      a.length === b.length && a.length > 1
        ? a.map((o, i) => [o, b[i]!] as [string, string]).filter(([o, e]) => o.length > 60 && e.length > 60)
        : [[st.slice(0, 14000), ft.slice(0, 14000)]];
    const K = ["mova", "fakty", "terminy", "zvertannia", "styl"] as const;
    const sums: Record<string, number[]> = { mova: [], fakty: [], terminy: [], zvertannia: [], styl: [] };
    const issues: unknown[] = [];
    await mapLimit(pairs, 3, async ([o, e], i) => {
      for (let t = 0; t < 2; t++) {
        try {
          const r = await chat(ctx, SYSTEM, `ОРИГІНАЛ СЕКЦІЇ:\n"""\n${o}\n"""\n\nВАРІАНТ:\n"""\n${e}\n"""\n\nJSON:`, 0);
          const j = JSON.parse(r.slice(r.indexOf("{"), r.lastIndexOf("}") + 1));
          for (const k of K) {
            const v = Number(j[k]);
            if (Number.isFinite(v)) sums[k]!.push(Math.max(1, Math.min(5, v)));
          }
          for (const x of (j.issues ?? []).slice(0, 6)) issues.push({ k: String(x.k ?? "mova"), q: String(x.q ?? "").slice(0, 200), fix: String(x.fix ?? "").slice(0, 200), section: i });
          return;
        } catch {
          /* retry */
        }
      }
    });
    const avg = (x: number[]) => (x.length ? Math.round((x.reduce((p, c) => p + c, 0) / x.length) * 100) / 100 : 0);
    const scores = Object.fromEntries(K.map((k) => [k, avg(sums[k]!)])) as Record<(typeof K)[number], number>;
    const total = Math.round(((scores.mova + scores.fakty + scores.terminy + scores.styl) / 4) * 100) / 100;
    const report = {
      model, sections: sums.mova!.length, scores, total, issues: issues.slice(0, 40),
      metrics: { ...metrics, clichesSource: 0, clichesFinal: 0, addressSource: null, addressFinal: null, addressMixed: false, overlapOut: metrics.overlapIn },
      costUsd: cost,
    };
    if (model === "openai/gpt-6-luna") await prisma.deeplItem.update({ where: { id: it.id }, data: { quality: report as unknown as Prisma.InputJsonValue, costUsd: cost } });
    rows.push([
      String(it.position + 1).padStart(2, "0"), it.title.split(" · ")[1], total, scores.mova, scores.fakty, scores.terminy, scores.styl,
      metrics.overlapIn, metrics.overlap3, metrics.sameSent, metrics.growth, metrics.sentLen, metrics.marks, metrics.termKeep,
      metrics.numsOk ? "ok" : "NUM", metrics.russianisms, metrics.mixed, metrics.latin, metrics.layoutOk ? "ok" : "MOVED", it.deeplChars, cost.toFixed(4),
    ].join("\t"));
  });
  console.log(`# ${job.name} · judge ${model}`);
  console.log(["#", "chain", "total", "mova", "fakty", "term", "styl", "ov5%", "ov3%", "same%", "grow%", "sentL", "marks", "termKeep%", "nums", "rus", "mixed", "latin+", "links", "chars", "$"].join("\t"));
  console.log(rows.sort().join("\n"));
  process.exit(0);
})();
