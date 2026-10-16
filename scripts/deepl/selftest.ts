/**
 * Самотест чистых функций DeepL Articler (без сети и базы): защита разметки, восстановление, целостность, разбор H2.
 * Запуск: npx tsx scripts/deepl/selftest.ts
 */
import assert from "node:assert/strict";
import { checkIntegrity, chunkBySections, protectHtml, restoreHtml, countKeyword } from "../../src/lib/deepl/html";
import { parseHeadings } from "../../src/lib/deepl/edit";
import { parseSettings, describeSettings } from "../../src/lib/deepl/types";

const html = `<p>Вступ з <a href="https://x.ua/a">гарним анкором</a> і текстом.</p>
[caption id="attachment_1" width="1080"]<img src="https://x.ua/1.jpg" class="size-full" /> Підпис[/caption]
<h2 id="s1">Перший розділ</h2><p>Сукня міді на осінь 2026 — головне. Сукня міді пасує всім.</p>
<h2>Другий</h2><p>Текст <strong>жирний</strong>.</p><iframe src="https://youtube.com/x"></iframe>
<h2>Третій</h2><p>Ще текст.</p><h2>Четвертий</h2><p>Кінець.</p>`;

const { text, tokens } = protectHtml(html);
assert.ok(!text.includes("<a "), "ссылка спрятана");
assert.ok(!text.includes("<img"), "картинка спрятана");
assert.ok(!text.includes("[caption"), "шорткод спрятан");
assert.equal(tokens.length >= 5, true);
const back = restoreHtml(text, tokens, "UK");
assert.ok(back.includes('<a href="https://x.ua/a">гарним анкором</a>'), "ссылка вернулась байт в байт");
assert.ok(back.includes('<img src="https://x.ua/1.jpg" class="size-full" />'), "картинка вернулась");
assert.equal(checkIntegrity(html, back).fatal, false, "целостность после круга");
// модель потеряла картинку → фатально
const lost = text.replace(/<x-ph i="\d+"><\/x-ph>/, "");
assert.equal(checkIntegrity(text, lost).fatal, true, "потеря плейсхолдера фатальна");
assert.equal(chunkBySections(text, 3).length, 2, "4 H2 + вступ → 2 батча по 3 секции");
assert.equal(countKeyword(html, "сукня міді"), 2, "ключ считается по видимому тексту");

const answer = `H2 №1 (було: «Перший розділ»)
1) Варіант А
2) Варіант Б
3) Варіант В

H2 №2 (було: «Другий»)
1) Другий А
2) Другий Б
3) Другий В

РЕКОМЕНДОВАНИЙ НАБІР:
1. Мохерова міді кольору какао для холодних ранків
2. Другий Б
3. Третій новий
4. Четвертий новий`;
const h = parseHeadings(answer, 4);
assert.deepEqual(h, ["Мохерова міді кольору какао для холодних ранків", "Другий Б", "Третій новий", "Четвертий новий"]);
assert.deepEqual(parseHeadings("1. Один\n2. Два", 2), ["Один", "Два"]);

const s = parseSettings({ translateSteps: [{ source: "uk", target: "en-gb" }, { source: "EN", target: "DE" }, { source: "DE", target: "UK" }], headings: { enabled: true }, postEdit: { enabled: true }, seo: { enabled: true, minPct: 25, maxPct: 70 } });
assert.equal(describeSettings(s), "UK → EN-GB → DE → UK · H2 · постредактура · ключи 25–70%");
console.log("deepl selftest ok");
