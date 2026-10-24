/**
 * Бесплатная проверка качества инфо-статьи перед сборкой/публикацией. Детерминированные починки — в patch (сразу сохраняются),
 * остальное — список проблем. Проблемы секций помечены «Секция N: …» — сборка переписывает такие секции один раз.
 */
import type { BlogPhoto, BlogPost, BlogSection } from "@prisma/client";
import { blockOf, wantsTable } from "./blocks";
import { countWords, ensureTableHead } from "./text";
import type { BlogOutline, BlogRecipeParams } from "./types";

export type QualityResult = {
  ok: boolean;
  problems: string[];
  fixed: string[];
  patch: { sections: Array<{ id: string; html: string; wordCount: number }>; photos: Array<{ id: string; altText: string }> };
};

const JUNK_RE = /\b(as an ai|i cannot|i can't help|let me think|the user wants|here is the json|lorem ipsum)\b/i;

/** Выдуманный личный опыт («I've tried both methods»): автору запрещено, проверяем детерминированно. */
export const INVENTED_EXPERIENCE = /\b(I(?:'ve| have) (?:tried|tested|used|been using|learned from trying)|I tested|I tried (?:both|every|all|it|them|this)|in my (?:own )?(?:experience|testing|tests)|after (?:years|months|weeks) of (?:testing|trying))\b/i;

export function inventedExperience(html: string | null | undefined): string | null {
  const m = String(html ?? "").replace(/<[^>]+>/g, " ").match(INVENTED_EXPERIENCE);
  return m ? m[0] : null;
}

export function checkPostQuality(post: BlogPost, outline: BlogOutline | null, params: BlogRecipeParams, sections: BlogSection[], photos: BlogPhoto[]): QualityResult {
  const problems: string[] = [];
  const fixed: string[] = [];
  const patch: QualityResult["patch"] = { sections: [], photos: [] };

  const intro = post.introHtml ?? "";
  const iw = countWords(intro);
  if (!intro.trim()) problems.push("Нет вступления");
  else if (iw < 35) problems.push(`Вступление: всего ${iw} слов (минимум 35)`);
  else if (iw > 200) problems.push(`Вступление: ${iw} слов (максимум 200)`);
  const concl = post.conclusionHtml ?? "";
  const cw = countWords(concl);
  if (!concl.trim()) problems.push("Нет заключения");
  else if (cw < 25) problems.push(`Заключение: всего ${cw} слов (минимум 25)`);
  for (const [label, html] of [["Вступление", intro], ["Заключение", concl], ["Выводы", post.takeawaysHtml ?? ""], ["Дисклеймер", post.disclaimerHtml ?? ""]] as const) {
    if (html && (/\{\{|\}\}/.test(html) || JUNK_RE.test(html))) problems.push(`${label}: служебный текст или плейсхолдеры`);
    const inv = inventedExperience(html);
    if (inv) problems.push(`${label}: выдуманный личный опыт («${inv}»)`);
  }
  const faqHtml = (Array.isArray(post.faq) ? (post.faq as Array<{ answer?: string }>) : []).map((f) => f.answer ?? "").join(" ");
  const invFaq = inventedExperience(faqHtml);
  if (invFaq) problems.push(`FAQ: выдуманный личный опыт («${invFaq}»)`);

  const live = sections.filter((s) => s.position >= 1).sort((a, b) => a.position - b.position);
  if (live.length < 3) problems.push(`Секций всего ${live.length} (минимум 3)`);
  const keys = new Set<string>();
  let total = iw + cw + countWords(post.takeawaysHtml ?? "");
  for (const s of live) {
    const spec = blockOf(s.kind);
    let html = s.html ?? "";
    if (!html.trim() || s.status !== "written") { problems.push(`Секция ${s.position}: нет текста`); continue; }
    const k = s.heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k) problems.push(`Секция ${s.position}: пустой заголовок`);
    else if (keys.has(k)) problems.push(`Секция ${s.position}: заголовок повторяет другую секцию`);
    keys.add(k);
    // Детерминированно: <h2> и картинки внутри секции, таблицы без <thead>
    let changed = false;
    if (/<h2\b/i.test(html)) { html = html.replace(/<h2\b[^>]*>/gi, "<h3>").replace(/<\/h2>/gi, "</h3>"); changed = true; }
    if (/<img\b|<figure\b|\[caption/i.test(html)) { html = html.replace(/<figure\b[\s\S]*?<\/figure>/gi, "").replace(/\[caption\b[\s\S]*?\[\/caption\]/gi, "").replace(/<img\b[^>]*>/gi, ""); changed = true; }
    if (/<table\b/i.test(html) && !/<thead\b/i.test(html)) { html = ensureTableHead(html); changed = true; }
    if (changed) { patch.sections.push({ id: s.id, html, wordCount: countWords(html) }); fixed.push(`секция ${s.position}: убраны лишние заголовки/картинки, таблица с шапкой`); }
    const w = countWords(html);
    total += w;
    const b = (s.brief ?? {}) as { targetWords?: number };
    const min = Math.max(40, Math.round((b.targetWords ?? spec.words[0]) * 0.45));
    if (w < min) problems.push(`Секция ${s.position}: всего ${w} слов (нужно от ${min})`);
    if (/\{\{|\}\}/.test(html) || JUNK_RE.test(html)) problems.push(`Секция ${s.position}: служебный текст или плейсхолдеры`);
    if (/```|^#{1,6}\s/m.test(html)) problems.push(`Секция ${s.position}: markdown вместо HTML`);
    if (wantsTable(s.kind) && !/<table\b/i.test(html)) problems.push(`Секция ${s.position}: блок «${spec.label}» без таблицы`);
    if (s.kind === "steps" && !/<ol\b/i.test(html)) problems.push(`Секция ${s.position}: шаги без нумерованного списка`);
    // Группа большого списка/чеклиста: пунктов столько, сколько задал план («Write exactly K items»)
    if (s.kind === "list_group") {
      const want = Number(String((s.brief as { notes?: string } | null)?.notes ?? "").match(/exactly (\d+) items/)?.[1] ?? 0);
      const got = (html.match(/<li\b/gi) ?? []).length;
      if (want && got < Math.floor(want * 0.85)) problems.push(`Секция ${s.position}: пунктов ${got}, нужно ${want} — допишите группу до ${want} пунктов, каждый в одну строку`);
    }
    if (/\b(in the photo|pictured above|as you can see in the image|the image shows)\b/i.test(html)) problems.push(`Секция ${s.position}: ссылается на картинку словами`);
    const inv = inventedExperience(html);
    if (inv) problems.push(`Секция ${s.position}: выдуманный личный опыт («${inv}») — убрать, первое лицо только для мнения или совета`);
  }
  const faq = Array.isArray(post.faq) ? (post.faq as Array<{ question?: string; answer?: string }>) : [];
  total += faq.reduce((n, f) => n + countWords(f.question ?? "") + countWords(f.answer ?? ""), 0);
  if (outline?.faq.enabled && faq.length < 2) problems.push(`FAQ: вопросов ${faq.length} (план требует ${outline.faq.count})`);
  if (outline?.disclaimer && !(post.disclaimerHtml ?? "").trim()) problems.push("Нет дисклеймера, хотя тема требует");
  if (total < Math.round(params.length.min * 0.6)) problems.push(`Объём статьи ${total} слов — меньше ${Math.round(params.length.min * 0.6)} (минимум сценария ${params.length.min})`);
  if (total > Math.round(params.length.max * 1.6)) problems.push(`Объём статьи ${total} слов — больше ${Math.round(params.length.max * 1.6)} (максимум сценария ${params.length.max})`);

  const livePhotos = photos.filter((p) => !p.excluded);
  if (!livePhotos.some((p) => p.slotKey === "hero")) problems.push("Нет главного фото (hero)");
  for (const p of livePhotos) {
    if (!p.altText.trim()) { patch.photos.push({ id: p.id, altText: (p.description || post.keyword).slice(0, 300) }); fixed.push(`фото ${p.slotKey}: alt из описания`); }
  }
  return { ok: problems.length === 0, problems, fixed, patch };
}

/** Проблема относится к секции N. */
export function sectionProblemOf(p: string): number | null {
  const m = p.match(/^Секция (\d+):/);
  return m ? Number(m[1]) : null;
}
