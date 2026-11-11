/**
 * Тексты постов: один вызов модели на статью возвращает посты для всех выбранных сетей.
 * Ссылку и хэштеги дописывает код (модель их в текст не ставит), лимиты сетей тоже держит код.
 * Ключи — только команды WexOra (решение владельца 2026-11-11): инструмент её, расход пишется на неё.
 */
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot } from "@/lib/run";
import type { Article } from "./article";
import { networkOf, PROJECT_SLUG, SLOT_TEXT, type NetworkKey, type NetworkSpec, type SocialPost, type SocialPosts, type SocialSettings } from "./types";

export const KEY_TEAM_SLUG = "wexora";
export const KEY_TEAM_NAME = "WexOra";

let teamCache: string | null = null;
export async function socialKeyTeamId(): Promise<string> {
  if (teamCache) return teamCache;
  const team = await prisma.team.findUnique({ where: { slug: KEY_TEAM_SLUG }, select: { id: true } });
  if (!team) throw new Error(`Команда ${KEY_TEAM_NAME} не найдена — «Соцсети» работают только на её ключах`);
  teamCache = team.id;
  return team.id;
}

/** Правило слота строго с ключом WexOra: чужой или общий ключ не берётся. */
export async function resolveSocialSlot(userId: string) {
  const teamId = await socialKeyTeamId();
  const r = await resolveSlot(userId, PROJECT_SLUG, SLOT_TEXT, teamId);
  if (!r.ok) throw new Error(`${r.error} «Соцсети» работают только на ключах команды ${KEY_TEAM_NAME}.`);
  const key = await prisma.apiKey.findUnique({ where: { id: r.value.binding.apiKey.id }, select: { teamId: true } });
  if (key?.teamId !== teamId) throw new Error(`Для «Соцсетей» нет ключа команды ${KEY_TEAM_NAME}: подключите её ключ к инструменту на странице ключа.`);
  return { teamId, pre: r.value };
}

/** Проверка до запуска прогона: есть ли рабочий ключ. */
export async function assertSocialKey(userId: string): Promise<void> {
  await resolveSocialSlot(userId);
}

/* ---------- Сборка поста (чистые функции) ---------- */

/** В X любая ссылка считается за 23 знака, в остальных сетях — по длине. */
const linkCost = (net: NetworkSpec, link: string) => (net.key === "x" ? 23 : link.length);

const UTM_SOURCE: Partial<Record<NetworkKey, string>> = { x: "twitter", ig_reel: "instagram", tiktok_video: "tiktok", yt_short: "youtube", fb_reel: "facebook" };

export function postLink(url: string, net: NetworkKey, utm: boolean): string {
  if (!utm) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", UTM_SOURCE[net] ?? net);
    u.searchParams.set("utm_medium", "social");
    return u.toString();
  } catch {
    return url;
  }
}

/** Обрезка по границе предложения, иначе по слову; без повисшей пунктуации. */
export function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(" ");
  return (word > max * 0.5 ? cut.slice(0, word) : cut.slice(0, max - 1)).replace(/[\s,;:–—-]+$/, "") + "…";
}

const cleanTag = (t: string) => "#" + t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");

/** Текст модели + хэштеги + ссылка в пределах лимита сети. Сначала жертвуем хэштегами, потом режем текст. */
export function assemblePost(net: NetworkSpec, body: string, hashtags: string[], link: string | null): { text: string; trimmed: boolean } {
  // Модель иногда ставит заглушку «[link]» вместо ссылки — убираем: настоящую ссылку дописываем сами.
  let text = body.replace(/https?:\/\/\S+/g, "").replace(/\[\s*(?:link|url|ссылка|посилання|лінк)[^\]]*\]/gi, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const inline: string[] = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const tags = [...new Set([...hashtags.map(cleanTag), ...inline].filter((t) => t.length > 2))].filter((t) => !inline.includes(t)).slice(0, Math.max(0, net.hashtags[1] - inline.length));
  const tail = link ? (net.key === "x" || net.key === "bluesky" ? " " : "\n\n") : "";
  const linkLen = link ? tail.length + linkCost(net, link) : 0;
  let trimmed = false;
  let budget = net.maxChars - linkLen;
  if (text.length > budget) {
    text = trimTo(text, budget);
    trimmed = true;
  }
  let tagLine = "";
  for (const t of tags) {
    const next = tagLine ? `${tagLine} ${t}` : t;
    if (text.length + 2 + next.length > budget) break;
    tagLine = next;
  }
  const sep = net.key === "x" || net.key === "bluesky" ? " " : "\n\n";
  return { text: `${text}${tagLine ? sep + tagLine : ""}${link ? tail + link : ""}`, trimmed };
}

/* ---------- Модель ---------- */

const ANTI_AI = `Запрещено: «в мире, где», «давайте разберёмся», «не секрет, что», «это не просто X, это Y», «погрузимся», «раскроем секреты», риторические вопросы подряд, восклицания в каждом предложении, длинные тире для драматизма, слова «уникальный», «невероятный», «идеальный», «незаменимый». Пиши как живой редактор соцсетей: конкретные детали из статьи вместо общих слов.`;

function systemPrompt(nets: NetworkSpec[], s: SocialSettings, lang: string): string {
  const rules = nets
    .map((n) => {
      const reserve = n.linkInText ? 30 : 0;
      const tags = n.hashtags[1] === 0 ? "хэштегов нет" : `хэштегов ${n.hashtags[0]}–${n.hashtags[1]}`;
      return `- ${n.key} (${n.label}): до ${Math.max(120, n.maxChars - reserve - (n.hashtags[1] ? 60 : 0))} знаков текста, ${tags}. ${n.style}`;
    })
    .join("\n");
  return `Ты редактор соцсетей контентного сайта. По статье напиши по одному посту для каждой сети из списка. Цель — переходы на статью и охват, площадка-источник трафика — Google Discover, поэтому посты должны вызывать интерес к теме, а не пересказывать статью целиком.

Сети и требования:
${rules}

Общие правила:
- Язык постов: ${lang}.
- Каждый пост написан заново под свою сеть: разные первые фразы, разный угол. Нельзя копировать один текст в несколько сетей.
- Только факты из статьи. Ничего не выдумывать: ни цифр, ни имён, ни цитат.
- Ссылки в текст НЕ вставлять — их добавит система в самый конец поста. Не ставить заглушки вроде [link] и не обрывать фразу на «подробнее тут:». Хэштеги в текст НЕ вставлять — верни их отдельным массивом без знака #, на языке поста, по теме статьи (не #love #instagood).
- ${s.emoji ? "Эмодзи уместны в Instagram, Threads, Facebook, TikTok: 1–3 на пост, не в каждой строке. В X, LinkedIn, Bluesky, GBP — без эмодзи или один." : "Эмодзи не использовать."}
- ${ANTI_AI}
${s.notes ? `- Пожелания редакции: ${s.notes}\n` : ""}
Верни только JSON: {"posts":{"<ключ сети>":{"text":"…","hashtags":["…"]}}} — ключи сетей строго из списка.`;
}

const LANG_NAMES: Record<string, string> = { uk: "украинский", ru: "русский", en: "английский", de: "немецкий", pl: "польский", es: "испанский", fr: "французский", it: "итальянский", pt: "португальский" };

export type GenerateResult = { posts: SocialPosts; costUsd: number };

/** Посты статьи для сетей `nets` (при перегенерации — одна сеть). */
export async function generatePosts(opts: { userId: string; runId: string; url: string; article: Article; settings: SocialSettings; nets: NetworkKey[]; prepareImages?: (net: NetworkKey, images: Article["images"]) => Promise<Article["images"]> }): Promise<GenerateResult> {
  const { article, settings } = opts;
  // Видео-сети делает video.ts: здесь только посты с текстом и фото.
  const specs = opts.nets.map(networkOf).filter((n): n is NetworkSpec => !!n && !n.video);
  if (!specs.length) return { posts: {}, costUsd: 0 };
  if (article.text.length < 300) throw new Error("На странице не найден текст статьи (меньше 300 знаков)");
  const { teamId, pre } = await resolveSocialSlot(opts.userId);
  const lang = settings.language !== "auto" ? settings.language : `тот же, что у статьи${LANG_NAMES[article.lang.slice(0, 2)] ? ` (${LANG_NAMES[article.lang.slice(0, 2)]})` : ""}`;
  const user = `Заголовок: ${article.title}\n${article.description ? `Описание: ${article.description}\n` : ""}\nТекст статьи:\n${article.text}`;
  let lastError = "";
  let costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runSlot({
      userId: opts.userId,
      projectSlug: PROJECT_SLUG,
      slotKey: SLOT_TEXT,
      payload: { messages: [{ role: "system", content: systemPrompt(specs, settings, lang) }, { role: "user", content: user }], temperature: 0.7, response_format: { type: "json_object" }, max_tokens: 4000 },
      model: settings.model || undefined,
      timeoutMs: 150_000,
      meta: { teamId, refId: opts.runId },
      pre,
    });
    costUsd += res.meta?.costUsd ?? 0;
    if (!res.ok) {
      lastError = res.error ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 409) break;
      continue;
    }
    const content = (res.data as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? "";
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      parsed = (v?.posts && typeof v.posts === "object" ? v.posts : v) as Record<string, unknown>;
    } catch {
      lastError = "ответ модели не JSON";
      continue;
    }
    const posts: SocialPosts = {};
    for (const net of specs) {
      const raw = (parsed?.[net.key] ?? {}) as { text?: unknown; hashtags?: unknown };
      const body = String(raw.text ?? "").trim();
      if (!body) continue;
      const picked = article.images.slice(0, Math.min(settings.maxImages, net.maxImages));
      const images = opts.prepareImages ? await opts.prepareImages(net.key, picked) : picked;
      if (net.needsImage && !images.length) {
        posts[net.key] = { text: "", images: [], alts: [], skipped: picked.length ? "фото статьи не удалось скачать — сеть принимает посты только с фото" : "в статье нет фото — сеть принимает посты только с фото" };
        continue;
      }
      const link = net.linkInText ? postLink(opts.url, net.key, settings.utm) : null;
      const built = assemblePost(net, body, Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [], link);
      const post: SocialPost = { text: built.text, images: images.map((i) => i.url), alts: images.map((i) => i.alt) };
      if (built.trimmed) post.trimmed = true;
      posts[net.key] = post;
    }
    const missing = specs.filter((n) => !posts[n.key]);
    if (missing.length === specs.length) {
      lastError = "модель не вернула ни одного поста";
      continue;
    }
    return { posts, costUsd };
  }
  throw new Error(`Тексты не получены: ${lastError}`);
}
