/**
 * Правила каркаса статьи по формату (src/lib/blog/scenarios.ts → Structure): что сказать планировщику, какие заметки дать
 * автору к каждому пункту и как привести план к нужному виду детерминированно (число пунктов, фото на каждом пункте подборки,
 * распределение пунктов большого списка по группам, число в H1 = реальному числу пунктов).
 */
import type { OutlineSection } from "./types";
import type { Structure } from "./scenarios";

export const LIST_STRUCTURES: Structure[] = ["numbered", "roundup", "workout"];

/** Подсказка планировщику (английский) — добавляется к промту плана. */
export function structureHint(st: Structure | undefined, n: number | null | undefined, key?: string): string {
  const N = n ?? 0;
  switch (st) {
    case "numbered":
      return `STRUCTURE — NUMBERED LIST: plan exactly ${N} sections of kind "list_item", one per item, in a logical order (most useful first). Heading = the item itself in 3-8 words (no number: numbering is added automatically). key_points: what to do or know and why it works, one concrete detail. You may add at most ONE quick_answer section before the items and ONE section after them (mistakes or when_to_see_pro). Give an image to the most visual items, about half of them.`;
    case "roundup":
      return `STRUCTURE — PHOTO ROUNDUP: plan exactly ${N} sections of kind "list_item", one per ${key === "roundup_recipes" ? "dish (a specific recipe people search for, e.g. 'Creamy Tomato Basil Soup')" : "idea (a specific, visual idea)"}. Heading = the ${key === "roundup_recipes" ? "dish name" : "idea name"} (no number). EVERY item MUST have an image whose query finds exactly that ${key === "roundup_recipes" ? "dish (e.g. 'creamy tomato basil soup in a bowl')" : "idea"}. Vary the items (no near-duplicates). No other sections except an optional short quick_answer first.`;
    case "big_list":
      return `STRUCTURE — BIG LIST of ${N} items: split the items into 4-10 themed groups; each group is one section of kind "list_group" with a heading naming the group (e.g. 'Deep Questions', 'Funny Questions'). Do not list the items in the plan, only describe each group in key_points. Give images to 2-4 groups. No other sections except an optional short quick_answer first.`;
    case "workout":
      return `STRUCTURE — WORKOUT: plan exactly ${N} sections of kind "list_item", one per exercise, in workout order (warm-up move first if useful). Heading = the exercise name. key_points: how to do it, sets x reps or time, one form cue. Then ONE plan_table section (weekly schedule: days x what to do) and ONE mistakes section. Give images to the exercises that are hard to picture.`;
    case "plan":
      return `STRUCTURE — DAY-BY-DAY PLAN: include one plan_table section per week of the plan (rows = days, columns = meals, workouts or tasks), a what_you_need section as the shopping or prep list, a tips section and, for diets, when_to_see_pro. Keep the plan realistic; never invent calorie counts.`;
    case "recipe":
      return `STRUCTURE — RECIPE: sections in this order: quick_answer (why this recipe works, 2-3 sentences), recipe_card (ingredients with exact amounts as <ul> plus one line with prep time, cook time and servings or yield), steps (numbered method), tips, variations (prose), storage (aftercare kind). Do not invent nutrition numbers.`;
    default:
      return "";
  }
}

/** Заметка автору к секции по формату (дополняет заметку плана). */
export function itemNote(st: Structure | undefined, kind: string, key?: string, groupItems?: number): string {
  if (kind === "list_group") return `Write exactly ${groupItems ?? 20} items as one <ol>, each item ONE line (5-18 words), no explanations, no numbers in the text, nothing repeated from other groups; one short intro sentence in <p> before the list.`;
  if (kind !== "list_item") return "";
  if (st === "roundup" && key === "roundup_recipes") return "One dish of a recipe roundup: what it is, why readers love it (flavor, texture, ease), one useful detail (main ingredients, diet fit, make-ahead) — 40-90 words. Do not write the full recipe and never invent exact minutes or calories.";
  if (st === "roundup") return "One idea of a photo roundup: what it looks like, why it works, how to copy it (2-3 concrete tips) — 40-90 words.";
  if (st === "workout") return "One exercise: <p> how to do it in 2-3 sentences, then a <ul> with 'Sets and reps:' (or 'Time:'), 'Form cue:' and 'Make it easier or harder:'.";
  return "One item of a numbered list: start with the concrete action or fact, then why it works and how to apply it; 2-3 short paragraphs or one paragraph plus 2-4 bullets. Do not number it and do not repeat other items.";
}

/** Распределить N пунктов большого списка по группам. */
export function splitItems(n: number, groups: number): number[] {
  const g = Math.max(1, groups);
  const base = Math.floor(n / g);
  const extra = n % g;
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Привести секции плана к формату: число пунктов, фото у пунктов подборки, заметки автору. Возвращает число пунктов. */
export function enforceStructure(sections: OutlineSection[], st: Structure | undefined, n: number | null | undefined, key?: string): { sections: OutlineSection[]; count: number | null } {
  if (!st || st === "sections" || st === "recipe" || st === "plan") return { sections, count: null };
  const N = n ?? 0;
  let out = sections;
  if (LIST_STRUCTURES.includes(st)) {
    const firstItem = out.findIndex((s) => s.kind === "list_item");
    const items = out.filter((s) => s.kind === "list_item").slice(0, N || undefined);
    const others = out.filter((s) => s.kind !== "list_item");
    const extrasBefore = (firstItem < 0 ? [] : out.slice(0, firstItem).filter((s) => s.kind !== "list_item")).slice(0, 1);
    const extrasAfter = others.filter((s) => !extrasBefore.includes(s)).slice(0, st === "workout" ? 2 : st === "roundup" ? 0 : 1);
    out = [...extrasBefore, ...items, ...extrasAfter];
    for (const s of items) {
      if (st === "roundup" && !s.image) s.image = { query: key === "roundup_recipes" ? `${s.heading} dish` : s.heading, orientation: "any" };
      const note = itemNote(st, s.kind, key);
      s.notes = [note, s.notes].filter(Boolean).join(" ");
    }
    out.forEach((s, i) => { s.position = i + 1; });
    return { sections: out, count: items.length };
  }
  if (st === "big_list") {
    const groups = out.filter((s) => s.kind === "list_group").slice(0, 10);
    const lead = out.filter((s) => s.kind === "quick_answer").slice(0, 1);
    const use = groups.length ? groups : out.slice(0, 6).map((s) => ({ ...s, kind: "list_group" }));
    const counts = splitItems(N, use.length);
    use.forEach((s, i) => {
      s.notes = [itemNote(st, "list_group", key, counts[i]), s.notes].filter(Boolean).join(" ");
      s.targetWords = Math.max(80, Math.round(counts[i] * 11 + 20));
    });
    out = [...lead, ...use];
    out.forEach((s, i) => { s.position = i + 1; });
    return { sections: out, count: N };
  }
  return { sections, count: null };
}

/** Число в начале заголовка → реальное число пунктов («31 Easy Soup Recipes» при 25 пунктах → «25 Easy Soup Recipes»). */
export function fixLeadingNumber(title: string, count: number | null | undefined): string {
  if (!count) return title;
  return String(title ?? "").replace(/^(\s*)\d{1,3}\+?(?=\s)/, `$1${count}`);
}

/** Реальное число пунктов по написанным секциям: список/тренировка — секции list_item, большой список/чеклист — строки <li>. */
export function countListItems(st: Structure | undefined, secs: Array<{ kind: string; html: string | null }>): number | null {
  if (!st) return null;
  if (st === "big_list") return secs.filter((s) => s.kind === "list_group").reduce((n, s) => n + ((s.html ?? "").match(/<li\b/gi)?.length ?? 0), 0);
  if (LIST_STRUCTURES.includes(st)) return secs.filter((s) => s.kind === "list_item").length;
  return null;
}
