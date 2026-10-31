"use client";
import { useMemo, useState } from "react";
import { diffHtml, type DiffRow, type DiffToken } from "@/lib/deepl/htmlDiff";

/**
 * Сравнение двух версий статьи с подсветкой: удалённое — красным зачёркнутым, добавленное — жёлтым,
 * вписанные ключи — фиолетовым. Режимы: «Правки» (одна колонка, как в рецензировании) и «Рядом» (было | стало по абзацам).
 */
export function DiffView({ oldHtml, newHtml, oldLabel, newLabel, keywords = [] }: { oldHtml: string; newHtml: string; oldLabel: string; newLabel: string; keywords?: string[] }) {
  const [layout, setLayout] = useState<"inline" | "side">("inline");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const diff = useMemo(() => diffHtml(oldHtml, newHtml), [oldHtml, newHtml]);
  const isKw = useMemo(() => keywordMatcher(keywords), [keywords]);
  const rows = onlyChanged ? diff.rows.filter((r) => r.kind !== "same") : diff.rows;
  const changedBlocks = diff.rows.filter((r) => r.kind !== "same").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span><b>{diff.similarity}%</b> <span className="text-muted">совпадает с «{oldLabel}»</span></span>
        <span className="text-muted">слов {diff.oldWords} → {diff.newWords}</span>
        <span><span className="rounded bg-brand-soft px-1">+{diff.added}</span> <span className="rounded bg-danger-soft px-1 text-danger line-through">−{diff.removed}</span></span>
        <span className="text-muted">изменено абзацев {changedBlocks} из {diff.rows.length}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> только изменённые</label>
          {(["inline", "side"] as const).map((l) => (
            <button key={l} type="button" className={`btn-ghost btn-sm ${layout === l ? "!bg-ink/10" : ""}`} onClick={() => setLayout(l)}>
              {l === "inline" ? "Правки" : "Было | стало"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[12px] text-muted">
        <span><span className="rounded bg-brand-soft px-1 text-ink">новое</span> добавлено</span>
        <span><span className="rounded bg-danger-soft px-1 text-danger line-through">старое</span> удалено</span>
        {keywords.length > 0 && <span><span className="rounded bg-violet-500/20 px-1 text-ink">ключ</span> вписан ключ</span>}
      </div>

      {rows.length === 0 ? (
        <p className="help">{diff.rows.length ? "Различий нет." : "В версиях нет текста."}</p>
      ) : layout === "inline" ? (
        <div className="max-h-[640px] space-y-2 overflow-auto rounded-lg border border-line bg-surface p-4 text-[15px] leading-relaxed">
          {rows.map((r, i) => <Block key={i} row={r} side="both" isKw={isKw} />)}
        </div>
      ) : (
        <div className="max-h-[640px] overflow-auto rounded-lg border border-line bg-surface">
          <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-line bg-surface-2 text-[13px] font-medium">
            <div className="px-3 py-2">{oldLabel}</div>
            <div className="border-l border-line px-3 py-2">{newLabel}</div>
          </div>
          {rows.map((r, i) => (
            <div key={i} className={`grid grid-cols-2 border-b border-line/60 text-[14px] leading-relaxed ${r.kind === "same" ? "" : "bg-ink/[0.02]"}`}>
              <div className="min-w-0 px-3 py-2">{r.kind !== "added" ? <Block row={r} side="old" isKw={isKw} /> : null}</div>
              <div className="min-w-0 border-l border-line px-3 py-2">{r.kind !== "removed" ? <Block row={r} side="new" isKw={isKw} /> : null}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TAG_CLASS: Record<string, string> = {
  h1: "text-[22px] font-semibold",
  h2: "text-[19px] font-semibold",
  h3: "text-[17px] font-semibold",
  h4: "font-semibold",
  li: "pl-4 before:-ml-4 before:mr-2 before:content-['•']",
  blockquote: "border-l-2 border-line-2 pl-3 italic",
  img: "text-[13px] text-muted",
  embed: "text-[13px] text-muted",
  figcaption: "text-[13px] text-muted",
};

function Block({ row, side, isKw }: { row: DiffRow; side: "old" | "new" | "both"; isKw: (t: string) => boolean }) {
  const cls = `${TAG_CLASS[row.tag] ?? ""} [overflow-wrap:anywhere]`;
  const whole = row.kind === "added" ? "rounded bg-brand-soft/60 px-1" : row.kind === "removed" ? "rounded bg-danger-soft/60 px-1" : "";
  let tokens: DiffToken[];
  if (side === "old") tokens = row.kind === "added" ? [] : row.old;
  else if (side === "new") tokens = row.kind === "removed" ? [] : row.neu;
  else tokens = row.kind === "added" ? row.neu : row.kind === "removed" ? row.old : merge(row.old, row.neu);
  return (
    <div className={`${cls} ${whole}`}>
      {row.tag !== "p" && row.tag !== "li" && row.tag !== "img" && row.tag !== "embed" && <span className="mr-1.5 align-middle font-mono text-[10px] font-normal text-muted">{row.tag.toUpperCase()}</span>}
      {tokens.map((t, i) => (
        <span key={i}>
          {i > 0 && " "}
          {t.op === "eq" ? t.t : t.op === "del" ? <del className="rounded bg-danger-soft px-0.5 text-danger">{t.t}</del> : <ins className={`rounded px-0.5 no-underline ${isKw(t.t) ? "bg-violet-500/25" : "bg-brand-soft"}`}>{t.t}</ins>}
        </span>
      ))}
    </div>
  );
}

/** Одна колонка «как в рецензировании»: общие слова один раз, удалённые перед добавленными на месте правки. */
function merge(old: DiffToken[], neu: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < neu.length) {
    while (i < old.length && old[i]!.op === "del") out.push(old[i++]!);
    while (j < neu.length && neu[j]!.op === "add") out.push(neu[j++]!);
    if (i < old.length && j < neu.length) {
      out.push(neu[j]!);
      i++;
      j++;
    } else if (i < old.length) out.push(old[i++]!);
    else if (j < neu.length) out.push(neu[j++]!);
  }
  return out;
}

/** Слово относится к ключу: совпадает основа (без 2 последних букв — падежные окончания). */
function keywordMatcher(keywords: string[]): (t: string) => boolean {
  const stems = keywords
    .flatMap((k) => k.toLowerCase().split(/\s+/))
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.max(4, w.length - 2)));
  if (!stems.length) return () => false;
  return (t) => {
    const w = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return w.length >= 4 && stems.some((s) => w.startsWith(s));
  };
}
