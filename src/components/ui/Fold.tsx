import type { ReactNode } from "react";

/**
 * Свёрнутый блок: заголовок с итогом видно всегда («18 этапов готово», «Затронутые статьи (7)»),
 * подробности — по нажатию. Без JavaScript (<details>), поэтому работает и на серверных страницах.
 * `bare` — без рамки, для блоков внутри карточек и строк.
 */
export function Fold({ title, summary, children, defaultOpen = false, bare = false, className = "" }: {
  title: ReactNode; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean; bare?: boolean; className?: string;
}) {
  return (
    <details open={defaultOpen} className={`group ${bare ? "" : "rounded-xl border border-line"} ${className}`}>
      <summary className={`flex cursor-pointer list-none items-center gap-2 select-none [&::-webkit-details-marker]:hidden ${bare ? "py-1" : "px-3 py-2.5"}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted transition group-open:rotate-90" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
        <span className="min-w-0 font-medium">{title}</span>
        {summary != null && <span className="help ml-auto shrink-0 text-right">{summary}</span>}
      </summary>
      <div className={bare ? "pt-1" : "px-3 pb-3"}>{children}</div>
    </details>
  );
}

/**
 * Длинное пояснение: видна одна короткая строка, остальное — по «Подробнее». Для описаний под заголовками
 * страниц и карточек, справок «как читать таблицу» и подсказок под полями.
 */
export function More({ short, children, className = "" }: { short: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={`group help ${className}`}>
      <summary className="cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        {short} <span className="whitespace-nowrap text-ink-2 underline decoration-dotted underline-offset-2 group-open:hidden">Подробнее</span>
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}
