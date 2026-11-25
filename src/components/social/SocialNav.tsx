"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/discovery/social", label: "Прогоны", exact: true },
  { href: "/discovery/social/new", label: "Новый прогон" },
  { href: "/discovery/social/settings", label: "Шаблон Metricool" },
];

/** Подменю инструмента «Соцсети» (пилюли под шапкой портала). */
export function SocialNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Соцсети</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href || pathname.startsWith(`${it.href}/runs`) : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
