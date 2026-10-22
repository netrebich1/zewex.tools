/**
 * Видео YouTube в инфо-статье (этап `video`, worker/blog/stages/video.ts).
 * Подбор по СОДЕРЖАНИЮ, а не по названию: выдача YouTube (DataForSEO) → мягкий фильтр по метаданным → проверка встраивания
 * (бесплатный oEmbed) → субтитры (DataForSEO video_subtitles) → ИИ сравнивает субтитры с темой → жёсткие правила в коде.
 * Скриншоты из чужих видео не делаем: для этого нужно скачивать файл (против правил YouTube), кадр — копия чужой работы
 * (риск DMCA на сайте и в пинах); встраивание лицензировано через плеер YouTube.
 * Встраивание: youtube-nocookie, loading="lazy", старт с нужной секунды, подпись автора; VideoObject в JSON-LD.
 */
const escapeHtml = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type VideoJudge = {
  relevance: number;
  quality: number;
  startAt: number;
  covers: string[];
  redFlags: string[];
  verdict: string;
  why: string;
};

export type VideoCandidate = {
  id: string;
  title: string;
  channel: string;
  views: number;
  sec: number;
  date: string;
  shorts: boolean;
  thumbnail?: string;
  embeddable?: boolean;
  transcriptWords?: number;
  judge?: VideoJudge;
  /** embed — прошёл правила; reject — нет (reason) */
  decision?: "embed" | "reject";
  reason?: string;
};

/** Метод из видео для режима «статья по видео» (дополняет бриф исследования, не заменяет его). */
export type VideoBrief = {
  steps: string[];
  tips: string[];
  mistakes: string[];
  notCovered: string[];
};

export type BlogVideoState = {
  /** что просили в рецепте и что вышло */
  source: "research" | "video";
  embed: "off" | "auto";
  videoFirst: boolean;
  note?: string;
  candidates: VideoCandidate[];
  chosen: VideoCandidate | null;
  /** выбрано человеком в карточке статьи (или «убрано») — этап не перевыбирает */
  manual?: boolean;
  costUsd: number;
  at: string;
};

export const VIDEO_LIMITS = { minSec: 90, maxSec: 1200, minViews: 5000, judgeTop: 3, minRelevance: 8, minQuality: 7, videoFirstMinWords: 600 };

/** Красные флаги, при которых видео не ставим (реклама, другая техника, небезопасно, кликбейт, не по теме). */
const BLOCKING_FLAGS = /\b(ads?|advert\w*|haul|sponsor\w*|promot\w*|different technique|wrong technique|unsafe|dangerous|clickbait|wrong topic|off[- ]topic|low effort|misleading)\b/i;

export function blockingFlag(flags: string[]): string | null {
  for (const f of flags) if (BLOCKING_FLAGS.test(f)) return f;
  return null;
}

/** Решение по оценке ИИ: правила в коде, а не только «verdict» модели. */
export function judgeDecision(j: VideoJudge, opts: { videoFirst: boolean; words: number }): { ok: boolean; reason: string } {
  if (j.relevance < VIDEO_LIMITS.minRelevance) return { ok: false, reason: `релевантность ${j.relevance} < ${VIDEO_LIMITS.minRelevance}` };
  if (j.quality < VIDEO_LIMITS.minQuality) return { ok: false, reason: `качество ${j.quality} < ${VIDEO_LIMITS.minQuality}` };
  const flag = blockingFlag(j.redFlags);
  if (flag) return { ok: false, reason: `красный флаг: ${flag}` };
  if (/reject/i.test(j.verdict)) return { ok: false, reason: `модель: ${j.why}` };
  if (opts.videoFirst && opts.words < VIDEO_LIMITS.videoFirstMinWords) return { ok: false, reason: `мало текста для статьи по видео (${opts.words} слов)` };
  return { ok: true, reason: j.why };
}

/** Кандидаты из ответа DataForSEO YouTube organic. */
export function candidatesFromDfs(data: unknown): VideoCandidate[] {
  const items = (((data as { tasks?: Array<{ result?: Array<{ items?: unknown[] }> }> })?.tasks?.[0]?.result?.[0]?.items) ?? []) as Array<Record<string, unknown>>;
  return items.filter((i) => i.type === "youtube_video" && i.video_id).map((i) => ({
    id: String(i.video_id),
    title: String(i.title ?? "").slice(0, 200),
    channel: String(i.channel_name ?? "").slice(0, 120),
    views: Number(i.views_count ?? 0) || 0,
    sec: Number(i.duration_time_seconds ?? 0) || 0,
    date: String(i.timestamp ?? i.publication_date ?? ""),
    shorts: i.is_shorts === true,
    thumbnail: `https://i.ytimg.com/vi/${String(i.video_id)}/hqdefault.jpg`,
  }));
}

/** Мягкий фильтр по метаданным и порядок: просмотры с поправкой на свежесть. */
export function prefilterVideos(list: VideoCandidate[]): VideoCandidate[] {
  const now = Date.now();
  const score = (v: VideoCandidate) => {
    const t = Date.parse(v.date);
    const years = Number.isFinite(t) ? Math.max(0, (now - t) / (365 * 864e5)) : 3;
    return Math.log10(v.views + 10) - Math.min(years, 8) * 0.12;
  };
  return list
    .filter((v) => !v.shorts && v.sec >= VIDEO_LIMITS.minSec && v.sec <= VIDEO_LIMITS.maxSec && v.views >= VIDEO_LIMITS.minViews)
    .sort((a, b) => score(b) - score(a));
}

/** Субтитры DataForSEO → текст с метками секунд. */
export function transcriptFromDfs(data: unknown): { text: string; words: number } {
  const items = (((data as { tasks?: Array<{ result?: Array<{ items?: unknown[] }> }> })?.tasks?.[0]?.result?.[0]?.items) ?? []) as Array<Record<string, unknown>>;
  const parts = items.map((x) => `[${Math.round(Number(x.start_time ?? 0))}s] ${String(x.text ?? "").replace(/\s+/g, " ").trim()}`).filter((s) => s.length > 5);
  const text = parts.join(" ");
  const words = text.replace(/\[\d+s\]/g, " ").split(/\s+/).filter(Boolean).length;
  return { text, words };
}

export function isoDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${r || (!h && !m) ? `${r}S` : ""}`;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/** Блок видео в статье: подводка (одна фраза), адаптивный iframe 16:9, подпись автора. */
export function videoEmbedHtml(v: VideoCandidate, seed: string): string {
  const start = Math.max(0, Math.round(v.judge?.startAt ?? 0));
  const minutes = Math.max(1, Math.round(v.sec / 60));
  const channel = escapeHtml(v.channel || "the creator");
  const leads = [
    `Prefer to watch? ${channel} walks through the whole method in this ${minutes}-minute video.`,
    `If you learn better by watching, this ${minutes}-minute video from ${channel} shows every step.`,
    `Here is the method in action: ${channel} demonstrates it in about ${minutes} minutes.`,
  ];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const lead = leads[h % leads.length] + (start >= 20 ? ` The how-to part starts at ${clock(start)}.` : "");
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}${start ? `?start=${start}` : ""}`;
  return `<p>${lead}</p>
<figure class="zx-video" style="margin:20px 0;">
  <div style="position:relative; width:100%; padding-top:56.25%; border-radius:10px; overflow:hidden; background:#000;">
    <iframe src="${src}" title="${escapeHtml(v.title)}" loading="lazy" style="position:absolute; inset:0; width:100%; height:100%; border:0;" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
  </div>
  <figcaption style="font-size:12px; color:#777; margin-top:6px;">Video: “${escapeHtml(v.title)}” by ${channel} on YouTube</figcaption>
</figure>
`;
}

/** VideoObject для JSON-LD. */
export function videoObject(v: VideoCandidate): Record<string, unknown> {
  const t = Date.parse(v.date);
  return {
    "@type": "VideoObject",
    name: v.title.slice(0, 110),
    description: (v.judge?.why || v.title).slice(0, 300),
    thumbnailUrl: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${v.id}`,
    contentUrl: `https://www.youtube.com/watch?v=${v.id}`,
    ...(v.sec ? { duration: isoDuration(v.sec) } : {}),
    ...(Number.isFinite(t) ? { uploadDate: new Date(t).toISOString() } : {}),
  };
}

/** Текст метода из видео для брифа (видят план, автор и обвязка). */
export function videoBriefText(v: VideoCandidate, b: VideoBrief): string {
  const lines = [`PRIMARY METHOD SOURCE: the YouTube video "${v.title}" by ${v.channel} (embedded in the article). Follow its method, order and concrete numbers; you may add from the research brief but never contradict the video. Paraphrase, never quote it. Never claim you watched or tested it.`];
  if (b.steps.length) lines.push(`Video method, in order:\n${b.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (b.tips.length) lines.push(`Creator's tips: ${b.tips.join("; ")}`);
  if (b.mistakes.length) lines.push(`Mistakes the video warns about: ${b.mistakes.join("; ")}`);
  if (b.notCovered.length) lines.push(`Not covered by the video (take from research): ${b.notCovered.join("; ")}`);
  return lines.join("\n");
}
