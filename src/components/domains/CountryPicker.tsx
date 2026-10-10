"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { countryByCode, searchCountries, type Country } from "@/lib/domains/countries";

/**
 * Выбор страны поиском: печатаете «замб» или «zam» — список подсказывает подходящие страны, выбираете нужную.
 * Значение (код alpha-2) уходит в форму скрытым полем countryCode.
 */
export function CountryPicker({ value, onChange, name = "countryCode", label = "Страна продвижения" }: { value: string; onChange: (code: string) => void; name?: string; label?: string }) {
  const selected = countryByCode(value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const options = useMemo(() => searchCountries(query, 12), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => setCursor(0), [query]);

  const pick = (c: Country) => {
    onChange(c.code);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="block" ref={ref}>
      <span className="label">{label}</span>
      <input type="hidden" name={name} value={value} />
      <div className="relative">
        <input
          className="input"
          placeholder="Начните печатать: Замбия, Zambia или zm"
          value={open ? query : selected ? `${selected.name} (${selected.code.toUpperCase()})` : ""}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(options.length - 1, c + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); if (options[cursor]) pick(options[cursor]); }
            else if (e.key === "Escape") setOpen(false);
          }}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
        />
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-pop)]">
            {options.length === 0 && <div className="help px-3 py-2">Ничего не найдено: попробуйте по-английски или код страны</div>}
            {options.map((c, i) => (
              <button
                type="button"
                key={c.code}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                onMouseEnter={() => setCursor(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[14px] ${i === cursor ? "bg-ink/5" : ""} ${c.code === value ? "font-semibold" : ""}`}
              >
                <span>{c.name} <span className="text-muted">· {c.en}</span></span>
                <span className="mono text-muted uppercase">{c.code}</span>
              </button>
            ))}
            {!query && <div className="help px-3 py-1.5 border-t border-line mt-1">Показаны частые страны. Печатайте, чтобы найти любую из {"250+"}.</div>}
          </div>
        )}
      </div>
      <span className="help mt-1 block">Для выдачи Google и ИИ-отбора. Язык поиска подставляется по стране.</span>
    </div>
  );
}
