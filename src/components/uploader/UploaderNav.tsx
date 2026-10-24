"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: "/pinterest/uploader", label: "Сегодня", exact: true },
  { href: "/pinterest/uploader/runs", label: "Запуски" },
  { href: "/pinterest/uploader/mapping", label: "Сопоставление" },
  { href: "/pinterest/uploader/agents", label: "Агенты" },
  { href: "/pinterest/uploader/settings", label: "Настройки" },
  { href: "/pinterest/uploader/guide", label: "Инструкция" },
];

/** Подменю инструмента «Заливка в Pinterest» (пилюли под шапкой, как у остальных инструментов Pinterest). */
export function UploaderNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 -mx-4 flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b border-line px-4 pb-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      <span className="hidden sm:inline text-[13px] font-semibold text-muted mr-2">Заливка в Pinterest</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return <Link key={it.href} href={it.href} className={`tab shrink-0 whitespace-nowrap ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
    </div>
  );
}
