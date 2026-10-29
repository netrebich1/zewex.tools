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
