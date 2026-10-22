/**
 * Самопроверка инфо-статей без ИИ и базы: чистка HTML секций, таблицы с <thead>, сборка HTML, JSON-LD, проверка качества.
 * Запуск (на сервере в /root/zewex-check): npx tsx scripts/blog/selftest.ts
 */
import assert from "node:assert/strict";
import { allowedTags } from "../../src/lib/blog/blocks";
import { assemblePostHtml } from "../../src/lib/blog/html";
import { buildJsonLd, extractSteps } from "../../src/lib/blog/schema";
import { cleanHeading, cleanSectionHtml, countWords, ensureTableHead, sanitizeHtml, searchPhraseOf, varyTipLabels } from "../../src/lib/blog/text";
import { titleCase } from "../../worker/blog/stages/meta";
import { shopPageSignal } from "../../worker/blog/stages/photoFilter";
import { junkPhotoSignal, offPuttingSignal } from "../../src/lib/blog/photo/ratePrompt";
import { applyScenario, deferredFormatOf, pickScenario } from "../../src/lib/blog/scenarios";
import { enforceStructure, fixLeadingNumber, splitItems } from "../../src/lib/blog/structure";
import { inventedExperience } from "../../src/lib/blog/qualityCheck";
import type { BlogBrief } from "../../src/lib/blog/types";
import { isoDuration, judgeDecision, prefilterVideos, videoEmbedHtml, videoObject, type VideoCandidate } from "../../src/lib/blog/video";
import { checkPostQuality } from "../../src/lib/blog/qualityCheck";
import { DEFAULT_PARAMS, type BlogOutline } from "../../src/lib/blog/types";
import type { BlogPhoto, BlogPost, BlogSection } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { installNodeCanvasHost } from "../../src/lib/pins/canvas/host.node";
import { getHost } from "../../src/lib/pins/canvas/host";
import { normalizeOverlayText, renderPinOverlay } from "../../src/lib/blog/pinOverlay";
import { buildImagePrompt, panelLayout, stepsOf } from "../../worker/blog/stages/aiImages";

let n = 0;
const ok = (name: string) => { n++; console.log(`ok ${n} - ${name}`); };

// 1. sanitizeHtml: лишние теги снимаются, h2 → h3, markdown-жирный → strong, атрибуты удаляются
{
  const raw = `<div class="x"><h2>Inside</h2><p style="a">Text with **bold** and <em>em</em> <a href="https://x.com/a">link</a></p><script>bad()</script></div>`;
  const out = sanitizeHtml(raw, ["p", "h3", "strong"]);
  assert.ok(!/<div|<script|<em|style=/.test(out), out);
  assert.ok(/<h3>Inside<\/h3>/.test(out), out);
  assert.ok(/<strong>bold<\/strong>/.test(out), out);
  assert.ok(!/<a /.test(out), "links stripped when not allowed");
  const withLink = sanitizeHtml(raw, ["p"], { allowLinks: true });
  assert.ok(/<a href="https:\/\/x\.com\/a" target="_blank" rel="nofollow noopener noreferrer">link<\/a>/.test(withLink), withLink);
  ok("sanitizeHtml");
}

// 2. ensureTableHead: первая строка становится шапкой; таблица без строк удаляется
{
  const t = `<table><tr><td>Type</td><td>Best for</td></tr><tr><td>Velcro</td><td>Volume</td></tr></table>`;
  const out = ensureTableHead(t);
  assert.ok(/<thead><tr><th>Type<\/th><th>Best for<\/th><\/tr><\/thead><tbody><tr><td>Velcro/.test(out), out);
  assert.equal(ensureTableHead(`<table></table>`), "");
  ok("ensureTableHead");
}

// 3. cleanSectionHtml для блока steps: <ol> остаётся, голый текст оборачивается, тире чинятся
{
  const raw = `Intro line without tags\n\n<ol><li><strong>Step 1:</strong> Wash hair — then dry.</li><li><b>Step 2:</b> Section.</li></ol>`;
  const out = cleanSectionHtml(raw, allowedTags("steps"), { usSpelling: true });
  assert.ok(/<p>Intro line without tags<\/p>/.test(out), out);
  assert.ok(/<ol><li><strong>Step 1:<\/strong>/.test(out), out);
  assert.ok(/<strong>Step 2:<\/strong>/.test(out), "b → strong");
  assert.ok(!/—/.test(out), "em dash removed");
  ok("cleanSectionHtml steps");
}

// 4. Сборка HTML: порядок блоков, картинки с alt, FAQ, заключение, JSON-LD
{
  const faq = [{ question: "Can I sleep in rollers?", answer: "<p>Yes, foam rollers are made for it.</p>" }];
  const sections = [
    { position: 1, kind: "steps", heading: "How to Set the Rollers", html: `<ol><li><strong>Step 1:</strong> Dry hair to 80 percent.</li><li><strong>Step 2:</strong> Roll away from the face.</li></ol>`, photo: { url: "https://zewex.tools/files/blog/p/photos/a.jpg", width: 600, height: 800, sourcePageUrl: "https://example.com/post", sourceDomain: "example.com", altText: "woman rolling hair", position: 2 } },
    { position: 2, kind: "comparison_table", heading: "Which Roller Type to Pick", html: `<table><thead><tr><th>Type</th><th>Best for</th></tr></thead><tbody><tr><td>Velcro</td><td>Volume</td></tr></tbody></table>`, photo: null },
  ];
  const jsonLd = buildJsonLd({ h1: "How to Use Hair Rollers", description: "A guide.", images: ["https://zewex.tools/files/blog/p/photos/h.jpg"], faq, sections });
  const built = assemblePostHtml({
    introHtml: "<p>Rollers give volume without heat.</p>", hero: { url: "https://zewex.tools/files/blog/p/photos/h.jpg", width: 600, height: 900, sourceDomain: "example.com", sourcePageUrl: "https://example.com/h", altText: "hair rollers set", position: 1 },
    takeawaysHtml: "<ul><li>Dry hair first.</li><li>Roll away from the face.</li></ul>", sections, faq, conclusionHtml: "<p>Start with velcro rollers.</p>", disclaimerHtml: null, closing: null,
    keyword: "how to use hair rollers", caption: { mode: "domain_link", template: "{credit} {domain}" }, jsonLd,
  });
  const h = built.html;
  const pos = (re: RegExp) => { const m = h.search(re); assert.ok(m >= 0, `missing ${re}`); return m; };
  assert.ok(pos(/Rollers give volume/) < pos(/photos\/h\.jpg/), "intro before hero");
  assert.ok(pos(/photos\/h\.jpg/) < pos(/Key Takeaways/), "hero before takeaways");
  assert.ok(pos(/Key Takeaways/) < pos(/<h2 id="[^"]+">How to Set the Rollers<\/h2>/), "takeaways before first section");
  assert.ok(pos(/How to Set the Rollers<\/h2>/) < pos(/photos\/a\.jpg/), "section photo right after H2");
  assert.ok(pos(/Frequently Asked Questions/) < pos(/Final Thoughts/), "FAQ before conclusion");
  assert.ok(/alt="hair rollers set/.test(h) && /alt="woman rolling hair/.test(h), "alt texts present");
  assert.ok(/<table style="width:100%/.test(h) && /<th style=/.test(h), "table styled");
  assert.ok(/application\/ld\+json/.test(h), "json-ld inline");
  assert.ok(/Photo credit:|Image credit:|Source:|Via|Courtesy of:/.test(h), "photo credit");
  assert.equal(built.toc.length, 4);
  assert.ok(built.wordCount > 20);
  const graph = (jsonLd as { "@graph": Array<{ "@type": string }> })["@graph"].map((g) => g["@type"]);
  assert.deepEqual(graph, ["Article", "FAQPage", "HowTo"]);
  assert.equal(extractSteps(sections).length, 2);
  assert.equal(extractSteps(sections)[0].name, "Step 1");
  ok("assemblePostHtml + JSON-LD");
}

// 5. Проверка качества: ловит пустой H2, картинку в секции, отсутствие дисклеймера на YMYL, короткую секцию; чинит таблицу без thead
{
  const post = { id: "p", keyword: "how to get rid of skin tags", introHtml: "<p>" + "word ".repeat(50) + "</p>", conclusionHtml: "<p>" + "word ".repeat(40) + "</p>", takeawaysHtml: null, disclaimerHtml: null, faq: [{ question: "q1", answer: "<p>a</p>" }, { question: "q2", answer: "<p>b</p>" }] } as unknown as BlogPost;
  const outline = { faq: { enabled: true, count: 4, questions: [] }, disclaimer: true } as unknown as BlogOutline;
  const sec = (position: number, kind: string, heading: string, html: string, targetWords = 100): BlogSection => ({ id: `s${position}`, postId: "p", position, kind, heading, html, wordCount: countWords(html), status: "written", error: null, brief: { targetWords }, slotKey: null, createdAt: new Date(), updatedAt: new Date() });
  const sections = [
    sec(1, "why_it_happens", "Why Skin Tags Form", "<p>" + "fact ".repeat(120) + "</p>"),
    sec(2, "comparison_table", "", `<table><tr><td>Method</td><td>Best for</td></tr><tr><td>Cryo</td><td>Small</td></tr></table><p>${"cell ".repeat(60)}</p>`),
    sec(3, "tips", "Tips", `<img src="x.jpg"><p>${"tip ".repeat(100)}</p>`),
    sec(4, "aftercare", "Aftercare", "<p>short</p>"),
  ];
  const photos = [{ id: "ph", postId: "p", slotKey: "hero", altText: "", description: "a skin tag close-up", excluded: false } as unknown as BlogPhoto];
  const r = checkPostQuality(post, outline, DEFAULT_PARAMS, sections, photos);
  assert.ok(!r.ok);
  assert.ok(r.problems.some((p) => /Секция 2: пустой заголовок/.test(p)), r.problems.join(" | "));
  assert.ok(r.problems.some((p) => /Секция 4: всего/.test(p)), "short section");
  assert.ok(r.problems.some((p) => /Нет дисклеймера/.test(p)), "disclaimer");
  assert.ok(r.patch.sections.some((p) => p.id === "s2" && /<thead>/.test(p.html)), "thead fixed");
  assert.ok(r.patch.sections.some((p) => p.id === "s3" && !/<img/.test(p.html)), "img stripped");
  assert.ok(r.patch.photos.some((p) => p.id === "ph" && p.altText === "a skin tag close-up"), "alt from description");
  ok("checkPostQuality");
}

// 6. Правки после первой статьи: ключ из заголовка, Title Case, метки советов, заголовки, магазины
{
  assert.equal(searchPhraseOf("How to Use Hair Rollers: The Ultimate Step-by-Step Guide"), "how to use hair rollers");
  assert.equal(searchPhraseOf("how to clean a hairbrush"), "how to clean a hairbrush");
  assert.equal(titleCase("how to use hair rollers: the ultimate step-by-step guide"), "How to Use Hair Rollers: The Ultimate Step-by-Step Guide");
  const tips = varyTipLabels(["<p><strong>My tip:</strong> a</p><p><strong>My tip:</strong> b</p>", "<p><strong>My tip:</strong> c</p><p><strong>My tip:</strong> d</p>"]);
  assert.equal((tips.join("").match(/My tip:/g) || []).length, 2);
  assert.equal(cleanHeading("Ready for Gorgeous Curls? Here’s the Quick Scoop!"), "Ready for Gorgeous Curls?");
  assert.equal(cleanHeading("Don't Make These Common Roller Blunders!"), "Don't Make These Common Roller Blunders");
  assert.ok(shopPageSignal("https://www.gosupps.com/44pcs-metal-alligator-hair-clips.html", "44pcs Metal Clips"));
  assert.ok(shopPageSignal("https://shop.example.com/products/rollers-set", ""));
  assert.equal(shopPageSignal("https://www.vogue.com/article/self-gripping-curlers-how-to", "How to use self-gripping curlers"), null);
  assert.ok(shopPageSignal("https://condenaststore.com/featured/head-full-of-hair-rollers-lionel-kazan.html", ""));
  assert.equal(shopPageSignal("https://www.popsugar.com/beauty/best-hot-rollers-49346499", "Best Hot Rollers"), null);
  assert.ok(offPuttingSignal("A young woman with a swollen face after an allergic reaction to hair dye"));
  assert.ok(offPuttingSignal("close-up of a red rash on the forehead"));
  assert.equal(offPuttingSignal("Woman gently wiping her hairline with a cotton pad and micellar water"), null);
  assert.equal(offPuttingSignal("Hairbrush soaking in a bowl of soapy water"), null);
  ok("post-review fixes");
}

// 7. Плашка с текстом: кадр целиком (ширина 1000, высота = фото + плашка), разные варианты; data-pin-media в HTML
async function overlayCheck() {
  installNodeCanvasHost(process.env.BLOG_FONTS || undefined);
  const host = getHost();
  const c = host.createCanvas(600, 900);
  const g = c.getContext("2d");
  g.fillStyle = "#c9a27e"; g.fillRect(0, 0, 600, 900); g.fillStyle = "#6b4b33"; g.fillRect(100, 150, 400, 600);
  const photo = await host.encodeJpeg(c, 0.9);
  assert.equal(normalizeOverlayText({ title: "x" }), null);
  assert.deepEqual(normalizeOverlayText({ title: "“Roll Hair Away From Your Face.”", kicker: "Step by step!" }), { title: "Roll Hair Away From Your Face", kicker: "Step by step" });
  const variants = new Set<string>();
  for (const seed of ["a1", "b2", "c3", "d4", "e5", "f6"]) {
    const r = await renderPinOverlay(photo, { title: "How to Use Hair Rollers for Bouncy Curls", kicker: "Step by step", domain: "women-club.online" }, seed);
    assert.equal(r.width, 1000);
    assert.ok(r.height >= 1300 + 150, `photo kept whole + band: ${r.height}`);
    assert.ok(r.bytes.length > 10_000);
    variants.add(`${r.variant.place}/${r.variant.style}/${r.variant.palette}`);
    if (process.env.BLOG_OVERLAY_OUT) writeFileSync(`${process.env.BLOG_OVERLAY_OUT}/overlay-${seed}.jpg`, r.bytes);
  }
  assert.ok(variants.size >= 3, `variants: ${[...variants].join(", ")}`);
  const built = assemblePostHtml({ introHtml: "<p>Intro text here.</p>", hero: { url: "https://x.test/a.jpg", width: 600, height: 900, altText: "rollers", pinMedia: "https://x.test/a.pin.jpg" }, takeawaysHtml: null, sections: [], faq: [], conclusionHtml: "<p>End.</p>", disclaimerHtml: null, closing: null, keyword: "how to use hair rollers", caption: { mode: "none", template: "" } as never, jsonLd: null });
  assert.ok(/<img data-pin-media="https:\/\/x\.test\/a\.pin\.jpg" src="https:\/\/x\.test\/a\.jpg"/.test(built.html), built.html.slice(0, 400));
  ok("pin overlay");
}

// 8. ИИ-картинка шагов: шаги из <ol>, раскладка панелей, промт без текста
function aiStepsCheck() {
  const html = "<p>Intro</p><ol><li><strong>Section your hair:</strong> Split it.</li><li><strong>Roll:</strong> Roll up.</li><li><strong>Set:</strong> Wait.</li></ol><ul><li>x</li></ul>";
  assert.deepEqual(stepsOf(html), ["Section your hair: Split it.", "Roll: Roll up.", "Set: Wait."]);
  assert.deepEqual(panelLayout(4, 1024, 1536)[3], { x: 512, y: 768, w: 512, h: 768 });
  assert.deepEqual(panelLayout(3, 1024, 1536)[2], { x: 0, y: 1024, w: 1024, h: 512 });
  const pr = buildImagePrompt({ subject: "a woman in her 30s", setting: "bathroom", panels: [{ step: 1, shows: "a" }, { step: 2, shows: "b" }, { step: 3, shows: "c" }, { step: 4, shows: "d" }] }, "Set rollers");
  assert.ok(/2x2 grid/.test(pr) && /no text/i.test(pr) && /Panel 4 \(bottom-right\)/.test(pr), pr);
  ok("ai step image helpers");
}

// 9. Видео: правила оценки, фильтр, встраивание, VideoObject
function videoCheck() {
  const j = { relevance: 9, quality: 8, startAt: 55, covers: ["steps"], redFlags: [] as string[], verdict: "embed", why: "clear tutorial" };
  assert.equal(judgeDecision(j, { videoFirst: false, words: 900 }).ok, true);
  assert.equal(judgeDecision({ ...j, redFlags: ["mostly a product ad or haul"] }, { videoFirst: false, words: 900 }).ok, false);
  assert.equal(judgeDecision({ ...j, redFlags: ["heavy sponsor reads"] }, { videoFirst: false, words: 900 }).ok, false);
  assert.equal(judgeDecision({ ...j, redFlags: ["long rambling intro"] }, { videoFirst: false, words: 900 }).ok, true);
  assert.equal(judgeDecision({ ...j, relevance: 7 }, { videoFirst: false, words: 900 }).ok, false);
  assert.equal(judgeDecision(j, { videoFirst: true, words: 300 }).ok, false);
  const base: VideoCandidate = { id: "dOqutR6aY3Y", title: "Easy Hair Rollers Tutorial", channel: "Tina Engeo", views: 1320795, sec: 484, date: "2023-05-01", shorts: false, judge: j };
  const pre = prefilterVideos([base, { ...base, id: "s1", shorts: true }, { ...base, id: "s2", sec: 40 }, { ...base, id: "s3", views: 100 }]);
  assert.deepEqual(pre.map((v) => v.id), ["dOqutR6aY3Y"]);
  const html = videoEmbedHtml(base, "post-1");
  assert.ok(/youtube-nocookie\.com\/embed\/dOqutR6aY3Y\?start=55/.test(html) && /loading="lazy"/.test(html) && /Tina Engeo/.test(html) && /starts at 0:55/.test(html), html);
  assert.equal(isoDuration(484), "PT8M4S");
  const vo = videoObject(base);
  assert.equal(vo["@type"], "VideoObject");
  assert.equal(vo.duration, "PT8M4S");
  ok("video rules + embed");
}

// 10. Сценарии, выдуманный опыт, «не фото», место ИИ-картинки шагов
function scenarioCheck() {
  const b = (intent: string, ymyl = false) => ({ intent, ymyl, topicDomain: "hair", audience: "", summary: "", facts: [], dos: [], donts: [], mistakes: [], safety: [], materials: [], timeline: "", questions: [] } as unknown as BlogBrief);
  // Формат по теме статьи (реальные темы из таблицы «Инфо — темы»)
  const T = (topic: string, kw: string, intent = "other", ymyl = false) => pickScenario("auto", b(intent, ymyl), kw, topic)!;
  // Подборки рецептов и идей отложены (владелец 2026-10-23): в определение не попадают, запуск их пропускает
  assert.equal(deferredFormatOf("31 Easy Soup Recipes Even Picky Eaters Love")?.key, "roundup_recipes");
  assert.equal(deferredFormatOf("30 Pantry Organization Ideas to Keep Everything in Order")?.key, "roundup_ideas");
  assert.equal(deferredFormatOf("25 Clear Skin Tips That Actually Work"), null);
  assert.ok(!T("31 Easy Soup Recipes Even Picky Eaters Love", "soup recipes").scenario.key.startsWith("roundup"));
  assert.ok(!T("30 Easy High Protein Meals for Busy Days", "High protein").scenario.key.startsWith("roundup"));
  assert.ok(!T("30 Pantry Organization Ideas to Keep Everything in Order", "pantry organization").scenario.key.startsWith("roundup"));
  assert.equal(T("400 Interesting Questions to Ask Anyone", "questions to ask").scenario.key, "big_list");
  assert.equal(T("400 Interesting Questions to Ask Anyone", "questions to ask").n, 400);
  assert.equal(T("51 Positive Affirmations for Women to Change Your Mindset", "positive affirmations").scenario.key, "big_list");
  assert.equal(T("250+ Bucket List Ideas You Won't Regret", "bucket list").scenario.key, "big_list");
  assert.equal(T("25 Clear Skin Tips That Actually Work", "Clear skin").scenario.key, "numbered");
  assert.equal(T("25 Clear Skin Tips That Actually Work", "Clear skin").n, 25);
  assert.equal(T("10 Signs You're Low in Vitamin D (and What to Do)", "Vitamin d", "other", true).scenario.key, "numbered");
  assert.equal(T("25 Best Foods for Gut Health", "Gut health").scenario.key, "numbered");
  assert.equal(T("Quick 10-Minute At-Home Ab Workout for Women", "Ab workout").scenario.key, "workout");
  assert.equal(T("7-Day Keto Diet Meal Plan for Beginners", "keto diet").scenario.key, "plan");
  assert.equal(T("Easy Homemade Granola Recipe", "granola recipe").scenario.key, "recipe");
  assert.equal(T("How to Make Homemade Lotion (Easy Shea Butter Recipe)", "lotion").scenario.key, "recipe");
  assert.equal(T("How to Make a Vision Board in 30 Minutes (Step-by-Step)", "vision board").scenario.key, "how_to_video");
  assert.equal(T("When and How to Use Toner on Your Face", "toner", "how_to").scenario.key, "how_to_video");
  assert.equal(T("The 5 Love Languages Explained (and How to Use Them)", "love languages").scenario.key, "explainer");
  assert.equal(T("", "which hair roller", "which").scenario.key, "comparison");
  assert.equal(T("", "how to curl hair", "how_to").scenario.key, "how_to_video");
  assert.equal(pickScenario("numbered", b("how_to"), "x", "")!.auto, false);
  assert.equal(pickScenario("manual", b("how_to"), "x"), null);
  // Здоровье — надстройка над форматом
  const p = applyScenario({ ...DEFAULT_PARAMS, aiImages: { mode: "steps", max: 2, quality: "medium" } }, T("", "how to remove a skin tag", "how_to", true).scenario, true);
  assert.equal(p.source, "research"); assert.equal(p.video.embed, "off"); assert.equal(p.aiImages.mode, "off"); assert.equal(p.blocks.disclaimer, "always");
  const v = applyScenario({ ...DEFAULT_PARAMS, aiImages: { mode: "steps", max: 2, quality: "medium" } }, T("", "how to curl hair", "how_to").scenario);
  assert.equal(v.source, "video"); assert.equal(v.aiImages.mode, "steps");
  // Каркас: число пунктов, фото у пунктов подборки, распределение большого списка, число в H1
  const sec = (kind: string, i: number, image = false) => ({ position: i, kind, heading: `Item ${i}`, keyPoints: [], targetWords: 80, image: image ? { query: "q" } : null });
  const r1 = enforceStructure([sec("quick_answer", 1), ...Array.from({ length: 30 }, (_, i) => sec("list_item", i + 2)), sec("mistakes", 32)], "roundup", 25, "roundup_recipes");
  assert.equal(r1.count, 25); assert.ok(r1.sections.filter((s) => s.kind === "list_item").every((s) => s.image), "every roundup item has a photo");
  assert.equal(r1.sections[0].kind, "quick_answer"); assert.equal(r1.sections.length, 26);
  const r2 = enforceStructure([sec("list_group", 1), sec("list_group", 2), sec("list_group", 3)], "big_list", 100);
  assert.deepEqual(splitItems(100, 3), [34, 33, 33]); assert.ok(/exactly 34 items/.test(r2.sections[0].notes ?? ""));
  assert.equal(fixLeadingNumber("31 Easy Soup Recipes Even Picky Eaters Love", 25), "25 Easy Soup Recipes Even Picky Eaters Love");
  assert.equal(fixLeadingNumber("How to Use Toner", 25), "How to Use Toner");
  assert.ok(inventedExperience("<p>I've tried both methods, and once you learn…</p>"));
  assert.ok(inventedExperience("the tips I've learned from trying it at home"));
  assert.equal(inventedExperience("<p><strong>My tip:</strong> practice on a cold iron first.</p>"), null);
  assert.ok(junkPhotoSignal("Woman curling hair; watermark ABlossomingLife.com in the corner"));
  assert.ok(junkPhotoSignal("A 2x2 grid of curl results"));
  assert.ok(junkPhotoSignal("Heat-resistant gloves and clips in their packaging"));
  assert.equal(junkPhotoSignal("Woman twisting a flat iron through a section of brown hair"), null);
  const built = assemblePostHtml({ introHtml: "<p>Intro text here for the article.</p>", hero: null, takeawaysHtml: null,
    sections: [{ position: 1, kind: "steps", heading: "Steps", html: "<p>Before you start.</p><ol><li>A</li><li>B</li><li>C</li></ol><p>After.</p>", photo: null, stepsPhoto: { url: "https://x.test/ai.jpg", width: 1024, height: 1536, altText: "steps" } }],
    faq: [], conclusionHtml: "<p>End.</p>", disclaimerHtml: null, closing: null, keyword: "how to curl hair", caption: { mode: "none", template: "" } as never, jsonLd: null });
  assert.ok(built.html.indexOf("ai.jpg") < built.html.indexOf("<ol"), "step image before the list when text precedes it");
  ok("scenarios + guards");
}

overlayCheck().then(aiStepsCheck).then(videoCheck).then(scenarioCheck).then(() => console.log(`\n${n} checks passed`)).catch((e) => { console.error(e); process.exit(1); });
