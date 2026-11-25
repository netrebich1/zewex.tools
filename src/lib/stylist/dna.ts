/**
 * «Стилист»: ДНК люксовых домов и метка «в духе бренда» для вещей масс-маркета.
 * Справочник — `brands.json` (ресерч 22.11.2026: суть стиля, коды, палитра, знаковые вещи с правилами по словам названия).
 * Два способа пометить вещь:
 *  1) бесплатно, при сборе каталога — слова названия совпали с правилом знаковой вещи (`ruleSpirit`): грубая подсказка;
 *  2) ИИ смотрит фото вещи со справочником перед глазами (`aiSpirit`, слот `vision`): точнее, с оценкой и объяснением,
 *     отличает «в духе» от «очень похоже на конкретную вещь».
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runSlot } from "@/lib/run";
import raw from "./brands.json";
import { CATEGORY_LABELS, pack, unpack } from "./consts";

export const PROJECT_SLUG = "stylist";
export const SLOT_VISION = "vision";

export type BrandIcon = { name: string; category: string; look: string; match?: { any?: string[]; all?: string[]; colors?: string[] } };
export type Brand = { id: string; name: string; tier: string; director?: string; dna: string; codes: string[]; palette: string[]; icons: BrandIcon[] };
/** Одна метка вещи. level: spirit — в духе бренда; lookalike — близко повторяет знаковую вещь. */
export type Spirit = { brand: string; source: "rule" | "ai"; level: "spirit" | "lookalike"; score: number; icon: string; why: string };

export const BRANDS = raw as unknown as Brand[];
export const BRAND_NAMES: Record<string, string> = Object.fromEntries(BRANDS.map((b) => [b.id, b.name]));

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Метки по словам названия: совпал тип вещи и слова правила. Цвет из правила, если задан, обязателен. */
export function ruleSpirit(name: string, category: string, color: string): Spirit[] {
  const t = norm(name);
  const out: Spirit[] = [];
  for (const b of BRANDS) {
    for (const icon of b.icons ?? []) {
      const m = icon.match;
      const any = (m?.any ?? []).map(norm).filter((s) => s.length >= 3);
      if (!m || !any.length || icon.category !== category) continue;
      if (!any.some((s) => t.includes(s))) continue;
      if (!(m.all ?? []).map(norm).every((s) => t.includes(s))) continue;
      if (m.colors?.length && !m.colors.includes(color)) continue;
      out.push({ brand: b.id, source: "rule", level: "spirit", score: 50, icon: icon.name, why: "по словам в названии вещи" });
      break;
    }
  }
  // Одно слово («трикотаж», «стёганая») подходит многим домам сразу — больше двух догадок только шумят.
  return out.slice(0, 2);
}

export const parseSpirits = (v: unknown): Spirit[] => (Array.isArray(v) ? (v as Spirit[]).filter((s) => s && typeof s.brand === "string" && BRAND_NAMES[s.brand]) : []);

/** Итог для вещи: метки ИИ главнее меток по словам (после проверки ИИ метки по словам не показываем). */
export function mergeSpirits(rule: Spirit[], saved: unknown, checkedByAi: boolean): { spirit: string; spiritData: Prisma.InputJsonValue } {
  const ai = parseSpirits(saved).filter((s) => s.source === "ai");
  const list = checkedByAi ? ai : rule;
  return { spirit: pack(list.map((s) => s.brand)).slice(0, 200), spiritData: list as unknown as Prisma.InputJsonValue };
}

/** Справочник для модели: коротко, одна строка на знаковую вещь. */
function reference(category: string): string {
  return BRANDS.map((b) => {
    const icons = (b.icons ?? []).filter((i) => i.category === category);
    return `### ${b.id} — ${b.name}\nDNA: ${b.dna}\nCodes: ${b.codes.join("; ")}${icons.length ? `\nIconic pieces of this type:\n${icons.map((i) => `- ${i.name}: ${i.look}`).join("\n")}` : ""}`;
  }).join("\n\n");
}

const SYSTEM = `You are a senior fashion stylist. You get ONE photo of a mass-market item (high street, not luxury) and a reference of luxury houses' design DNA.
Decide whether the item is clearly designed "in the spirit of" one of these houses, i.e. it borrows that house's recognisable codes: silhouette, material, construction, hardware, print, colour story.
Rules:
- Judge ONLY what is visible in the photo plus the product name. Ignore the model, pose, background and styling of other garments.
- Most mass-market items are generic: a plain T-shirt, basic jeans or an ordinary black blazer belong to no house. Returning an empty list is the normal, expected answer. Do not force a match.
- "lookalike" = the item closely echoes ONE specific iconic piece from the reference (same construction and signature detail). "spirit" = shares the house's codes without echoing a specific piece.
- score 0-100 = how confident a professional stylist would be. Return only matches with score >= 60, at most 2, best first.
- "why" — one sentence in Russian naming the concrete visible features (for the stylist). "icon" — the iconic piece's name from the reference for lookalike, otherwise "".
- Never claim the item is a counterfeit or uses a logo or trademark; this is about style similarity only.
Return ONLY JSON: {"matches":[{"brand":"<id from reference>","level":"spirit|lookalike","score":0,"icon":"","why":""}]}`;

/**
 * ИИ смотрит фото вещи и ставит метки. Расход — по правилу слота `vision` команды (ключ команды Zewex), в журнал расхода.
 * Возвращает метки (пустой список — «ни на кого не похоже», это тоже результат).
 */
export async function aiSpirit(userId: string, teamId: string | null, itemId: string): Promise<{ ok: true; spirits: Spirit[]; costUsd: number } | { ok: false; error: string }> {
  const item = await prisma.stItem.findUnique({ where: { id: itemId }, include: { store: { select: { brand: true } } } });
  if (!item) return { ok: false, error: "Вещь не найдена" };
  if (!/^https:\/\//i.test(item.imageUrl)) return { ok: false, error: "У вещи нет фото по https-ссылке" };
  const res = await runSlot({
    userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_VISION, timeoutMs: 90_000, meta: { teamId: teamId ?? undefined, refId: item.id },
    payload: {
      messages: [
        { role: "system", content: `${SYSTEM}\n\nREFERENCE\n\n${reference(item.category)}` },
        { role: "user", content: [
          { type: "text", text: `Item: ${item.name}\nType: ${CATEGORY_LABELS[item.category] ?? item.category} (${item.category})\nColour: ${item.colorName || item.color || "?"}\nStore: ${item.store.brand}\nDetected details: ${unpack(item.tags).join(", ") || "-"}` },
          { type: "image_url", image_url: { url: item.imageUrl, detail: "low" } },
        ] },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    },
  });
  if (!res.ok) return { ok: false, error: res.error ?? `ИИ ответил ошибкой ${res.status}` };
  const text = String((res.data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "");
  let parsed: { matches?: Array<{ brand?: string; level?: string; score?: number; icon?: string; why?: string }> };
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    return { ok: false, error: "ИИ вернул ответ не в том виде — попробуйте ещё раз" };
  }
  const spirits: Spirit[] = (Array.isArray(parsed.matches) ? parsed.matches : [])
    .filter((m) => m && typeof m.brand === "string" && BRAND_NAMES[m.brand] && Number(m.score) >= 60)
    .slice(0, 2)
    .map((m) => ({ brand: m.brand!, source: "ai", level: m.level === "lookalike" ? "lookalike" : "spirit", score: Math.min(100, Math.round(Number(m.score))), icon: String(m.icon ?? "").slice(0, 150), why: String(m.why ?? "").slice(0, 400) }));
  await prisma.stItem.update({ where: { id: item.id }, data: { spirit: pack(spirits.map((s) => s.brand)).slice(0, 200), spiritData: spirits as unknown as Prisma.InputJsonValue, spiritAt: new Date(), spiritAsked: null } });
  return { ok: true, spirits, costUsd: res.meta?.costUsd ?? 0 };
}
