"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/pinterest/keywords", label: "Ключи", exact: true },
  { href: "/pinterest/keywords/new", label: "Новые" },
  { href: "/pinterest/keywords/competitors", label: "Конкуренты" },
  { href: "/pinterest/keywords/collect", label: "Сбор" },
  { href: "/pinterest/keywords/compare", label: "Сравнение аккаунтов" },
  { href: "/pinterest/keywords/guide", label: "Инструкция" },
];

/** Подменю инструмента «Подбор ключей». Кластеры появятся на следующих этапах (docs/keyword-research/00-design.md). */
export function KeywordsNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 -mx-4 flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-line px-4 pb-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      <span className="hidden sm:inline text-[13px] font-semibold text-muted mr-2">Подбор ключей</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return <Link key={it.href} href={it.href} className={`tab shrink-0 whitespace-nowrap ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
    </div>
  );
}
