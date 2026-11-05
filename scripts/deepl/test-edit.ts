// ТЕСТ редактуры: перевод UK→PL→UK одной статьи × варианты промптов × модели. Результат — тестовый прогон в системе.
// Запуск: npx tsx scripts/deepl/test-edit.ts <blog|ideas> [варианты A,B,…] [модели через запятую]
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import {
  anchorsFromTokens, chunkBySections, chunkIsFatal, findTermPairs, matchDashStyle, overlapPct, placeholderLayout, protectHtml, repairPlaceholders,
  restoreHtml, rewritePct, sourceGlossary, validateChunk, visibleText,
} from "@/lib/deepl/html";
import { contextBlock, referencesFor } from "@/lib/deepl/edit";
import { mapLimit } from "@/lib/deepl/deepl";
import { langPack } from "@/lib/deepl/lang";
import { DEFAULT_SETTINGS } from "@/lib/deepl/types";

const INPUT = {
  blog: { jobId: "9f935b89-6839-4b6e-80cf-a9f16fee2178", kind: "блог" },
  ideas: { jobId: "efce961d-0f00-4d41-9398-2f6e2e01ee9f", kind: "подборка" },
} as const;
const PL_POSITION = 5; // «06 · UK→PL→UK»

const MODELS = [
  "openai/gpt-5.6-luna", "openai/gpt-6-luna", "openai/gpt-6.1-terra", "google/gemini-3.8-flash", "google/gemini-4-argon",
  "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5",
];
const VARIANTS = ["A", "B", "C", "D", "E", "F"] as const;
type V = (typeof VARIANTS)[number];
const VNAME: Record<V, string> = { A: "A как сейчас", B: "B список правок", C: "C точечно+живость", D: "D перестройка фраз", E: "E правки+стиль", F: "F точечно без оригинала" };

/* ---------------- промпты ---------------- */

const SYS_HTML = `Ти — редакторка українського жіночого онлайн-видання (мода, волосся, нігті, догляд, дім). Працюєш із HTML-фрагментом статті після машинного перекладу.
Технічні правила (порушення — брак):
1. Поверни ТІЛЬКИ HTML-фрагмент — без пояснень і markdown.
2. Теги, їх порядок і атрибути лишаються один в один. Кількість абзаців, заголовків, пунктів списку й клітинок таблиці не змінюється.
3. Службові теги <x-ph i="N"></x-ph> — це посилання й фото. Кожен переноси рівно один раз, у той самий абзац, з тим самим номером. Слова поруч із тегом мають читатися з ним як одне ціле речення.
4. Мова — чиста українська, без русизмів і суржику. Авторка — жінка («я обрала», «я спробувала»).
5. Нових фактів, порад і оцінок не додавай. Тире й лапки лишай як у фрагменті.`;

const WHAT = `1. ЗМІСТ проти оригіналу: предмет, деталь, колір, матеріал, число, «з/без», «на/під», напрямок дії, хто що робить, заперечення. Переклад міняє це непомітно. Поверни одне правильне слово, а не речення оригіналу.
2. ТЕРМІНИ: предмет називається так, як в оригіналі, і одним словом у всьому тексті. Типові підміни після польської: «простий» замість «прямий» (крій, силует, лінія); «черевики», «туфлі», «взуття» замість «чоботи»; «стилізація» замість «образ»; «у смужку», «ребристий» замість «у рубчик»; «светр» замість «джемпер» і навпаки; «сукенка» замість «сукня»; «волосся» в множині («волосся висохли»).
3. ЗВЕРТАННЯ: «ти» або «ви» — як в оригіналі й однаково в усьому фрагменті, разом із дієсловами («розчеши», а не «розчешіть»).
4. ЗЛАМАНІ РЕЧЕННЯ: неузгоджені відмінки, рід і число; зайве або загублене слово біля посилання; речення без сенсу; латинські коди на кшталт &#x27; замість апострофа.
5. КАНЦЕЛЯРИТ І ВОДА, яких в оригіналі немає: «слід», «необхідно», «оскільки», «тоді як», «завдяки чому», «за допомогою», «протягом», «з метою», «є + іменник», «даний», зайві «ваш», «свій», «цей», вставні «крім того», «варто зазначити», «у свою чергу». Заміни простим словом («треба», «бо», «а», орудний відмінок) або прибери, якщо речення читається без нього.
6. РОЗДУТЕ РЕЧЕННЯ: якщо речення стало довшим і важчим, ніж в оригіналі, прибери зайві слова. Нових не додавай.`;

const NO_COPY = `Текст навмисно перефразовано перекладом — це потрібно зберегти. Формулювань оригіналу не повертай: понад чотири слова поспіль з оригіналу — помилка (окрім назв, термінів і цитат).`;

const P_C = `Це редактура, а не рерайт. Речення лишаються на своїх місцях і зі своїм каркасом; ти виправляєш у них тільки огріхи. Речення без огріхів поверни дослівно.
${NO_COPY}

Що виправляти:
${WHAT}

Чого не робити: не переказувати, не об'єднувати й не переставляти речення, не прикрашати текст оцінними словами, не міняти слово на синонім без причини.`;

const P_D = `Текст після перекладу звучить як переклад. Твоє завдання — щоб він читався так, ніби авторка написала його сама: коротко, дієсловами, прямо до читачки. Це редактура по реченнях, не переказ статті.
${NO_COPY}

Спершу виправ огріхи:
${WHAT}

Потім пройди кожне речення. Якщо воно звучить як переклад (важкий порядок слів, ланцюжок іменників, пасив, підрядне в підрядному, слова-паразити) — скажи ту саму думку простіше: постав дієслово, зніми зайве підрядне, розбий довге речення на два. Орієнтир ритму — оригінал: такі самі короткі речення, але ІНШИМИ словами. Речення, яке вже звучить живо, не чіпай.
Межі: зміст, порядок думок, кількість абзаців і всі факти лишаються; обсяг фрагмента не більший, ніж в оригіналі; жодних нових оцінок, порад і прикрас.`;

const P_STYLE = `Завдання цього проходу одне — зняти з тексту стильові сліди перекладу. Зміст, терміни, факти, звертання й порядок речень не чіпай. Речення без таких слідів поверни дослівно.
Що знімати:
1. Канцелярит: «слід», «необхідно», «оскільки», «тоді як», «завдяки чому», «за допомогою», «протягом», «з метою», «є + іменник», «даний», «здійснювати», «забезпечувати» — простим словом («треба», «бо», «а», орудний відмінок, дієслово дії).
2. Воду: вставні «крім того», «варто зазначити», «у свою чергу», «таким чином», «насправді» — прибрати, якщо речення читається без них.
3. Зайві займенники «ваш», «свій», «цей», «той», де й так зрозуміло, про що мова.
4. Рекламні оцінки, яких авторка не писала б: «ідеально», «бездоганно», «чудово доповнює», «справжня знахідка» — нейтральне слово або прибрати.
5. Речення понад 25 слів із кількома підрядними — зняти зайве підрядне або розбити на два, тими самими словами.
Нових слів, фактів і оцінок не додавай. Обсяг фрагмента після правки менший або такий самий.`;

const SYS_JSON = `Ти — головна редакторка українського жіночого онлайн-видання. Перед тобою ОРИГІНАЛ секції статті й ПЕРЕКЛАД — той самий текст після машинного перекладу (HTML). Переклад навмисно перефразовано, формулювання мають лишитися іншими, ніж в оригіналі. Знайди в ПЕРЕКЛАДІ огріхи й дай точкові заміни.
Відповідай ТІЛЬКИ JSON-масивом, без пояснень і markdown:
[{"find":"уривок з ПЕРЕКЛАДУ символ у символ","replace":"на що замінити","why":"fakty|terminy|zvertannia|mova|styl"}]
Правила заміни:
- find — суцільний уривок ТЕКСТУ з одного абзацу, 2–12 слів, скопійований точно, без тегів і без <x-ph>. Достатньо довгий, щоб траплятися у фрагменті один раз.
- replace — той самий уривок із виправленням: міняється тільки хибне, решта слів лишається. Щоб прибрати зайве слово, включи у find сусідні слова, а в replace лиши їх без зайвого.
- Не давай замін заради синоніма і не повертай формулювань оригіналу (понад чотири слова поспіль з оригіналу — помилка, окрім назв і термінів).
- Нових фактів, порад і оцінок не додавай. Авторка — жінка.
Що шукати:
${WHAT}
Пройди кожен абзац, підпис до фото, пункт списку й клітинку таблиці. Зазвичай огріхів 2–6 на абзац. Де огріхів немає — нічого не вигадуй.`;

/* ---------------- вызов модели ---------------- */

type Call = { text: string; cost: number; inT: number; outT: number; error?: string };
async function call(key: string, model: string, system: string, user: string, temperature: number, noReasoning = false, attempt = 0): Promise<Call> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "zewex deepl edit test" },
      body: JSON.stringify({ model, temperature, messages: [{ role: "system", content: system }, { role: "user", content: user }], ...(noReasoning ? {} : { reasoning: { effort: "none" } }), usage: { include: true } }),
      signal: AbortSignal.timeout(240_000),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
    if (res.status === 400 && !noReasoning) return call(key, model, system, user, temperature, true, attempt);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 8000 * (attempt + 1))); return call(key, model, system, user, temperature, noReasoning, attempt + 1); }
    if (!res.ok) return { text: "", cost: 0, inT: 0, outT: 0, error: `${res.status} ${j.error?.message ?? ""}`.slice(0, 200) };
    const text = String(j.choices?.[0]?.message?.content ?? "").replace(/^\s*```(?:html|json)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!text && attempt < 2) return call(key, model, system, user, temperature, noReasoning, attempt + 1);
    return { text, cost: j.usage?.cost ?? 0, inT: j.usage?.prompt_tokens ?? 0, outT: j.usage?.completion_tokens ?? 0 };
  } catch (e) {
    if (attempt < 2) return call(key, model, system, user, temperature, noReasoning, attempt + 1);
    return { text: "", cost: 0, inT: 0, outT: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

type Stat = { cost: number; inT: number; outT: number; rollback: number; chunks: number; applied: number; missed: number; errors: string[] };

(async () => {
  const which = process.argv[2] as keyof typeof INPUT;
  const a = INPUT[which];
  if (!a) throw new Error("blog|ideas");
  const variants = (process.argv[3] && process.argv[3] !== "all" ? process.argv[3].split(",") : [...VARIANTS]) as V[];
  const models = process.argv[4] ? process.argv[4].split(",") : MODELS;

  const inp = await prisma.deeplItem.findFirstOrThrow({ where: { jobId: a.jobId, position: PL_POSITION }, include: { job: true } });
  const sourceHtml = inp.sourceHtml!;
  const translated = inp.finalHtml!;
  const baseTitle = inp.title.split(" · ").slice(2).join(" · ");
  const name = `ТЕСТ редактуры · ${a.kind} · ${baseTitle}`.slice(0, 120);
  let job = await prisma.deeplJob.findFirst({ where: { name } });
  if (!job) job = await prisma.deeplJob.create({ data: {
    teamId: inp.job.teamId, createdById: inp.job.createdById, accessId: null, siteName: inp.job.siteName, name, status: "DONE", total: VARIANTS.length * MODELS.length,
    settings: { ...DEFAULT_SETTINGS, headings: { ...DEFAULT_SETTINGS.headings, enabled: false }, postEdit: { ...DEFAULT_SETTINGS.postEdit, enabled: false }, seo: { ...DEFAULT_SETTINGS.seo, enabled: false }, quality: { ...DEFAULT_SETTINGS.quality, address: false, style: false, judge: false } } as unknown as Prisma.InputJsonValue,
    startedAt: new Date(), finishedAt: new Date(),
  } });
  console.log("job", job.id, name);

  const orKeys = await prisma.apiKey.findMany({ where: { provider: { slug: "openrouter" }, status: "ACTIVE" } });
  const keyRow = orKeys.find((k) => k.label === process.env.OR_KEY_LABEL) ?? orKeys[0];
  if (!keyRow) throw new Error("нет ключа OpenRouter");
  const key = decryptSecret(keyRow.secretEnc);
  const postPrompt = (await prisma.deeplPrompt.findFirstOrThrow({ where: { purpose: "post_edit" } })).body;
  const L = langPack("UK");

  const { text: prot, tokens } = protectHtml(translated);
  const srcProt = protectHtml(sourceHtml).text;
  const anchors = anchorsFromTokens(tokens).map((x) => x.text);
  const chunks = chunkBySections(prot, 3, 9000);
  const refs = referencesFor(chunks, srcProt);
  console.log("chunks", chunks.length, "refs", refs.filter(Boolean).length);

  const userFor = (i: number, instruction: string, chunk: string, withRef: boolean) => {
    const ref = withRef ? refs[i] : undefined;
    const gl = ref ? sourceGlossary(ref, visibleText(chunk)) : [];
    return `Title статті: ${baseTitle}\n\n${instruction}\n\n${ref ? `ОРИГІНАЛ СЕКЦІЇ (лише для звірки змісту, термінів і ритму; не копіювати):\n"""\n${ref.slice(0, 8000)}\n"""\n\n` : ""}${gl.length ? `Слова оригіналу, яких бракує у фрагменті (перевір, чи переклад не підмінив їх): ${gl.join(", ")}\n\n` : ""}HTML-фрагмент:\n${chunk}`;
  };

  /** Один HTML-проход по фрагментам: плохой фрагмент повторяется один раз, затем остаётся как был. */
  const htmlPass = async (model: string, st: Stat, input: string[], build: (i: number, chunk: string) => { system: string; user: string }, temperature: number): Promise<string[]> => {
    const out = [...input];
    await mapLimit(input.map((_, i) => i), 3, async (i) => {
      const src = input[i]!;
      const { system, user } = build(i, src);
      for (let t = 0; t < 2; t++) {
        const r = await call(key, model, system, user, temperature);
        st.cost += r.cost; st.inT += r.inT; st.outT += r.outT;
        if (r.error) { st.errors.push(r.error); continue; }
        const cand = repairPlaceholders(src, matchDashStyle(src, r.text));
        if (!chunkIsFatal(validateChunk(src, cand))) { out[i] = cand; return; }
      }
      st.rollback++;
    });
    return out;
  };

  /** Список правок: модель даёт пары «найти → заменить», код применяет их к тексту. Разметка не может пострадать. */
  const fixPass = async (model: string, st: Stat, input: string[]): Promise<string[]> => {
    const out = [...input];
    await mapLimit(input.map((_, i) => i), 3, async (i) => {
      const src = input[i]!;
      const ref = refs[i];
      const gl = ref ? sourceGlossary(ref, visibleText(src)) : [];
      const user = `Title статті: ${baseTitle}\n\nОРИГІНАЛ СЕКЦІЇ:\n"""\n${(ref ?? "").slice(0, 8000)}\n"""\n\n${gl.length ? `Слова оригіналу, яких бракує в перекладі (перевір, чи їх не підмінено): ${gl.join(", ")}\n\n` : ""}ПЕРЕКЛАД (HTML):\n${src}\n\nJSON:`;
      for (let t = 0; t < 2; t++) {
        const r = await call(key, model, SYS_JSON, user, 0.1);
        st.cost += r.cost; st.inT += r.inT; st.outT += r.outT;
        if (r.error) { st.errors.push(r.error); continue; }
        let list: Array<{ find?: unknown; replace?: unknown }> = [];
        try { list = JSON.parse(r.text.slice(r.text.indexOf("["), r.text.lastIndexOf("]") + 1)); } catch { continue; }
        let cur = src;
        for (const f of list) {
          const find = String(f.find ?? ""); const rep = String(f.replace ?? "");
          if (find.length < 3 || !rep.trim() || /[<>]/.test(find + rep) || find === rep) { st.missed++; continue; }
          const at = cur.indexOf(find);
          if (at < 0) { st.missed++; continue; }
          cur = cur.slice(0, at) + rep + cur.slice(at + find.length);
          st.applied++;
        }
        if (!chunkIsFatal(validateChunk(src, cur))) { out[i] = cur; return; }
      }
      st.rollback++;
    });
    return out;
  };

  const todo = variants.flatMap((v) => models.map((m) => ({ v, m })));
  const rows: string[] = [];
  await mapLimit(todo, 6, async ({ v, m }) => {
    const position = VARIANTS.indexOf(v) * MODELS.length + Math.max(0, MODELS.indexOf(m));
    const label = `${String(position + 1).padStart(2, "0")} · ${v}/${m.split("/")[1]}`;
    if (await prisma.deeplItem.findFirst({ where: { jobId: job!.id, position, status: "done" } })) { console.log("skip", label); return; }
    await prisma.deeplItem.deleteMany({ where: { jobId: job!.id, position } });
    const st: Stat = { cost: 0, inT: 0, outT: 0, rollback: 0, chunks: chunks.length, applied: 0, missed: 0, errors: [] };
    const stages: unknown[] = [
      { key: "source", label: "Исходный", html: sourceHtml, chars: sourceHtml.length },
      { key: "translate#0:UK>PL>UK", label: "Перевод UK→PL→UK", html: translated, chars: translated.length },
    ];
    const snap = (k: string, lbl: string, cs: string[]) => { const h = restoreHtml(cs.join(""), tokens, "UK"); stages.push({ key: k, label: lbl, html: h, chars: h.length }); };
    let cur = chunks;
    if (v === "A") {
      cur = await htmlPass(m, st, cur, (i, c) => {
        const ref = refs[i];
        const ctx = { title: baseTitle, h1: null, lang: "UK", lightTouch: true, anchors, reference: ref, ...(ref ? { glossary: sourceGlossary(ref, visibleText(c)), termPairs: findTermPairs(ref, c) } : {}) };
        return { system: L.system, user: `${contextBlock(ctx)}${L.instructionLabel}\n${postPrompt}\n\n${L.fragmentLabel}\n${c}` };
      }, 0.2);
      snap("post_edit#0", "Постредактура (как сейчас)", cur);
      cur = await htmlPass(m, st, cur, (_i, c) => ({ system: L.system, user: `${contextBlock({ title: baseTitle, h1: null, lang: "UK", lightTouch: true, mode: "style", anchors })}${L.instructionLabel}\n${L.stylePrompt}\n\n${L.fragmentLabel}\n${c}` }), 0.2);
      snap("style#0", "Стиль (как сейчас)", cur);
    } else if (v === "B") {
      cur = await fixPass(m, st, cur);
      snap("fix#0", "Список правок", cur);
    } else if (v === "C") {
      cur = await htmlPass(m, st, cur, (i, c) => ({ system: SYS_HTML, user: userFor(i, P_C, c, true) }), 0.2);
      snap("edit#0", "Точечная правка + живость", cur);
    } else if (v === "D") {
      cur = await htmlPass(m, st, cur, (i, c) => ({ system: SYS_HTML, user: userFor(i, P_D, c, true) }), 0.4);
      snap("edit#0", "Перестройка фраз", cur);
    } else if (v === "F") {
      cur = await htmlPass(m, st, cur, (i, c) => ({ system: SYS_HTML, user: userFor(i, P_C.replace(/проти оригіналу/, "за глуздом і темою статті"), c, false) }), 0.2);
      snap("edit#0", "Точечная правка без оригинала", cur);
    } else {
      cur = await fixPass(m, st, cur);
      snap("fix#0", "Список правок", cur);
      cur = await htmlPass(m, st, cur, (i, c) => ({ system: SYS_HTML, user: userFor(i, P_STYLE, c, false) }), 0.2);
      snap("style#0", "Стиль без оригинала", cur);
    }
    const joined = cur.join("");
    const finalHtml = restoreHtml(joined, tokens, "UK");
    stages.push({ key: "final", label: "Итоговый", html: finalHtml, chars: finalHtml.length });
    const rw = rewritePct(prot, joined);
    const linksOk = placeholderLayout(prot) === placeholderLayout(joined);
    const info = [
      { code: "test_variant", detail: `${VNAME[v]} · ${m} · $${st.cost.toFixed(4)} · токены ${st.inT}/${st.outT} · изменено слов ${rw}% · откатов ${st.rollback}/${st.chunks}${v === "B" || v === "E" ? ` · правок применено ${st.applied}, не найдено ${st.missed}` : ""}` },
      ...(linksOk ? [] : [{ code: "placeholders", detail: "ссылка переехала в другой абзац" }]),
      ...st.errors.slice(0, 3).map((e) => ({ code: "api_error", detail: e })),
    ];
    await prisma.deeplItem.create({ data: { jobId: job!.id, position, title: `${label} · ${baseTitle}`.slice(0, 250), sourceUrl: inp.sourceUrl, sourceHtml, finalHtml, stages: stages as Prisma.InputJsonValue, warnings: info as Prisma.InputJsonValue, status: "done", stage: "done", costUsd: st.cost, startedAt: new Date(), finishedAt: new Date() } });
    const row = [label, st.cost.toFixed(4), st.inT, st.outT, rw, overlapPct(sourceHtml, finalHtml, 5), st.rollback, st.applied, st.missed, linksOk ? "ok" : "MOVED", st.errors.length].join("\t");
    rows.push(row);
    console.log("ok", row);
  });
  console.log(["run", "$", "inT", "outT", "rewrite%", "ov5%", "rollback", "applied", "missed", "links", "errs"].join("\t"));
  console.log(rows.sort().join("\n"));
  process.exit(0);
})();
