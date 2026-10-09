/**
 * План ИИ-пинов (engine = OPENAI): какой набор и какие шаблоны получает каждый URL.
 * Планируем только недостающее: existingAiCount — число УЖЕ созданных OPENAI-элементов
 * страницы (Pinora/Canvas/фото в квоту не входят). Чистая функция, детерминирована по seed.
 */
import { BalancedPicker, exclusionSet, pickSetForPage, type PinSetLike } from "@/lib/pins/plan/balanced";
import { mulberry32 } from "@/lib/pins/plan/seed";

/** Страница прогона в терминах планировщика ИИ-пинов. */
export interface AiPlanPage {
  id: string;
  topic: string;
  /** Сколько OPENAI-пинов у страницы уже есть. */
  existingAiCount: number;
  /** Пер-URL квота (PinRunPage.pinQuota); null/0 → perPage из рецепта. */
  quota?: number | null;
  /** Уже назначенный набор (PinRunPage.pinSetId); если его нет в `sets` — выбирается заново. */
  setId?: string | null;
  /** Шаблоны уже созданных пинов страницы — чтобы не повторять их при дозаполнении. */
  existingStyleIds?: string[];
}

export interface AiPlanInput {
  pages: AiPlanPage[];
  sets: PinSetLike[];
  /** PinStyleExclusion сайта (kind = ai): пара «тема|шаблон» не назначается. */
  exclusions: Array<{ topic: string; styleId: string }>;
  /** Сколько ИИ-пинов на URL по рецепту (mix.ai). */
  perPage: number;
  seed: number;
  /** Сколько раз каждый шаблон уже использован в прогоне (для баланса между дозаполнениями). */
  usedCounts?: Map<string, number>;
}

export interface AiPlanRow {
  pageId: string;
  styleId: string;
  setId: string;
  sortOrder: number;
}

/** Квота ИИ-пинов для страницы: пер-URL override сильнее perPage; отрицательные → 0. */
export function resolveAiQuota(page: Pick<AiPlanPage, "quota">, perPage: number): number {
  const override = Number(page.quota ?? 0);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return Math.max(0, Math.floor(Number(perPage) || 0));
}

/** Строит строки будущих PinRunItem (engine OPENAI) только для недостающих пинов каждой страницы. */
export function planAiPins(input: AiPlanInput): AiPlanRow[] {
  const sets = input.sets.filter((s) => s.styleIds.length > 0);
  if (!sets.length) return [];
  const rng = mulberry32(input.seed);
  const picker = new BalancedPicker(rng);
  picker.seedCounts(input.usedCounts);
  const excluded = exclusionSet(input.exclusions);
  const setById = new Map(sets.map((s) => [s.id, s] as const));
  const out: AiPlanRow[] = [];

  for (const page of input.pages) {
    const set = (page.setId ? setById.get(page.setId) : undefined) ?? pickSetForPage(sets, page, rng);
    if (!set) continue;
    const existing = Math.max(0, Math.floor(page.existingAiCount || 0));
    const need = resolveAiQuota(page, input.perPage) - existing;
    if (need <= 0) continue;

    const topic = page.topic || "";
    const allowed = set.styleIds.filter((id) => !excluded.has(`${topic.trim()}|${id}`));
    const pool = allowed.length ? allowed : set.styleIds;
    const have = (page.existingStyleIds ?? []).filter(Boolean);
    const picked = picker.pick(pool, need, have);
    picked.forEach((styleId, i) => {
      out.push({ pageId: page.id, styleId, setId: set.id, sortOrder: existing + i });
    });
  }
  return out;
}
