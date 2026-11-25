"use client";
import { useState, type ReactNode } from "react";

/** Длинный блок обрезан по высоте с затуханием внизу; кнопка показывает его целиком. */
export function ClipReveal({ children, label = "Показать целиком", maxClass = "max-h-[70vh]" }: { children: ReactNode; label?: string; maxClass?: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{children}</>;
  return (
    <div>
      <div className={`relative overflow-hidden ${maxClass}`}>
        {children}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-surface to-transparent" aria-hidden />
      </div>
      <button type="button" className="btn-ghost mt-2 w-full sm:w-auto" onClick={() => setOpen(true)}>{label}</button>
    </div>
  );
}
