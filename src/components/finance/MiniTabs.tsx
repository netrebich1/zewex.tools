"use client";
import { useState, type ReactNode } from "react";

/** Маленькие вкладки внутри карточки: содержимое готовит сервер, здесь только переключение. */
export function MiniTabs({ tabs }: { tabs: { label: string; node: ReactNode }[] }) {
  const [i, setI] = useState(0);
  return (
    <div>
      <div className="inline-flex gap-0.5 rounded-lg bg-ink/5 p-0.5">
        {tabs.map((t, k) => (
          <button key={t.label} type="button" onClick={() => setI(k)} className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition ${k === i ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{t.label}</button>
        ))}
      </div>
      <div className="mt-2">{tabs[i]?.node}</div>
    </div>
  );
}
