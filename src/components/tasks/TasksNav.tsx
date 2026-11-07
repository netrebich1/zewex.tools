"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/tasks", label: "Дашборд", exact: true },
  { href: "/tasks/today", label: "Сегодня" },
  { href: "/tasks/board", label: "Канбан" },
  { href: "/tasks/tree", label: "Дерево" },
  { href: "/tasks/projects", label: "Проекты" },
  { href: "/tasks/routines", label: "Регламент" },
  { href: "/tasks/reports", label: "Отчёты" },
  { href: "/tasks/settings", label: "Настройки" },
];

/** Подменю раздела «Задачи». */
export function TasksNav({ badge }: { badge?: { today: number; nudge: number } }) {
  const pathname = usePathname();
  return (
    <div className="mb-5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
      <div className="flex items-center gap-1.5 border-b border-line pb-3 whitespace-nowrap">
        <span className="text-[13px] font-semibold text-muted mr-2">Задачи</span>
        {ITEMS.map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
          const n = it.href === "/tasks/today" ? badge?.today : undefined;
          return <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>{it.label}{n ? <span className={`ml-1 rounded-full px-1.5 text-[11px] ${active ? "bg-bg/20" : "bg-ink/10"}`}>{n}</span> : null}</Link>;
        })}
      </div>
    </div>
  );
}
