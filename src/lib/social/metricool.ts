/**
 * Файл импорта Metricool (Планировщик → Импорт CSV). Metricool требует колонки своего шаблона без добавлений, удалений и
 * перестановок, поэтому строка заголовков берётся из шаблона, загруженного в настройках инструмента (скачивается в
 * Metricool: Календарь → меню → Import CSV → Download template). Пока шаблон не загружен — заголовки из справки Metricool.
 * Значения кладутся по названию колонки (без учёта регистра и пробелов), незнакомые колонки остаются пустыми.
 * Одна строка = один пост в одну сеть: тексты под каждую сеть разные.
 * Дата YYYY-MM-DD и время HH:MM:SS — этот формат выбрать в выпадающем списке при импорте; время — по часовому поясу бренда.
 */
import { NETWORKS, networkOf, ROWS_PER_FILE, type NetworkKey, type SocialPost, type SocialPosts, type SocialSettings } from "./types";

const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

/** Заголовки из справки Metricool (help.metricool.com, статья об импорте CSV). Точный порядок — только в шаблоне из аккаунта. */
export const DEFAULT_HEADER: string[] = [
  "Text", "Date", "Time", "Draft", "Facebook", "Twitter/X", "LinkedIn", "GBP", "Instagram", "Pinterest", "TikTok", "YouTube", "Threads", "Bluesky",
  ...range("Picture Url", 10), ...range("Alt text picture", 10), "Document title", "Shortener", "Video Thumbnail Url", "Video Cover Frame",
  "Twitter/X Can reply", "Twitter/X Type", "Twitter/X Poll Duration minutes", ...range("Twitter/X Poll Option", 4),
  "Pinterest Board", "Pinterest Pin Title", "Pinterest Pin Link", "Pinterest Pin New Format",
  "Instagram Post Type", "Instagram Show Reel On Feed",
  "YouTube Video Title", "YouTube Video Type", "YouTube Video Privacy", "YouTube video for kids", "YouTube Video Category", "YouTube Video Tags", "YouTube Playlist", "YouTube Notify Subscribers",
  "GBP Post Type", "Facebook Post Type", "Facebook Title", "First Comment Text",
  "TikTok Title", "TikTok disable comments", "TikTok disable duet", "TikTok disable stitch", "TikTok Post Privacy", "TikTok Branded Content", "TikTok Your Brand", "TikTok Auto Add Music", "TikTok Photo Cover Index",
  "LinkedIn Type", "LinkedIn Poll Question", ...range("LinkedIn Poll Option", 4), "LinkedIn Poll Duration", "LinkedIn Show link preview", "LinkedIn Images as Carousel",
  "Threads Reply Control", "Threads Is Spoiler", "Threads Post Type", "Brand name",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Разбор одной строки CSV (запятая или точка с запятой, кавычки по RFC 4180). */
export function parseCsvLine(line: string): string[] {
  const delim = (line.match(/;/g)?.length ?? 0) > (line.match(/,/g)?.length ?? 0) ? ";" : ",";
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Заголовки из загруженного шаблона: первая непустая строка файла. Проверяем, что это действительно шаблон Metricool. */
export function headerFromTemplate(fileText: string): string[] {
  const first = fileText.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim());
  if (!first) throw new Error("Файл пустой");
  const header = parseCsvLine(first).filter((c, i, a) => c || i < a.length - 1);
  const keys = header.map(norm);
  if (header.length < 10 || !keys.includes("text") || !keys.includes("date")) {
    throw new Error("Это не похоже на шаблон Metricool: в первой строке нет колонок Text и Date. Скачайте шаблон в Metricool: Календарь → Import CSV → Download template (язык интерфейса — английский).");
  }
  return header;
}

const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export type ExportRow = { net: NetworkKey; post: SocialPost; date: string; time: string };

function rowValues(header: string[], r: ExportRow, s: SocialSettings): string[] {
  const net = networkOf(r.net)!;
  const flagCols = new Set(net.column.map(norm));
  const allFlags = new Set(NETWORKS.flatMap((n) => n.column).concat(["Pinterest", "YouTube"]).map(norm));
  const byName: Record<string, string> = {
    text: r.post.text,
    date: r.date,
    time: r.time,
    draft: s.draft ? "TRUE" : "FALSE",
    brandname: s.brand,
    firstcommenttext: r.post.firstComment ?? "",
    shortener: "FALSE",
  };
  if (r.net === "instagram") byName.instagramposttype = "POST";
  if (r.net === "facebook") byName.facebookposttype = "POST";
  if (r.net === "gbp") byName.gbpposttype = "POST";
  if (r.net === "x") byName.twitterxtype = byName.twittertype = byName.xtype = "POST";
  if (r.net === "linkedin") { byName.linkedintype = "POST"; byName.linkedinimagesascarousel = r.post.images.length > 1 ? "TRUE" : "FALSE"; }
  if (r.net === "threads") byName.threadsposttype = "POST";
  if (r.net === "ig_reel") { byName.instagramposttype = "REEL"; byName.instagramshowreelonfeed = "TRUE"; }
  if (r.net === "fb_reel") byName.facebookposttype = "REEL";
  if (r.net === "tiktok_video") { byName.tiktokpostprivacy = "PUBLIC_TO_EVERYONE"; byName.tiktokdisablecomments = "FALSE"; byName.tiktokdisableduet = "FALSE"; byName.tiktokdisablestitch = "FALSE"; }
  if (r.net === "yt_short") {
    byName.youtubevideotitle = (r.post.title ?? "").slice(0, 100);
    byName.youtubevideotype = "SHORT";
    byName.youtubevideoprivacy = "PUBLIC";
    byName.youtubevideoforkids = "FALSE";
    byName.youtubevideocategory = s.ytCategory;
    byName.youtubevideotags = (r.post.tags ?? []).join(",").slice(0, 450);
    byName.youtubenotifysubscribers = "TRUE";
  }
  if (r.post.video && r.post.poster) byName.videothumbnailurl = r.post.poster;
  if (r.net === "tiktok") { byName.tiktokpostprivacy = "PUBLIC_TO_EVERYONE"; byName.tiktokautoaddmusic = "TRUE"; }
  r.post.images.slice(0, 10).forEach((u, i) => {
    byName[`pictureurl${i + 1}`] = u;
    byName[`alttextpicture${i + 1}`] = (r.post.alts[i] ?? "").slice(0, 300);
  });
  return header.map((h) => {
    const k = norm(h);
    if (flagCols.has(k)) return "TRUE";
    if (allFlags.has(k)) return "FALSE";
    return byName[k] ?? "";
  });
}

export function buildCsv(header: string[], rows: ExportRow[], s: SocialSettings): string {
  // BOM: Metricool ждёт UTF-8, а без метки Excel при просмотре ломает кириллицу.
  return "﻿" + [header.map(esc).join(","), ...rows.map((r) => rowValues(header, r, s).map(esc).join(","))].join("\r\n") + "\r\n";
}

/* ---------- Расписание ---------- */

const pad = (n: number) => String(n).padStart(2, "0");

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Псевдослучайное число 0..1 от строки: время постов не выглядит расставленным по линейке, но не меняется от выгрузки к выгрузке. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * День и время поста: статья №position выходит в день start + position/perDay; её место в окне дня — по порядку,
 * со сдвигом до трети интервала; сети одной статьи разнесены на 7–20 минут, чтобы не выходили секунда в секунду.
 */
export function slotFor(itemId: string, position: number, net: NetworkKey, s: SocialSettings): { date: string; time: string } {
  const { startDate, perDay, fromHour, toHour } = s.schedule;
  const date = addDays(startDate, Math.floor(position / perDay));
  const span = (toHour - fromHour) * 60;
  const step = span / perDay;
  const base = fromHour * 60 + (position % perDay) * step + hash01(itemId) * step * 0.33;
  const netIdx = Math.max(0, s.networks.indexOf(net));
  const minute = Math.min(toHour * 60 - 1, Math.floor(base + netIdx * (7 + hash01(itemId + net) * 13)));
  return { date, time: `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}:00` };
}

export type ExportItem = { id: string; position: number; posts: SocialPosts };
export type ExportFile = { name: string; data: string; rows: number };

/** Файлы выгрузки: по сетям, не больше ROWS_PER_FILE строк в файле. Пустые и пропущенные посты не выгружаются. */
export function buildExport(header: string[], items: ExportItem[], s: SocialSettings, slug: string, only?: NetworkKey): ExportFile[] {
  const files: ExportFile[] = [];
  for (const net of s.networks) {
    if (only && net !== only) continue;
    const rows: ExportRow[] = [];
    for (const it of items) {
      const post = it.posts[net];
      if (!post || post.skipped || !post.text.trim()) continue;
      rows.push({ net, post, ...slotFor(it.id, it.position, net, s) });
    }
    rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    for (let i = 0; i < rows.length; i += ROWS_PER_FILE) {
      const part = rows.slice(i, i + ROWS_PER_FILE);
      const n = rows.length > ROWS_PER_FILE ? `_${Math.floor(i / ROWS_PER_FILE) + 1}` : "";
      files.push({ name: `metricool_${slug}_${net}${n}_${part.length}.csv`, data: buildCsv(header, part, s), rows: part.length });
    }
  }
  return files;
}
