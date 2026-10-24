"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/gambling/domains", label: "Подборы", exact: true },
  { href: "/gambling/domains/new", label: "Новый подбор" },
];

/** Подменю инструмента «Подбор доменов» (пилюли под шапкой портала). */
export function DomainsNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Подбор доменов</span>
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

export const STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = {
  QUEUED: "neutral",
  RUNNING: "brand",
  DONE: "ok",
  FAILED: "danger",
  STOPPED: "warn",
};
