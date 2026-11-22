"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/stylist", label: "Каталог", exact: true },
  { href: "/stylist/looks", label: "Образы" },
  { href: "/stylist/clients", label: "Клиенты" },
  { href: "/stylist/brands", label: "ДНК брендов" },
  { href: "/stylist/add", label: "Добавить вещь" },
  { href: "/stylist/stores", label: "Магазины" },
  { href: "/stylist/extension", label: "Расширение" },
];

/** Подменю инструмента «Стилист» (пилюли под шапкой портала). */
export function StNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Стилист</span>
      {ITEMS.map((it) => (
        <Link key={it.href} href={it.href} className={`tab ${(it.exact ? pathname === it.href : pathname.startsWith(it.href)) ? "active" : ""}`}>
          {it.label}
        </Link>
      ))}
    </div>
  );
}
