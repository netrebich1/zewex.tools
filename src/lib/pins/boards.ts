/**
 * Назначение досок Pinterest (PinBoard.purpose, 2026-10-29): «для всех», «только подборки идей», «только блог».
 * Блоговые статьи выбирают доски из blog + all, подборки — из ideas + all. Если подходящих нет — все доски сайта.
 */

export type BoardPurpose = "all" | "ideas" | "blog";
export const BOARD_PURPOSES: readonly BoardPurpose[] = ["all", "ideas", "blog"];
export const BOARD_PURPOSE_LABELS: Record<BoardPurpose, string> = { all: "Для всех статей", ideas: "Только подборки идей", blog: "Только блоговые статьи" };
export const asBoardPurpose = (v: unknown): BoardPurpose => (BOARD_PURPOSES.includes(v as BoardPurpose) ? (v as BoardPurpose) : "all");

/** Имена досок для статей этого вида. */
export function boardsFor(boards: ReadonlyArray<{ name: string; purpose?: string | null }>, kind: "ideas" | "blog"): string[] {
  const fit = boards.filter((b) => { const p = asBoardPurpose(b.purpose); return p === "all" || p === kind; }).map((b) => b.name);
  return fit.length ? fit : boards.map((b) => b.name);
}

/**
 * Запасная доска, когда модель не выбрала ни одной из списка: больше всего общих слов с ключом / заголовком
 * («repair damaged hair» → «… Hair …»), при равенстве — первая по порядку. Раньше бралась просто первая доска сайта.
 */
const STOP = new Set(["and", "the", "for", "with", "your", "you", "how", "what", "why", "best", "ideas", "idea", "inspo", "board", "look", "tips", "guide", "that", "this", "from", "over"]);
const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).map((w) => w.replace(/s$/, "")).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

export function bestBoard(names: readonly string[], ...texts: Array<string | null | undefined>): string | undefined {
  const words = new Set(tokens(texts.join(" ")));
  let best: string | undefined, top = 0;
  for (const n of names) {
    const hit = tokens(n).filter((w) => words.has(w)).length;
    if (hit > top) { top = hit; best = n; }
  }
  return best ?? names[0];
}

/** Есть ли у сайта хоть одна доска именно под блог (иначе прогон подскажет завести). */
export const hasBlogBoards = (boards: ReadonlyArray<{ purpose?: string | null }>): boolean => boards.some((b) => asBoardPurpose(b.purpose) === "blog");

/** Строка редактора досок: «Hair Care Tips [блог]» / «Nail Ideas [идеи]» / «Hairstyles» (для всех). */
export function parseBoardLine(line: string): { name: string; purpose: BoardPurpose } | null {
  const m = line.trim().match(/^(.*?)\s*\[(блог|blog|идеи|ideas|все|all)\]\s*$/i);
  const name = (m ? m[1] : line).trim();
  if (!name) return null;
  const tag = (m?.[2] ?? "").toLowerCase();
  return { name, purpose: tag === "блог" || tag === "blog" ? "blog" : tag === "идеи" || tag === "ideas" ? "ideas" : "all" };
}
export const boardLine = (b: { name: string; purpose?: string | null }): string => {
  const p = asBoardPurpose(b.purpose);
  return p === "blog" ? `${b.name} [блог]` : p === "ideas" ? `${b.name} [идеи]` : b.name;
};
