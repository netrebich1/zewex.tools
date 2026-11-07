"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: "/pinterest/copy", label: "Запас", exact: true },
  { href: "/pinterest/copy/batches", label: "Партии" },
  { href: "/pinterest/copy/articles", label: "Собранные статьи" },
  { href: "/pinterest/copy/settings", label: "Сайты и правила" },
];

/** Подменю сервиса «Article Copy» (пилюли под шапкой портала, как у Статей и Блога). */
export function CopyNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-nowrap items-center gap-1.5 overflow-x-auto -mx-4 px-4 sm:flex-wrap sm:mx-0 sm:px-0 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2 shrink-0 whitespace-nowrap">Article Copy</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href || pathname.startsWith("/pinterest/copy/cores") : pathname.startsWith(it.href);
        return <Link key={it.href} href={it.href} className={`tab shrink-0 whitespace-nowrap ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
    </div>
  );
}
