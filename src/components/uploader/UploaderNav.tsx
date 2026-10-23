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
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Заливка в Pinterest</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
    </div>
  );
}
