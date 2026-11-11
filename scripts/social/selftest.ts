/**
 * Самопроверка «Соцсетей» без базы и без ИИ: сборка поста по лимитам, расписание, файл Metricool.
 * Запуск: npx tsx scripts/social/selftest.ts
 */
import { assemblePost, postLink, trimTo } from "@/lib/social/generate";
import { buildExport, DEFAULT_HEADER, headerFromTemplate, parseCsvLine, slotFor } from "@/lib/social/metricool";
import { parseUrls } from "@/lib/social/runs";
import { articleText } from "@/lib/social/article";
import { networkOf, parseSettings, type SocialPosts } from "@/lib/social/types";

let failed = 0;
const ok = (name: string, cond: boolean, info = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${info ? ` — ${info}` : ""}`);
};

const s = parseSettings({ networks: ["instagram", "threads", "x", "facebook"], schedule: { startDate: "2026-11-12", perDay: 3, fromHour: 9, toHour: 21 }, brand: "Beauty Daily" });

// Сборка поста
const x = networkOf("x")!;
const link = postLink("https://site.com/statya/", "x", true);
const long = "Очень длинное предложение о том, как выбрать пальто на зиму. ".repeat(8);
const px = assemblePost(x, long, ["пальто", "зима 2027"], link);
const xLen = px.text.length - link.length + 23;
ok("X: лимит 280 с учётом ссылки за 23", xLen <= 280, `${xLen}`);
ok("X: ссылка в конце", px.text.endsWith(link));
ok("X: обрезан", px.trimmed);
ok("utm", link.includes("utm_source=twitter") && link.includes("utm_medium=social"));
const ig = networkOf("instagram")!;
const pi = assemblePost(ig, "Зацепка.\n\nТекст со ссылкой https://evil.example/x внутри.", ["мода", "#Стиль", "мода"], null);
ok("Instagram: чужая ссылка вырезана", !pi.text.includes("http"));
ok("Instagram: хэштеги без повторов", pi.text.endsWith("#мода #Стиль"), pi.text.split("\n").pop());
ok("trimTo по предложению", trimTo("Первое. Второе предложение длинное. Третье", 40) === "Первое. Второе предложение длинное.", trimTo("Первое. Второе предложение длинное. Третье", 40));

// Ссылки
const u = parseUrls("https://a.com/x/\nb.com/y https://a.com/x мусор");
ok("parseUrls", u.urls.length === 2 && u.bad.length === 1, JSON.stringify(u));

// Текст статьи
const t = articleText("<html><body><nav>меню</nav><h1>Заголовок</h1><p>Абзац &amp; текст</p><h2>Раздел</h2><ul><li>пункт</li></ul><script>x()</script></body></html>");
ok("articleText", t.includes("# Заголовок") && t.includes("## Раздел") && t.includes("- пункт") && !t.includes("меню") && !t.includes("x()"), JSON.stringify(t));

// Расписание
const a = slotFor("item-a", 0, "instagram", s);
const b = slotFor("item-b", 3, "instagram", s);
const c = slotFor("item-a", 0, "x", s);
ok("расписание: первый день", a.date === "2026-11-12" && a.time >= "09:00:00" && a.time < "21:00:00", `${a.date} ${a.time}`);
ok("расписание: 4-я статья на второй день", b.date === "2026-11-13", b.date);
ok("расписание: сети одной статьи разнесены", c.time > a.time, `${a.time} → ${c.time}`);
ok("расписание: стабильно", slotFor("item-a", 0, "x", s).time === c.time);

// Файл Metricool
const posts: SocialPosts = {
  instagram: { text: "Пост, с запятой и \"кавычками\"\nвторая строка", images: ["https://site.com/1.jpg", "https://site.com/2.jpg"], alts: ["фото 1", ""] },
  x: { text: "Твит https://site.com/statya/", images: ["https://site.com/1.jpg"], alts: [""] },
  threads: { text: "", images: [], alts: [], skipped: "нет фото" },
};
const items = Array.from({ length: 60 }, (_, i) => ({ id: `it-${i}`, position: i, posts }));
const files = buildExport(DEFAULT_HEADER, items, s, "test");
ok("файлы: instagram 2 части по ≤50, x 2 части, threads нет", files.length === 4 && files.every((f) => f.rows <= 50) && !files.some((f) => f.name.includes("threads")), files.map((f) => `${f.name}`).join(", "));
const lines = files[0].data.replace(/^﻿/, "").split("\r\n");
const head = parseCsvLine(lines[0]);
ok("заголовок = шаблон", head.join("|") === DEFAULT_HEADER.join("|"));
// Перенос внутри текста — LF, записи разделены CRLF: запись остаётся одной строкой.
const rec = parseCsvLine(lines[1]);
const col = (name: string) => rec[head.indexOf(name)];
ok("строка: число колонок", rec.length === head.length, `${rec.length}/${head.length}`);
ok("строка: текст с кавычками и переносом", col("Text") === posts.instagram!.text, col("Text"));
ok("строка: флаги сетей", col("Instagram") === "TRUE" && col("Facebook") === "FALSE" && col("Pinterest") === "FALSE" && col("Twitter/X") === "FALSE");
ok("строка: дата и время", /^\d{4}-\d{2}-\d{2}$/.test(col("Date")) && /^\d{2}:\d{2}:00$/.test(col("Time")), `${col("Date")} ${col("Time")}`);
ok("строка: фото и alt", col("Picture Url 1") === "https://site.com/1.jpg" && col("Picture Url 2") === "https://site.com/2.jpg" && col("Picture Url 3") === "" && col("Alt text picture 1") === "фото 1");
ok("строка: тип поста, бренд, черновик", col("Instagram Post Type") === "POST" && col("Brand name") === "Beauty Daily" && col("Draft") === "FALSE");
ok("строка: First Comment пустой, не FALSE", col("First Comment Text") === "");

// Шаблон с другим порядком колонок
const custom = headerFromTemplate("﻿Date;Time;Text;Twitter;Instagram;Picture Url 1;Draft;Facebook;Threads;Brand name\n2026-01-01;10:00;x");
const cf = buildExport(custom, items.slice(0, 1), s, "t", "x")[0].data.replace(/^﻿/, "").split("\r\n");
const crow = parseCsvLine(cf[1]);
ok("свой шаблон: порядок колонок шаблона, флаг по синониму Twitter", custom[0] === "Date" && crow[custom.indexOf("Twitter")] === "TRUE" && crow[custom.indexOf("Instagram")] === "FALSE" && crow[custom.indexOf("Text")].startsWith("Твит"), crow.join(" | "));
let threw = false;
try { headerFromTemplate("a,b,c"); } catch { threw = true; }
ok("не шаблон — отказ", threw);

console.log(failed ? `\nОшибок: ${failed}` : "\nВсе проверки прошли");
process.exit(failed ? 1 : 0);
