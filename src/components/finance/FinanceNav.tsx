"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DISPLAY, DISPLAY_COOKIE, type DisplayCur } from "@/lib/finance/currency";

const ITEMS = [
  { href: "/finance", label: "Обзор", exact: true },
  { href: "/finance/ops", label: "Операции" },
  { href: "/finance/settings", label: "Настройки" },
];

/** Подменю «Финансы» + переключатель валюты итогов (запоминается в cookie). */
export function FinanceNav({ cur }: { cur: DisplayCur }) {
  const pathname = usePathname();
  const router = useRouter();
  const pick = (c: DisplayCur) => {
    document.cookie = `${DISPLAY_COOKIE}=${c}; path=/finance; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Финансы Wexora</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>{it.label}</Link>;
      })}
      <div className="ml-auto inline-flex items-center gap-0.5 rounded-full border border-line p-0.5" title="В какой валюте показывать итоги">
        {DISPLAY.map((c) => (
          <button key={c} type="button" onClick={() => pick(c)} className={`rounded-full px-2.5 py-1 text-[12.5px] font-semibold transition ${c === cur ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>{c}</button>
        ))}
      </div>
    </div>
  );
}
