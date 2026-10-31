"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean; not?: string; accent?: boolean }> = [
  { href: "/pinterest/pins", label: "Сегодня", exact: true },
  { href: "/pinterest/pins/export?today=1", label: "⬇ Файлы на сегодня", accent: true },
  { href: "/pinterest/pins/moderation", label: "Модерация" },
  { href: "/pinterest/pins/export", label: "Выгрузка" },
  { href: "/pinterest/pins/styles", label: "Стили" },
  { href: "/pinterest/pins/sites", label: "Сайты" },
  { href: "/pinterest/pins/runs", label: "Прогоны", not: "/pinterest/pins/runs/new" },
  { href: "/pinterest/pins/runs/new", label: "Новый прогон" },
  { href: "/pinterest/pins/guide", label: "Инструкция" },
];

/** Подменю раздела Pinterest Pins (пилюли под шапкой портала). */
export function PinsNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 -mx-4 flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-line px-4 pb-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      <span className="hidden sm:inline text-[13px] font-semibold text-muted mr-2">Pinterest Pins</span>
      {ITEMS.map((it) => {
        const active = !it.accent && (it.exact ? pathname === it.href : pathname.startsWith(it.href) && !("not" in it && it.not && pathname.startsWith(it.not)));
        // Выделенная ссылка: все файлы на сегодня по всем сайтам.
        if (it.accent) return <Link key={it.href} href={it.href} className="tab shrink-0 whitespace-nowrap border border-brand/60 bg-brand/15 font-semibold text-brand hover:bg-brand/25">{it.label}</Link>;
        return (
          <Link key={it.href} href={it.href} className={`tab shrink-0 whitespace-nowrap ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
