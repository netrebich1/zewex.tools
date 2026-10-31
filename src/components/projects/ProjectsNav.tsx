"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean; count?: "overdue" }> = [
  { href: "/pinterest/projects", label: "Проекты", exact: true },
  { href: "/pinterest/projects/tasks", label: "Задачи", count: "overdue" },
];

/** Подменю раздела «Проекты» (пилюли под шапкой, как у остальных инструментов Pinterest). */
export function ProjectsNav({ counts }: { counts?: { overdue: number } | null }) {
  const pathname = usePathname();
  return (
    <div className="mb-5 -mx-4 flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-line px-4 pb-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      <span className="hidden sm:inline text-[13px] font-semibold text-muted mr-2">Проекты</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href || (pathname.startsWith("/pinterest/projects/") && !pathname.startsWith("/pinterest/projects/tasks")) : pathname.startsWith(it.href);
        const n = it.count && counts ? counts[it.count] : 0;
        return (
          <Link key={it.href} href={it.href} className={`tab shrink-0 whitespace-nowrap ${active ? "active" : ""}`}>
            {it.label}
            {n > 0 && <span className={`rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${active ? "bg-bg/20" : "bg-danger-soft text-danger"}`}>{n}</span>}
          </Link>
        );
      })}
    </div>
  );
}
