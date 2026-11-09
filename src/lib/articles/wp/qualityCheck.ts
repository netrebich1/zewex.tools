/**
 * Бесплатная проверка статьи перед публикацией: без обращений к ИИ, по сохранённым данным (мета, секции, фото, HTML).
 * Порт supabase/functions/_shared/qualityCheck.ts, адаптированный к нашей модели (Article + ArtSection + ArtPhoto;
 * вступление/заключение — Article.introHtml/outroHtml, а не секции особого типа).
 *
 * Что чиним сами (fixed) — детерминированно, без моделей:
 *  - пустые h1 / title / description / slug восстанавливаются из плана (ArticlePlan) или ключа (оригинал звал stage77 заново);
 *  - метка {{COUNT}} заменяется числом фото (оригинал: patchCount при сборке, retargetCount при починке);
 *  - повторяющиеся и пустые заголовки H2 — uniqueHeading (оригинал repairQualityIssues :535-556);
 *  - выделения <b>/<strong>/<em>/** — stripEmphasis (оригинал считал это блокером и перезаписывал секции).
 * Что НЕ чиним — возвращаем problems, статья останавливается с понятным списком (08-plan §3 п.8: ничего не удалять молча;
 * оригинал исключал секции с битыми фото и собирал статью короче плана).
 */
import type { Article, ArtPhoto, ArtSection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { headingKey, looksLikeFactDump, stripEmphasis, uniqueHeading } from "@/lib/articles/text/textGuards";
import { INTRO_MIN_WORDS, OUTRO_MIN_WORDS } from "@/lib/articles/text/introOutroParse";
import { exists } from "@/lib/articles/storage";
import type { ArticlePlan } from "@/lib/articles/types";
import { mapLimited } from "@/lib/pins/wp/client";
import { slugify } from "@/lib/utils";

/** оригинал qualityCheck.ts:33-36 */
const THINKING_RE = /\b(we need to write|i need to write|let'?s draft|i'?ll draft|the prompt says|word count target|output must be json)\b/i;
const EMPHASIS_RE = /(\*\*[^*]+\*\*|<(strong|b|em|i)\b)/i;
export const MIN_SECTION_WORDS = 40;
export const MIN_ARTICLE_WORDS = 700;
/** Последний барьер: меньше 5 разделов с фото — публиковать нечего (оригинал :344-351). */
export const MIN_SECTIONS = 5;
/** Минимальные размеры фото — как у поиска, чтобы миниатюры Google проходили (оригинал :103-104). */
const MIN_PHOTO_W = 320;
const MIN_PHOTO_H = 480;
/** Метка количества идей (оригинал countToken.ts: {{COUNT}}, keepToken нормализует {COUNT}/[COUNT]). */
const COUNT_RE = /\{\{\s*COUNT\s*\}\}|\{COUNT\}|\[COUNT\]/g;
const URL_CHECK_CONCURRENCY = 6; // оригинал: 12 (:107) — у нас меньше, хранилище одно

export type QualityPatch = {
  article: Partial<Pick<Article, "h1" | "metaTitle" | "metaDescription" | "slug" | "html">>;
  sections: Array<{ id: string; heading?: string; html?: string }>;
};

export type QualityResult = {
  ok: boolean;
  /** Что мешает публикации (по-русски, для карточки статьи) */
  problems: string[];
  /** Что исправлено автоматически */
  fixed: string[];
  /** Исправленные поля — применяет вызывающий (publish.ts) */
  patch: QualityPatch;
  sectionsLive: number;
  photosLive: number;
};

export function wordCount(text: string | null | undefined): number {
  return String(text ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

/**
 * «Мёртвой» считаем ссылку только при окончательном ответе (400/401/404/410). 429 и 5xx — перегрузка хранилища,
 * а не пропавшее фото: раньше из-за них готовые статьи навсегда падали в publish_error (оригинал urlAlive :46-67).
 */
export async function urlAlive(url: string, signal?: AbortSignal): Promise<boolean> {
  const delays = [0, 2000];
  for (const d of delays) {
    if (d) await new Promise((r) => setTimeout(r, d));
    if (signal?.aborted) return true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    const onOuter = () => ac.abort();
    signal?.addEventListener("abort", onOuter, { once: true });
    try {
      let resp = await fetch(url, { method: "HEAD", signal: ac.signal, redirect: "follow" });
      if (resp.status === 405 || resp.status === 403) {
        resp = await fetch(url, { method: "GET", headers: { Range: "bytes=0-64" }, signal: ac.signal, redirect: "follow" });
        await resp.body?.cancel().catch(() => {});
      }
      if (resp.ok || resp.status === 206) return true;
      if ([400, 401, 404, 410].includes(resp.status)) return false;
    } catch {
      /* сеть/таймаут — ещё попытка */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
    }
  }
  return true; // окончательного «нет» не получили — фото не считаем пропавшим
}

function replaceCount(text: string, n: number): string {
  return text.replace(COUNT_RE, String(n));
}

/** Заменить текст заголовка H2 в собранном HTML (с префиксом «N. » или без), не трогая атрибуты тега. */
function replaceHeadingInHtml(html: string, oldHeading: string, newHeading: string): string {
  const esc = oldHeading.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return html;
  const re = new RegExp(`(<h2\\b[^>]*>\\s*)(\\d+\\s*[.)\\-–]\\s*)?${esc}(\\s*</h2>)`, "i");
  return html.replace(re, (_m, open: string, num: string | undefined, close: string) => `${open}${num ?? ""}${newHeading}${close}`);
}

/**
 * Проверка статьи. Фото проверяются по сети только если файла нет локально (путь пуст или файл уже удалён после загрузки
 * на сайт); локальные файлы считаем живыми (оригинал :109-111 — файлы своего хранилища не проверял).
 */
export async function checkArticleQuality(
  article: Article,
  sections: ArtSection[],
  photos: ArtPhoto[],
  opts: { checkUrls?: boolean; signal?: AbortSignal } = {},
): Promise<QualityResult> {
  const problems: string[] = [];
  const fixed: string[] = [];
  const patch: QualityPatch = { article: {}, sections: [] };
  const plan = (article.plan ?? null) as ArticlePlan | null;

  const livePhotos = photos.filter((p) => !p.excluded).sort((a, b) => a.position - b.position);
  const excludedIds = new Set(photos.filter((p) => p.excluded).map((p) => p.id));
  const photoById = new Map(photos.map((p) => [p.id, p] as const));
  // Секции, чьё фото исключено модератором, в статью не входят — их не проверяем.
  const liveSections = sections.filter((s) => !(s.photoId && excludedIds.has(s.photoId))).sort((a, b) => a.position - b.position);
  const count = livePhotos.length || liveSections.length;

  // ── 1. Фото (оригинал :99-149) ──────────────────────────────
  const seenSha = new Set<string>();
  const seenUrl = new Set<string>();
  const checks = await mapLimited(livePhotos, URL_CHECK_CONCURRENCY, async (p) => {
    const url = p.wpUrl || p.publicUrl;
    if (!url) return { p, url, alive: false };
    if (opts.checkUrls === false) return { p, url, alive: true };
    if (p.path && (await exists(p.path))) return { p, url, alive: true };
    return { p, url, alive: await urlAlive(url, opts.signal) };
  });
  for (const { p, url, alive } of checks) {
    if (!url || !alive) {
      problems.push(`Фото ${p.position}: ссылка не открывается`);
      continue;
    }
    if ((p.width && p.width < MIN_PHOTO_W) || (p.height && p.height < MIN_PHOTO_H)) {
      problems.push(`Фото ${p.position}: слишком маленькое (${p.width}×${p.height})`);
      continue;
    }
    if (p.sha256) {
      if (seenSha.has(p.sha256)) {
        problems.push(`Фото ${p.position}: дубль внутри статьи`);
        continue;
      }
      seenSha.add(p.sha256);
    }
    if (seenUrl.has(url)) {
      problems.push(`Фото ${p.position}: тот же файл, что и выше`);
      continue;
    }
    seenUrl.add(url);
  }
  // Одна секция получила два фото / одно фото на две секции (оригинал photo_shared_section :230-240)
  const photoUse = new Map<string, number[]>();
  for (const s of liveSections) if (s.photoId) photoUse.set(s.photoId, [...(photoUse.get(s.photoId) ?? []), s.position]);
  for (const [pid, positions] of photoUse) {
    if (positions.length > 1) problems.push(`Фото ${photoById.get(pid)?.position ?? "?"}: стоит в секциях ${positions.join(", ")}`);
  }

  // ── 2. Текст секций (оригинал :152-183) ─────────────────────
  // Вступление (позиция 0) и заключение (9990) хранятся строками ArtSection рядом с фото-секциями: в сообщениях они
  // называются по-человечески, а их объём проверяется своими порогами в блоке 3 (раньше к заключению применялась норма
  // обычной секции 40 слов и статья падала с «Секция 9990: всего 38 слов» — аудит 2026-10-14).
  const isIntroOutro = (pos: number) => pos === 0 || pos >= 9990;
  const label = (pos: number) => (pos === 0 ? "Вступление" : pos >= 9990 ? "Заключение" : `Секция ${pos}`);
  const headingKw = [article.keyword, article.focusKeyword, article.seoKeyword].filter(Boolean).join(" ");
  const usedHeadings = new Set<string>();
  const headingOwner = new Map<string, number>();
  for (const s of liveSections) {
    const n = s.position;
    const L = label(n);
    const html = s.html ?? "";
    if (!html.trim() || s.status === "failed") {
      problems.push(`${L}: нет текста${s.error ? ` (${s.error.slice(0, 120)})` : ""}`);
      continue;
    }
    let sectionHtml = html;
    const sectionPatch: { id: string; heading?: string; html?: string } = { id: s.id };
    if (THINKING_RE.test(sectionHtml)) problems.push(`${L}: в тексте черновые размышления модели`);
    if (EMPHASIS_RE.test(sectionHtml)) {
      sectionHtml = stripEmphasis(sectionHtml);
      sectionPatch.html = sectionHtml;
      fixed.push(`${L}: убраны выделения жирным/курсивом`);
    }
    const firstParagraph = (sectionHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? sectionHtml).slice(0, 600);
    // У вступления/заключения это эвристика по стилю, а не поломка: не роняем готовую оплаченную статью (zorvianix, 2026-10-15).
    if (looksLikeFactDump(firstParagraph)) {
      if (s.position === 0 || s.position >= 9990) fixed.push(`${L}: начало похоже на перечисление признаков — оставлено`);
      else problems.push(`${L}: текст начинается со списка признаков фото`);
    }

    // Вступление (0) и заключение (9990) — не фото-секции: у вступления заголовка нет по замыслу,
    // заголовок заключения фиксированный. Их уникальность/пустоту не проверяем (иначе вступление получало «Idea — …»),
    // объём — в блоке 3 по своим порогам.
    if (isIntroOutro(n)) {
      if (Object.keys(sectionPatch).length > 1) patch.sections.push(sectionPatch);
      continue;
    }
    const wc = s.wordCount || wordCount(sectionHtml);
    if (wc < MIN_SECTION_WORDS) problems.push(`${L}: всего ${wc} слов (нужно от ${MIN_SECTION_WORDS})`);
    const heading = s.heading ?? "";
    const key = headingKey(heading);
    const photo = s.photoId ? photoById.get(s.photoId) : undefined;
    // Та же логика дублей, что у плана и секций: слова ключа не отличительны, хвост только через тире, ≤ 70 символов.
    const unique = uniqueHeading(heading || "Idea", usedHeadings, {
      facts: (photo?.facts ?? undefined) as Record<string, unknown> | undefined,
      description: photo?.description ?? null,
      keyword: headingKw,
    });
    if (!heading.trim() || unique !== heading) {
      if (unique !== heading) {
        sectionPatch.heading = unique;
        const owner = headingOwner.get(key);
        fixed.push(
          !heading.trim()
            ? `${L}: заголовок был пуст — поставлен «${unique}»`
            : owner !== undefined
              ? `${L}: заголовок повторял секцию ${owner} — заменён на «${unique}»`
              : `${L}: заголовок «${heading}» заменён на «${unique}» (повтор или длиннее 70 символов)`,
        );
        if (article.html && heading) {
          const replaced = replaceHeadingInHtml(patch.article.html ?? article.html, heading, unique);
          if (replaced !== (patch.article.html ?? article.html)) patch.article.html = replaced;
        }
      } else {
        problems.push(`${L}: нет заголовка`);
      }
      headingOwner.set(headingKey(unique), n);
    } else {
      headingOwner.set(key, n);
    }
    if (sectionPatch.heading !== undefined || sectionPatch.html !== undefined) patch.sections.push(sectionPatch);
  }
  const photoSections = liveSections.filter((s) => !isIntroOutro(s.position));
  const sectionsLive = photoSections.filter((s) => (s.html ?? "").trim() && s.status !== "failed").length;
  if (sectionsLive < MIN_SECTIONS) problems.push(`В статье ${sectionsLive} разделов с текстом — публиковать нечего (нужно не меньше ${MIN_SECTIONS})`);

  // ── 3. Вступление, заключение, объём (оригинал :185-200) ────
  // Пороги общие с этапом intro_outro (introOutroParse.ts): что этап принял, то проверка и пропускает.
  const intro = article.introHtml || sections.find((s) => s.position === 0)?.html || "";
  const outro = article.outroHtml || sections.find((s) => s.position >= 9990)?.html || "";
  const introWords = wordCount(intro);
  const outroWords = wordCount(outro);
  if (!intro.trim()) problems.push("Нет вступления");
  else if (THINKING_RE.test(intro)) problems.push("Во вступлении черновые размышления модели");
  else if (introWords < INTRO_MIN_WORDS) problems.push(`Вступление: всего ${introWords} слов (нужно от ${INTRO_MIN_WORDS})`);
  if (!outro.trim()) problems.push("Нет заключения");
  else if (outroWords < OUTRO_MIN_WORDS) problems.push(`Заключение: всего ${outroWords} слов (нужно от ${OUTRO_MIN_WORDS})`);
  const totalWords = photoSections.reduce((sum, s) => sum + (s.wordCount || wordCount(s.html)), 0) + introWords + outroWords;
  if (totalWords < MIN_ARTICLE_WORDS) problems.push(`Статья короткая: ${totalWords} слов`);

  // ── 4. Мета: непустая, точечное восстановление из плана (оригинал :203-215 + stage77 при починке) ──
  let h1 = article.h1;
  let title = article.metaTitle;
  let desc = article.metaDescription;
  let slug = article.slug;
  const kw = (article.focusKeyword || article.keyword).trim();
  if (!h1.trim()) {
    h1 = (plan?.h1 ?? "").trim() || `${count} ${kw} Ideas`;
    patch.article.h1 = h1;
    fixed.push(`H1 был пуст — взят ${plan?.h1 ? "из плана" : "из ключа"}`);
  }
  if (!title.trim()) {
    title = (plan?.title ?? "").trim() || replaceCount(h1, count);
    patch.article.metaTitle = title;
    fixed.push(`SEO-тайтл был пуст — взят ${plan?.title ? "из плана" : "из H1"}`);
  }
  if (!desc.trim()) {
    const fromIntro = intro.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    desc = (plan?.metaDescription ?? "").trim() || fromIntro.slice(0, 155).replace(/\s+\S*$/, "");
    if (desc) {
      patch.article.metaDescription = desc;
      fixed.push(`Мета-описание было пустым — взято ${plan?.metaDescription ? "из плана" : "из вступления"}`);
    } else problems.push("Нет мета-описания");
  }
  const slugOk = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
  if (!slug || !slugOk(slug)) {
    const candidate = slugOk(plan?.slug ?? "") ? (plan!.slug as string) : slugify(kw);
    if (slugOk(candidate)) {
      patch.article.slug = candidate;
      fixed.push(`URL был пуст или некорректен («${slug}») — поставлен «${candidate}»`);
      slug = candidate;
    } else problems.push(`URL некорректен: «${slug}»`);
  }

  // ── 5. {{COUNT}} должен быть подставлен (оригинал: patchCount в сборке; при починке retargetCount) ──
  const fields: Array<["h1" | "metaTitle" | "metaDescription", string]> = [["h1", h1], ["metaTitle", title], ["metaDescription", desc]];
  for (const [field, value] of fields) {
    if (COUNT_RE.test(value)) {
      COUNT_RE.lastIndex = 0;
      patch.article[field] = replaceCount(value, count);
      fixed.push(`Метка количества в поле ${field} заменена на ${count}`);
    }
    COUNT_RE.lastIndex = 0;
  }
  let html = patch.article.html ?? article.html ?? "";
  if (COUNT_RE.test(html)) {
    COUNT_RE.lastIndex = 0;
    html = replaceCount(html, count);
    patch.article.html = html;
    fixed.push(`Метка количества в HTML заменена на ${count}`);
  }
  COUNT_RE.lastIndex = 0;

  // ── 6. Выделения в собранном HTML ──────────────────────────
  if (html && EMPHASIS_RE.test(html)) {
    patch.article.html = stripEmphasis(html);
    fixed.push("Из HTML убраны выделения жирным/курсивом");
  }
  if (!html.trim()) problems.push("Нет собранного HTML статьи");

  return { ok: problems.length === 0, problems, fixed, patch, sectionsLive, photosLive: livePhotos.length };
}

/** Сохранить детерминированные исправления проверки (мета, HTML, заголовки и текст секций). Общая для assemble и publish. */
export async function applyQualityPatch(articleId: string, patch: QualityPatch): Promise<void> {
  if (Object.keys(patch.article).length) await prisma.article.update({ where: { id: articleId }, data: patch.article });
  for (const sp of patch.sections) {
    await prisma.artSection.update({ where: { id: sp.id }, data: { ...(sp.heading !== undefined ? { heading: sp.heading } : {}), ...(sp.html !== undefined ? { html: sp.html } : {}) } });
  }
}

/** Проблема касается только вступления/заключения — её чинит повтор этапа intro_outro. */
export function isIntroOutroProblem(problem: string): boolean {
  return /^(Вступление|Заключение|Нет вступления|Нет заключения|Во вступлении)/.test(problem);
}
