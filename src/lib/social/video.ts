/**
 * Вертикальное видео 9:16 из фото статьи: сценарий (ИИ) → озвучка по сценам (OpenAI TTS) → сборка ffmpeg с плавным
 * приближением кадра и субтитрами → mp4 на нашем сервере. Один ролик идёт во все видео-сети статьи
 * (Reels, TikTok, YouTube Shorts, Facebook Reels), подписи под каждую сеть свои.
 * У сцены два текста: `text` — как на экране («2–3 см», «№1»), `voice` — как произносить (числа, единицы, сокращения
 * и латиница словами, в нужном падеже). Субтитры идут по `text`, в озвучку уходит `voice`.
 * Длительность сцены = длительность её озвучки: субтитры не расходятся со звуком.
 * На сервере нужен ffmpeg (apt install ffmpeg, поставлен 2026-11-11). Ключи — только команды WexOra.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { runSlot } from "@/lib/run";
import { registerFontsFromDir } from "@/lib/pins/canvas/host.node";
import { publicUrl, storageRoot, writeFileAtomic } from "@/lib/pins/storage";
import type { Article } from "./article";
import { assemblePost, postLink, resolveSocialSlot } from "./generate";
import { imageSource, renderFormat, runFilesDir } from "./images";
import { TTS_VOICES } from "./voices";
import { networkOf, PROJECT_SLUG, SLOT_TEXT, type NetworkKey, type NetworkSpec, type SocialPost, type SocialPosts, type SocialSettings } from "./types";

const run = promisify(execFile);

export const VIDEO = { w: 1080, h: 1920, fps: 30, minScenes: 4, maxScenes: 7, zoom: 0.08, font: "Montserrat" };
export const TTS_MODELS = ["gpt-4o-mini-tts", "tts-1-hd"];
/** Оценка цены озвучки для журнала расхода: OpenAI считает gpt-4o-mini-tts примерно в $0.015 за минуту звука. */
const TTS_USD_PER_MIN = 0.015;
/** Голос OpenAI на украинском и русском читает медленно (~1,4 слова в секунду): ускоряем без изменения тона. */
const VOICE_SPEED = 1.12;

export type Scene = { text: string; voice: string };
export type VideoScript = { title: string; scenes: Scene[]; captions: Record<string, { text: string; hashtags: string[] }>; tags: string[] };

/* ---------- Сценарий ---------- */

const LANG_NAMES: Record<string, string> = { uk: "украинский", ru: "русский", en: "английский", de: "немецкий", pl: "польский", es: "испанский", fr: "французский", it: "итальянский", pt: "португальский" };

function scriptPrompt(nets: NetworkSpec[], s: SocialSettings, lang: string): string {
  const caps = nets.map((n) => `- ${n.key} (${n.label}): до ${Math.min(n.maxChars, 700)} знаков, хэштегов ${n.hashtags[0]}–${n.hashtags[1]}. ${n.style}`).join("\n");
  return `Ты сценарист коротких вертикальных видео (Reels, TikTok, Shorts) для контентного сайта. По статье напиши сценарий ролика на 20–35 секунд: кадры — фото из статьи, поверх идут субтитры, за кадром — живой голос.

Сценарий:
- ${VIDEO.minScenes}–${VIDEO.maxScenes} сцен, всего 45–60 слов — строго не больше 60 (первый пробный ролик на 80 слов вышел 57 секунд). Каждая сцена — одна законченная мысль, 7–11 слов.
- Первая сцена — зацепка: неожиданный факт, ошибка или обещание пользы из статьи, без приветствий и «в этом видео».
- Дальше — самое полезное из статьи по шагам или пунктам, конкретно: цифры, сроки, названия.
- Последняя сцена — вывод и призыв: полная статья по ссылке в профиле/описании.
- Язык: ${lang}. Разговорная речь, короткие фразы, как рассказывает подруга, а не диктор. Только факты из статьи.
- У каждой сцены два поля:
  "text" — как это написано на экране (цифры цифрами: «2–3 см», «5 засобів»).
  "voice" — тот же текст для озвучки: ВСЕ числа, даты, единицы измерения, сокращения, символы и слова латиницей записаны словами так, как их произносят на языке ролика, в правильном роде, числе и падеже («на 2–3 см ширший» → «на два-три сантиметри ширший», «5 засобів» → «п'ять засобів», «SPF 50» → «ес-пі-еф п'ятдесят»). Без цифр, скобок, кавычек и эмодзи. Слова с неочевидным ударением можно заменить синонимом.
- "title" — заголовок ролика для YouTube, до 70 знаков, без кликбейта и капса.
- "tags" — 5–8 поисковых тегов по теме без знака #.

Подписи к ролику для сетей (ссылки и хэштеги в текст не вставлять, хэштеги — отдельным массивом без #):
${caps}
${s.emoji ? "Эмодзи в подписях уместны: 1–3." : "Эмодзи не использовать."}${s.notes ? `\nПожелания редакции: ${s.notes}` : ""}

Верни только JSON: {"title":"…","tags":["…"],"scenes":[{"text":"…","voice":"…"}],"captions":{"<ключ сети>":{"text":"…","hashtags":["…"]}}}`;
}

async function writeScript(opts: { userId: string; runId: string; article: Article; settings: SocialSettings; nets: NetworkSpec[] }): Promise<{ script: VideoScript; costUsd: number }> {
  const { article, settings } = opts;
  const { teamId, pre } = await resolveSocialSlot(opts.userId);
  const lang = settings.language !== "auto" ? settings.language : `тот же, что у статьи${LANG_NAMES[article.lang.slice(0, 2)] ? ` (${LANG_NAMES[article.lang.slice(0, 2)]})` : ""}`;
  let costUsd = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runSlot({
      userId: opts.userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_TEXT, pre, model: settings.model || undefined, timeoutMs: 150_000, meta: { teamId, refId: opts.runId },
      payload: { messages: [{ role: "system", content: scriptPrompt(opts.nets, settings, lang) }, { role: "user", content: `Заголовок: ${article.title}\n\nТекст статьи:\n${article.text}` }], temperature: 0.6, response_format: { type: "json_object" }, max_tokens: 4000 },
    });
    costUsd += res.meta?.costUsd ?? 0;
    if (!res.ok) {
      lastError = res.error ?? `HTTP ${res.status}`;
      continue;
    }
    try {
      const content = (res.data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
      const v = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown>;
      const scenes = (Array.isArray(v.scenes) ? v.scenes : [])
        .map((x) => ({ text: String((x as Scene)?.text ?? "").trim(), voice: String((x as Scene)?.voice ?? "").trim() }))
        .filter((x) => x.text)
        .map((x) => ({ text: x.text, voice: cleanVoice(x.voice || x.text) }))
        .slice(0, VIDEO.maxScenes);
      if (scenes.length < 3) {
        lastError = "в сценарии меньше трёх сцен";
        continue;
      }
      const captions: VideoScript["captions"] = {};
      for (const [k, c] of Object.entries((v.captions ?? {}) as Record<string, { text?: unknown; hashtags?: unknown }>)) {
        captions[k] = { text: String(c?.text ?? "").trim(), hashtags: Array.isArray(c?.hashtags) ? c.hashtags.map(String) : [] };
      }
      return { script: { title: String(v.title ?? article.title).trim().slice(0, 100), scenes, captions, tags: (Array.isArray(v.tags) ? v.tags : []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 10) }, costUsd };
    } catch {
      lastError = "ответ модели не JSON";
    }
  }
  throw new Error(`Сценарий не получен: ${lastError}`);
}

/** Текст для голоса: без эмодзи, кавычек, скобок и ссылок — их синтезатор читает вслух или спотыкается. */
export function cleanVoice(s: string): string {
  return s.replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}️]/gu, "").replace(/[«»"“”„()[\]#*_]/g, "").replace(/\s+/g, " ").trim();
}

/* ---------- Озвучка ---------- */

type TtsKey = { id: string; providerId: string; baseUrl: string; secret: string; teamId: string; label: string };

/** Ключ OpenAI команды WexOra: озвучка идёт только через него (как в прежнем сервисе). */
async function ttsKey(): Promise<TtsKey> {
  const team = await prisma.team.findUnique({ where: { slug: "wexora" }, select: { id: true } });
  if (!team) throw new Error("Команда WexOra не найдена");
  const key = await prisma.apiKey.findFirst({ where: { teamId: team.id, status: "ACTIVE", provider: { slug: "openai" } }, include: { provider: true }, orderBy: { createdAt: "asc" } });
  if (!key) throw new Error("Для озвучки нужен рабочий ключ OpenAI команды WexOra — сейчас его нет (выключен или закончились деньги)");
  return { id: key.id, providerId: key.providerId, baseUrl: key.provider.baseUrl.replace(/\/+$/, ""), secret: decryptSecret(key.secretEnc), teamId: team.id, label: key.label };
}

const VOICE_STYLE = "Говори естественно и тепло, в темпе живого рассказа подруге: с лёгкой улыбкой, без дикторского пафоса и без пауз между словами. Чёткая дикция, правильные ударения.";

async function speak(key: TtsKey, text: string, voice: string, lang: string): Promise<Buffer> {
  let lastError = "";
  for (const model of TTS_MODELS) {
    const body: Record<string, unknown> = { model, voice, input: text, response_format: "mp3" };
    if (model.startsWith("gpt-")) body.instructions = `${VOICE_STYLE} Язык текста: ${lang}.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${key.baseUrl}/audio/speech`, { method: "POST", headers: { Authorization: `Bearer ${key.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) }).catch((e) => e as Error);
      if (res instanceof Error) {
        lastError = res.message;
        continue;
      }
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (res.status === 401 || res.status === 402) throw new Error(`Озвучка: ключ OpenAI «${key.label}» отклонён (${lastError})`);
      if (res.status === 404 || res.status === 400) break; // модель недоступна этому ключу — пробуем следующую
    }
  }
  throw new Error(`Озвучка не получена: ${lastError}`);
}

/* ---------- Субтитры ---------- */

/** Сцена → короткие куски субтитров (до ~26 знаков): по два-пять слов, чтобы успевали читаться. */
export function captionChunks(text: string, max = 26): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (cur && (cur + " " + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  // Одинокое короткое слово в конце приклеиваем к предыдущему куску.
  if (out.length > 1 && out[out.length - 1].length < 6) out.splice(out.length - 2, 2, `${out[out.length - 2]} ${out[out.length - 1]}`);
  return out;
}

function ensureFont(): string {
  if (!GlobalFonts.has(VIDEO.font)) registerFontsFromDir(join(storageRoot(), "pins/fonts"));
  return GlobalFonts.has(VIDEO.font) ? VIDEO.font : "sans-serif";
}

/** Прозрачный кадр 1080×1920 с субтитром: белый жирный текст на тёмной плашке, выше нижней зоны интерфейса сетей. */
export function captionPng(text: string): Buffer {
  const font = ensureFont();
  const c = createCanvas(VIDEO.w, VIDEO.h);
  const ctx = c.getContext("2d");
  const size = 68;
  ctx.font = `800 ${size}px "${font}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = 900;
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  const lh = size * 1.22;
  const boxW = Math.min(VIDEO.w - 80, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 72);
  const boxH = lines.length * lh + 44;
  const cy = 1330;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  ctx.beginPath();
  ctx.roundRect((VIDEO.w - boxW) / 2, cy - boxH / 2, boxW, boxH, 28);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  lines.forEach((l, i) => ctx.fillText(l, VIDEO.w / 2, cy - ((lines.length - 1) * lh) / 2 + i * lh));
  return c.toBuffer("image/png");
}

/* ---------- Сборка ---------- */

let renderChain: Promise<unknown> = Promise.resolve();
/** Кодирование видео грузит процессор: ролики собираются по одному, остальные статьи в это время пишут тексты. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const p = renderChain.then(fn, fn);
  renderChain = p.catch(() => undefined);
  return p;
}

async function audioSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("озвучка пустая");
  return d;
}

async function renderScene(dir: string, i: number, bg: string, audio: string, dur: number, chunks: string[]): Promise<string> {
  const frames = Math.ceil(dur * VIDEO.fps);
  // Чётные сцены приближаются, нечётные отдаляются — ролик не выглядит слайд-шоу с одним и тем же движением.
  const z = i % 2 === 0 ? `1+${VIDEO.zoom}*on/${frames}` : `${1 + VIDEO.zoom}-${VIDEO.zoom}*on/${frames}`;
  const inputs = ["-loop", "1", "-framerate", String(VIDEO.fps), "-t", dur.toFixed(3), "-i", bg, "-i", audio];
  // Увеличенный исходник (×1.5) убирает дрожание zoompan на целых пикселях.
  let graph = `[0:v]scale=${VIDEO.w * 1.5}:${VIDEO.h * 1.5},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${VIDEO.w}x${VIDEO.h}:fps=${VIDEO.fps}[v0]`;
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  let t = 0;
  for (let k = 0; k < chunks.length; k++) {
    const file = join(dir, `c${i}_${k}.png`);
    await writeFile(file, captionPng(chunks[k]));
    inputs.push("-i", file);
    const end = k === chunks.length - 1 ? dur : t + (dur * chunks[k].length) / total;
    graph += `;[v${k}][${k + 2}:v]overlay=0:0:enable='between(t,${t.toFixed(3)},${end.toFixed(3)})'[v${k + 1}]`;
    t = end;
  }
  const out = join(dir, `s${i}.mp4`);
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", `[v${chunks.length}]`, "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(VIDEO.fps),
    // Instagram отклоняет звук выше 128 кбит/с.
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-af", `atempo=${VOICE_SPEED},apad`, "-t", dur.toFixed(3), out], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  return out;
}

export type VideoResult = { posts: SocialPosts; costUsd: number; durationSec: number };

/**
 * Ролик статьи и посты видео-сетей. Ошибка (нет фото, озвучка, ffmpeg) не роняет статью: сети получают `skipped`
 * с причиной, текстовые посты остаются.
 */
export async function makeVideoPosts(opts: { userId: string; runId: string; itemId: string; url: string; article: Article; settings: SocialSettings; nets: NetworkKey[] }): Promise<VideoResult> {
  const specs = opts.nets.map(networkOf).filter((n): n is NetworkSpec => !!n?.video);
  const skipAll = (reason: string, costUsd = 0): VideoResult => ({ posts: Object.fromEntries(specs.map((n) => [n.key, { text: "", images: [], alts: [], skipped: reason } as SocialPost])), costUsd, durationSec: 0 });
  if (!specs.length) return { posts: {}, costUsd: 0, durationSec: 0 };
  if (opts.article.images.length < 2) return skipAll("для видео нужно хотя бы 2 фото в статье");
  if (opts.article.text.length < 300) return skipAll("на странице не найден текст статьи");
  let costUsd = 0;
  let dir = "";
  try {
    const w = await writeScript({ userId: opts.userId, runId: opts.runId, article: opts.article, settings: opts.settings, nets: specs });
    costUsd += w.costUsd;
    const script = w.script;
    const key = await ttsKey();
    const lang = opts.settings.language !== "auto" ? opts.settings.language : LANG_NAMES[opts.article.lang.slice(0, 2)] ?? "язык текста";
    const voice = TTS_VOICES.includes(opts.settings.voice) ? opts.settings.voice : TTS_VOICES[0];
    dir = await mkdtemp(join(tmpdir(), "zx-social-"));
    // Озвучка сцен параллельно (сеть), сборка — строго по одной (процессор).
    const audios = await Promise.all(script.scenes.map(async (sc, i) => {
      const file = join(dir, `a${i}.mp3`);
      await writeFile(file, await speak(key, sc.voice, voice, lang));
      return { file, dur: (await audioSeconds(file)) / VOICE_SPEED + 0.15 };
    }));
    const durationSec = audios.reduce((a, x) => a + x.dur, 0);
    const ttsCost = (durationSec / 60) * TTS_USD_PER_MIN;
    costUsd += ttsCost;
    const project = await prisma.project.findUnique({ where: { slug: PROJECT_SLUG }, select: { id: true } });
    if (project) {
      await prisma.usageLog.create({ data: { userId: opts.userId, projectId: project.id, providerId: key.providerId, apiKeyId: key.id, units: script.scenes.length, costUsd: ttsCost, durationMs: 0, ok: true, teamId: key.teamId, refId: opts.runId } }).catch(() => undefined);
    }
    const rel = `${runFilesDir(opts.runId)}/${createHash("sha1").update(opts.itemId).digest("hex").slice(0, 16)}-video`;
    const tmp = dir;
    await oneAtATime(async () => {
      const parts: string[] = [];
      let poster: Buffer | null = null;
      for (let i = 0; i < script.scenes.length; i++) {
        const im = opts.article.images[i % opts.article.images.length];
        const frame = await renderFormat(await imageSource(im.url), { key: "9x16", w: VIDEO.w, h: VIDEO.h });
        if (!poster) poster = frame;
        const bg = join(tmp, `bg${i}.jpg`);
        await writeFile(bg, frame);
        parts.push(await renderScene(tmp, i, bg, audios[i].file, audios[i].dur, captionChunks(script.scenes[i].text)));
      }
      const list = join(tmp, "list.txt");
      await writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
      const out = join(tmp, "out.mp4");
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { timeout: 120_000 });
      await writeFileAtomic(`${rel}.mp4`, await readFile(out));
      if (poster) await writeFileAtomic(`${rel}.jpg`, poster);
    });
    const videoUrl = publicUrl(`${rel}.mp4`);
    const posts: SocialPosts = {};
    const fallback = Object.values(script.captions).find((c) => c.text) ?? { text: script.scenes[0].text, hashtags: script.tags };
    for (const net of specs) {
      const cap = script.captions[net.key]?.text ? script.captions[net.key] : fallback;
      const built = assemblePost(net, cap.text, cap.hashtags.length ? cap.hashtags : script.tags, net.linkInText ? postLink(opts.url, net.key, opts.settings.utm) : null);
      posts[net.key] = { text: built.text, images: [videoUrl], alts: [""], video: true, poster: publicUrl(`${rel}.jpg`), title: script.title, tags: script.tags, durationSec: Math.round(durationSec), script: script.scenes };
    }
    return { posts, costUsd, durationSec };
  } catch (e) {
    return skipAll(`видео не собрано: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, costUsd);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
