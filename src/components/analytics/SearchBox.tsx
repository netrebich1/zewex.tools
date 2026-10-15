"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/** Поиск, который пишет `q` в адрес с задержкой — страница перерисовывается на сервере. */
export function SearchBox({ placeholder, param = "q", className = "" }: { placeholder: string; param?: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [v, setV] = useState(sp.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setV(sp.get(param) ?? ""), [sp, param]);
  const apply = (val: string) => {
    const q = new URLSearchParams(sp.toString());
    val.trim() ? q.set(param, val.trim()) : q.delete(param);
    q.delete("pg");
    start(() => router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false }));
  };
  return (
    <div className={`relative ${className}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        className={`input !pl-9 !py-2 !text-[13.5px] ${pending ? "opacity-70" : ""}`}
        placeholder={placeholder}
        value={v}
        onChange={(e) => { setV(e.target.value); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => apply(e.target.value), 350); }}
        onKeyDown={(e) => { if (e.key === "Enter") { if (timer.current) clearTimeout(timer.current); apply(v); } }}
      />
      {v && <button type="button" onClick={() => { setV(""); apply(""); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink" aria-label="Очистить">×</button>}
    </div>
  );
}
