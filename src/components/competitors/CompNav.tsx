"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/discovery/competitors", label: "Площадки", exact: true },
  { href: "/discovery/competitors/themes", label: "Темы" },
  { href: "/discovery/competitors/geo", label: "Гео" },
  { href: "/discovery/competitors/settings", label: "Настройки" },
];

/** Подменю инструмента «Анализ конкурентов» (пилюли под шапкой портала). */
export function CompNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Анализ конкурентов</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href || pathname.startsWith(`${it.href}/sites`) : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
