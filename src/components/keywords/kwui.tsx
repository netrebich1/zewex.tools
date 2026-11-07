"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Числа по-русски: 12 345, «—» для пусто. */
export const fmt = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
export const pctOf = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? Math.round((100 * a) / b) : null);

/** Параметры адреса экрана: прочитать и поменять пачкой (без прокрутки наверх). */
export function useQueryNav() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const apply = useCallback((patch: Record<string, string | null | undefined>, opts: { keepPage?: boolean } = {}) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) v == null || v === "" ? q.delete(k) : q.set(k, v);
    if (!opts.keepPage) q.delete("pg");
    start(() => router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  }, [sp, pathname, router]);
  const replaceAll = useCallback((query: string) => start(() => router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false })), [pathname, router]);
  return { sp, apply, replaceAll, pending, pathname };
}

/** Кнопка-чип: выбран / не выбран. tone=danger — для «исключить». */
export function Chip({ on, onClick, children, tone, title }: { on: boolean; onClick: () => void; children: ReactNode; tone?: "danger"; title?: string }) {
  const cls = on
    ? tone === "danger" ? "border-danger bg-danger-soft text-danger" : "border-ink bg-ink text-bg"
    : "border-line text-ink-2 hover:border-line-2 hover:text-ink";
  return <button type="button" title={title} onClick={onClick} className={`min-h-9 sm:min-h-0 rounded-full border px-3 py-1.5 sm:px-2.5 sm:py-1 text-[12.5px] font-semibold transition ${cls}`}>{children}</button>;
}

/**
 * Значок подсказки с описанием метрики. Наведение — title; нажатие (на телефоне title не увидеть) —
 * плашка внизу экрана. Плашка через портал: внутри таблиц с прокруткой её бы обрезало.
 */
export function Hint({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label="Подсказка" title={text} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        className={`relative ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-ink/8 text-[10px] font-bold text-muted align-middle after:absolute after:-inset-2.5 after:content-[''] ${className}`}>?</button>
      {open && createPortal(
        <>
          <button type="button" aria-label="Закрыть подсказку" className="fixed inset-0 z-[70] cursor-default" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div role="tooltip" className="fixed inset-x-4 bottom-4 z-[71] mx-auto max-w-md rounded-xl border border-line bg-surface p-3 text-[13.5px] leading-snug text-ink-2 shadow-[var(--shadow-pop)]" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>{text}</div>
        </>,
        document.body,
      )}
    </>
  );
}
