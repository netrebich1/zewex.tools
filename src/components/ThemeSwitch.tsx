"use client";
import { useEffect, useRef, useState } from "react";
import { THEMES, THEME_COOKIE, THEME_LABELS, isTheme, type Theme } from "@/lib/theme";
import { Icon } from "./Icons";

const ICONS: Record<Theme, keyof typeof Icon> = { dark: "moon", light: "sun", neutral: "contrast" };

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const v = document.documentElement.getAttribute("data-theme");
  return isTheme(v) ? v : "light";
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  document.cookie = `${THEME_COOKIE}=${t}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Переключатель темы: кнопка с иконкой текущей темы, по клику — три варианта. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setTheme(readTheme()), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const Current = Icon[ICONS[theme]];
  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 hover:text-ink hover:border-line-2 transition"
        aria-label={`Тема: ${THEME_LABELS[theme]}`}
        title={`Тема: ${THEME_LABELS[theme]}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Current width={16} height={16} />
      </button>
      {open && (
        <div className="menu" style={{ width: 192 }} role="menu">
          <div className="px-3 py-1.5 text-[11.5px] uppercase tracking-wider text-muted font-semibold">Тема</div>
          {THEMES.map((t) => {
            const I = Icon[ICONS[t]];
            const active = t === theme;
            return (
              <button
                key={t}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { applyTheme(t); setTheme(t); setOpen(false); }}
                className={`menu-item ${active ? "bg-ink/5 text-ink" : ""}`}
              >
                <I width={16} height={16} /> {THEME_LABELS[t]}
                {active && <Icon.check width={14} height={14} className="ml-auto text-brand" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
