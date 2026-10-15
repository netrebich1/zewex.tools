"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const ITEMS = [
  { href: "/analytics", label: "Обзор", exact: true },
  { href: "/analytics/pages", label: "Страницы" },
  { href: "/analytics/settings", label: "Настройки" },
];
/** Параметры периода и фильтров, которые переносятся между экранами. */
const KEEP = ["p", "from", "to", "cmp", "g", "m", "group"];

/** Подменю инструмента «Трафик сайтов»; выбранный период сохраняется при переходе между вкладками. */
export function AnalyticsNav() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = new URLSearchParams();
  for (const k of KEEP) {
    const v = sp.get(k);
    if (v) qs.set(k, v);
  }
  const q = qs.toString();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Трафик сайтов</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        const href = it.href === "/analytics/settings" || !q ? it.href : `${it.href}?${q}`;
        return <Link key={it.href} href={href} className={`tab ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
    </div>
  );
}
