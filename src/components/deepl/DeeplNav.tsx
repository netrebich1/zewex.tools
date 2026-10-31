"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/discovery/deepl", label: "Прогоны", exact: true },
  { href: "/discovery/deepl/new", label: "Новый прогон" },
  { href: "/discovery/deepl/keys", label: "Ключи DeepL" },
  { href: "/discovery/deepl/settings", label: "Промты и сценарии" },
];

/** Подменю инструмента «DeepL Articler» (пилюли под шапкой портала). */
export function DeeplNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">DeepL Articler</span>
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

export const JOB_TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = {
  QUEUED: "neutral",
  RUNNING: "brand",
  DONE: "ok",
  FAILED: "danger",
  STOPPED: "warn",
};

export const ITEM_TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = {
  pending: "neutral",
  processing: "brand",
  done: "ok",
  warning: "warn",
  error: "danger",
  stopped: "neutral",
};
