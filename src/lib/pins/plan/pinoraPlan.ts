/**
 * План Pinora-пинов: какие типы (tobi / collage / tipo / …) получает каждый URL.
 * Типы раздаются «мешком без возврата» на весь прогон — равномерно и детерминированно по seed.
 * Планируем только недостающее: existingPinoraCount — число уже созданных PINORA-элементов страницы.
 */
import { mulberry32, shuffleWith } from "@/lib/pins/plan/seed";

export interface PinoraPlanPage {
  id: string;
  /** Ниша страницы (decor / nails / …) — сохраняется в результат как есть. */
  niche: string;
  existingPinoraCount: number;
  /** Пер-URL квота; null/0 → perPage. */
  quota?: number | null;
  /** Тема страницы — для исключений PinStyleExclusion (kind = pinora). */
  topic?: string;
}

export interface PinoraPlanInput {
  pages: PinoraPlanPage[];
  /** Выбранные типы пинов (recipe.sets.pinoraTypes). */
  types: string[];
  /** Сколько Pinora-пинов на URL по рецепту (mix.pinora). */
  perPage: number;
  seed: number;
  /** Исключения «тема|тип» (styleId = тип или `pinora:<тип>`). */
  exclusions?: Array<{ topic: string; styleId: string }>;
}

export interface PinoraPlanRow {
  pageId: string;
  pinType: string;
  niche: string;
  sortOrder: number;
}

/** Мешок без возврата: выдаёт элементы пула по кругу в случайном порядке, пока не исчерпает, затем перемешивает заново. */
export class TypeBag {
  private bag: string[] = [];
  constructor(private readonly pool: readonly string[], private readonly rng: () => number) {}
  next(): string {
    if (!this.pool.length) return "";
    if (!this.bag.length) this.bag = shuffleWith(this.pool, this.rng);
    return this.bag.shift() ?? "";
  }
}

/** Строит строки будущих PinRunItem (engine PINORA) только для недостающих пинов каждой страницы. */
export function planPinoraPins(input: PinoraPlanInput): PinoraPlanRow[] {
  const types = [...new Set(input.types.map((t) => t.trim()).filter(Boolean))];
  if (!types.length) return [];
  const rng = mulberry32(input.seed);
  const bag = new TypeBag(types, rng);
  const excluded = new Set<string>();
  for (const e of input.exclusions ?? []) {
    excluded.add(`${(e.topic || "").trim()}|${e.styleId.replace(/^pinora:/, "")}`);
  }
  const out: PinoraPlanRow[] = [];

  for (const page of input.pages) {
    const existing = Math.max(0, Math.floor(page.existingPinoraCount || 0));
    const override = Number(page.quota ?? 0);
    const quota = override > 0 ? Math.floor(override) : Math.max(0, Math.floor(Number(input.perPage) || 0));
    const need = quota - existing;
    if (need <= 0) continue;
    const topic = (page.topic || "").trim();
    for (let i = 0; i < need; i++) {
      let type = bag.next();
      // Исключённый по теме тип меняем на разрешённый; если разрешённых нет — оставляем как есть (как в старом автопилоте).
      if (excluded.has(`${topic}|${type}`)) {
        const ok = types.filter((t) => !excluded.has(`${topic}|${t}`));
        if (ok.length) type = ok[Math.floor(rng() * ok.length)];
      }
      out.push({ pageId: page.id, pinType: type, niche: page.niche, sortOrder: existing + i });
    }
  }
  return out;
}
