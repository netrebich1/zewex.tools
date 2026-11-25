/**
 * Визуальное сравнение двух версий статьи (порт идеи VersionDiff / htmlDiff из article-jumble-maker).
 * 1) Статья режется на блоки (абзацы, заголовки, пункты списков, цитаты, картинки).
 * 2) Блоки сопоставляются выравниванием по похожести текста — вставка или удаление одного абзаца
 *    не превращается в «всё дальше заменено».
 * 3) Внутри пары блоков — пословный diff (LCS), регистр и пунктуация по краям слова не считаются правкой.
 * Работает и в браузере, и на сервере: без DOM, только строки.
 */

export type DiffBlock = { tag: string; text: string };
export type DiffToken = { t: string; op: "eq" | "add" | "del" };
export type DiffRow =
  | { kind: "same"; tag: string; old: DiffToken[]; neu: DiffToken[] }
  | { kind: "changed"; tag: string; old: DiffToken[]; neu: DiffToken[] }
  | { kind: "added"; tag: string; neu: DiffToken[] }
  | { kind: "removed"; tag: string; old: DiffToken[] };
export type DiffResult = { rows: DiffRow[]; similarity: number; added: number; removed: number; oldWords: number; newWords: number };

const BLOCK_RE = /<(h[1-6]|p|li|blockquote|figcaption|td|th|dt|dd)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>|<iframe\b[^>]*>[\s\S]*?<\/iframe>|\[embed\][\s\S]*?\[\/embed\]/gi;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const textOf = (html: string) => decode(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Блоки статьи по порядку. Вложенные (p внутри li/blockquote) не дублируются: берётся внешний блок. */
export function htmlBlocks(html: string): DiffBlock[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/\[caption[^\]]*\]|\[\/caption\]/g, "");
  const out: DiffBlock[] = [];
  for (const m of clean.matchAll(BLOCK_RE)) {
    const whole = m[0];
    if (/^<img/i.test(whole)) {
      const alt = whole.match(/\balt\s*=\s*"([^"]*)"/i)?.[1] ?? "";
      out.push({ tag: "img", text: `🖼 ${decode(alt) || "картинка"}` });
      continue;
    }
    if (/^<iframe|^\[embed/i.test(whole)) {
      out.push({ tag: "embed", text: "▶ вставка" });
      continue;
    }
    const tag = m[1]!.toLowerCase();
    const inner = m[2] ?? "";
    // Картинки внутри абзаца — отдельным блоком, чтобы их пропажа была видна.
    for (const img of inner.match(/<img\b[^>]*>/gi) ?? []) out.push({ tag: "img", text: `🖼 ${decode(img.match(/\balt\s*=\s*"([^"]*)"/i)?.[1] ?? "") || "картинка"}` });
    const text = textOf(inner);
    if (text) out.push({ tag, text });
  }
  // Текст без блочной разметки (голые строки в WordPress) — абзацами по пустым строкам.
  if (!out.length && clean.trim()) for (const part of clean.split(/\n\s*\n/)) if (textOf(part)) out.push({ tag: "p", text: textOf(part) });
  return out;
}

const tokenize = (s: string) => s.match(/\S+/g) ?? [];
const norm = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || w;

/** Похожесть блоков 0..1 — коэффициент Дайса по множествам слов. */
function blockSim(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let common = 0;
  const seen = new Set<string>();
  for (const w of b) if (sa.has(w) && !seen.has(w)) {
    common++;
    seen.add(w);
  }
  return (2 * common) / (sa.size + new Set(b).size);
}

/** Пословный diff двух последовательностей (LCS). Длинные блоки режутся по общему префиксу и суффиксу. */
export function wordDiff(a: string[], b: string[]): { old: DiffToken[]; neu: DiffToken[]; common: number } {
  const na = a.map(norm);
  const nb = b.map(norm);
  let pre = 0;
  while (pre < a.length && pre < b.length && na[pre] === nb[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && na[a.length - 1 - suf] === nb[b.length - 1 - suf]) suf++;
  const A = na.slice(pre, a.length - suf);
  const B = nb.slice(pre, b.length - suf);
  const old: DiffToken[] = a.slice(0, pre).map((t) => ({ t, op: "eq" }));
  const neu: DiffToken[] = b.slice(0, pre).map((t) => ({ t, op: "eq" }));
  let common = pre + suf;
  if (A.length * B.length > 4_000_000) {
    // Огромный блок без общих краёв: считаем целиком заменённым, чтобы не повесить вкладку.
    old.push(...a.slice(pre, a.length - suf).map((t) => ({ t, op: "del" as const })));
    neu.push(...b.slice(pre, b.length - suf).map((t) => ({ t, op: "add" as const })));
  } else {
    const n = A.length;
    const m = B.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        old.push({ t: a[pre + i]!, op: "eq" });
        neu.push({ t: b[pre + j]!, op: "eq" });
        common++;
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
        neu.push({ t: b[pre + j]!, op: "add" });
        j++;
      } else {
        old.push({ t: a[pre + i]!, op: "del" });
        i++;
      }
    }
  }
  old.push(...a.slice(a.length - suf).map((t) => ({ t, op: "eq" as const })));
  neu.push(...b.slice(b.length - suf).map((t) => ({ t, op: "eq" as const })));
  return { old, neu, common };
}

/** Порог похожести, ниже которого блоки не считаются одним и тем же абзацем. */
const MATCH_MIN = 0.12;

export function diffHtml(oldHtml: string, newHtml: string): DiffResult {
  const A = htmlBlocks(oldHtml);
  const B = htmlBlocks(newHtml);
  const ta = A.map((x) => tokenize(x.text));
  const tb = B.map((x) => tokenize(x.text));
  const na = ta.map((t) => t.map(norm));
  const nb = tb.map((t) => t.map(norm));
  const n = A.length;
  const m = B.length;
  // Выравнивание блоков: максимум суммарной похожести, пропуск блока бесплатен.
  const sim = (i: number, j: number) => {
    const ka = A[i]!.tag === "img" || A[i]!.tag === "embed";
    const kb = B[j]!.tag === "img" || B[j]!.tag === "embed";
    if (ka !== kb) return 0;
    if (ka) return A[i]!.tag === B[j]!.tag ? (A[i]!.text === B[j]!.text ? 1 : 0.6) : 0;
    const d = blockSim(na[i]!, nb[j]!);
    // Заголовки одного уровня этап H2 переписывает целиком — всё равно показываем парой «было → стало».
    return A[i]!.tag === B[j]!.tag && /^h[1-6]$/.test(A[i]!.tag) ? Math.max(d, MATCH_MIN) : d;
  };
  const score: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const S: Float64Array[] = Array.from({ length: n }, () => new Float64Array(m));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) S[i]![j] = sim(i, j);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = S[i]![j]!;
      const take = s >= MATCH_MIN ? score[i + 1]![j + 1]! + s : -1;
      score[i]![j] = Math.max(take, score[i + 1]![j]!, score[i]![j + 1]!);
    }
  }
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let common = 0;
  let i = 0;
  let j = 0;
  const oldWords = ta.reduce((a, t) => a + t.length, 0);
  const newWords = tb.reduce((a, t) => a + t.length, 0);
  while (i < n || j < m) {
    if (i < n && j < m && S[i]![j]! >= MATCH_MIN && Math.abs(score[i]![j]! - (score[i + 1]![j + 1]! + S[i]![j]!)) < 1e-4) {
      const d = wordDiff(ta[i]!, tb[j]!);
      common += d.common;
      const changed = d.old.some((x) => x.op !== "eq") || d.neu.some((x) => x.op !== "eq");
      added += d.neu.filter((x) => x.op === "add").length;
      removed += d.old.filter((x) => x.op === "del").length;
      rows.push({ kind: changed ? "changed" : "same", tag: B[j]!.tag, old: d.old, neu: d.neu });
      i++;
      j++;
    } else if (i < n && (j >= m || score[i + 1]![j]! >= score[i]![j + 1]!)) {
      removed += ta[i]!.length;
      rows.push({ kind: "removed", tag: A[i]!.tag, old: ta[i]!.map((t) => ({ t, op: "del" })) });
      i++;
    } else {
      added += tb[j]!.length;
      rows.push({ kind: "added", tag: B[j]!.tag, neu: tb[j]!.map((t) => ({ t, op: "add" })) });
      j++;
    }
  }
  const similarity = oldWords + newWords ? Math.round(((2 * common) / (oldWords + newWords)) * 100) : 100;
  return { rows, similarity, added, removed, oldWords, newWords };
}
