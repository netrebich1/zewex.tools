"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/pinterest/pins", label: "Сегодня", exact: true },
  { href: "/pinterest/pins/moderation", label: "Модерация" },
  { href: "/pinterest/pins/export", label: "Выгрузка" },
  { href: "/pinterest/pins/styles", label: "Стили" },
  { href: "/pinterest/pins/settings", label: "Настройки" },
  { href: "/pinterest/pins/runs/new", label: "Новый прогон" },
];

/** Подменю раздела Pinterest Pins (пилюли под шапкой портала). */
export function PinsNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Pinterest Pins</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
