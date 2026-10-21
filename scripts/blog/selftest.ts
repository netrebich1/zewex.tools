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
import { checkPostQuality } from "../../src/lib/blog/qualityCheck";
import { DEFAULT_PARAMS, type BlogOutline } from "../../src/lib/blog/types";
import type { BlogPhoto, BlogPost, BlogSection } from "@prisma/client";

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
  ok("post-review fixes");
}

console.log(`\n${n} checks passed`);
