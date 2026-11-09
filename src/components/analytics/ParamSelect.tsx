"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/** Выпадающий список, который меняет один параметр адреса (фильтр по сайту, сортировка). */
export function ParamSelect({ param, options, allLabel, className = "", resetPage = true }: { param: string; options: Array<{ value: string; label: string }>; allLabel?: string; className?: string; resetPage?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const cur = sp.get(param) ?? "";
  const set = (v: string) => {
    const q = new URLSearchParams(sp.toString());
    v ? q.set(param, v) : q.delete(param);
    if (resetPage) q.delete("pg");
    start(() => router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  };
  return (
    <select className={`input !w-auto !py-2 sm:!text-[13.5px] ${pending ? "opacity-70" : ""} ${className}`} value={cur} onChange={(e) => set(e.target.value)}>
      {allLabel != null && <option value="">{allLabel}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
