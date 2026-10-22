"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean; count?: "review" }> = [
  { href: "/pinterest/blog", label: "Обзор", exact: true },
  { href: "/pinterest/blog/review", label: "Проверка", count: "review" },
  { href: "/pinterest/blog/scenarios", label: "Сценарии" },
  { href: "/pinterest/blog/journal", label: "Журнал" },
  { href: "/pinterest/blog/sites", label: "Сайты" },
  { href: "/pinterest/blog/runs/new", label: "Новый запуск" },
];

/** Подменю сервиса «Pin Blog Article» (пилюли под шапкой портала, как у Пинов и Статей). */
export function BlogNav({ counts }: { counts?: { review: number } | null }) {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Pin Blog Article</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        const n = it.count && counts ? counts[it.count] : 0;
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            {it.label}
            {n > 0 && <span className={`rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${active ? "bg-bg/20" : "bg-brand-soft text-warn"}`}>{n}</span>}
          </Link>
        );
      })}
    </div>
  );
}
