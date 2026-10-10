"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { fmtMoney } from "@/lib/utils";
import type { ProviderBalance } from "@/lib/balances";

/** Короткие подписи для плашки в шапке; полные имена — в выпадающем окне. */
const SHORT: Record<string, string> = { openrouter: "OR", laozhang: "LZ", openai: "OAI", dataforseo: "DFS" };

function tone(v: number | null) {
  if (v == null) return "text-muted";
  if (v < 5) return "text-danger";
  if (v < 20) return "text-warn";
  return "text-ok";
}

/** Балансы провайдеров в шапке (только админам): плашка с остатками, по клику — подробности. */
export function HeaderBalances() {
  const [rows, setRows] = useState<ProviderBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/balances${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRows((await res.json()) as ProviderBalance[]);
      setAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // В плашке только те, у кого есть цифра; остальные видны в окне с пояснением.
  const chip = rows?.filter((p) => p.remaining != null) ?? [];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 rounded-full border border-line bg-surface px-3 hover:border-line-2 transition text-[13px]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Балансы провайдеров"
      >
        <Icon.wallet width={15} height={15} className={`text-muted shrink-0 ${busy ? "animate-pulse" : ""}`} />
        {rows ? (
          <span className="hidden sm:flex items-center gap-2.5 tabular-nums">
            {chip.length === 0 && <span className="text-muted">нет данных</span>}
            {chip.map((p) => (
              <span key={p.slug} className="inline-flex items-baseline gap-1">
                <span className="text-muted font-medium">{SHORT[p.slug] ?? p.name}</span>
                <span className={`font-semibold ${tone(p.remaining)}`}>{fmtMoney(p.remaining)}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="hidden sm:block text-muted">{error ? "ошибка" : "…"}</span>
        )}
      </button>

      {open && (
        <div className="menu overflow-hidden" style={{ width: 340, padding: 0 }} role="dialog" aria-label="Балансы провайдеров">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <div>
              <div className="text-[14px] font-semibold">Балансы</div>
              <div className="help">{at ? `Обновлено ${at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "Загружаем…"}</div>
            </div>
            <button type="button" onClick={() => void load(true)} disabled={busy} className="btn-ghost btn-sm" title="Запросить у провайдеров заново">
              <Icon.refresh width={14} height={14} className={busy ? "animate-spin" : ""} /> Обновить
            </button>
          </div>
          {error && <div className="px-4 py-3 text-[13px] text-danger">{error}</div>}
          {rows?.map((p) => (
            <div key={p.slug} className="px-4 py-3 border-b border-line last:border-b-0">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[14px] font-semibold">{p.name}</div>
                <div className={`text-[18px] font-bold tabular-nums tracking-tight ${tone(p.remaining)}`}>{p.remaining != null ? fmtMoney(p.remaining) : "—"}</div>
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-3 text-[12.5px] text-muted">
                <span>Расход за месяц через портал</span>
                <span className="tabular-nums">{fmtMoney(p.monthSpendUsd)}</span>
              </div>
              {p.total != null && (
                <div className="flex items-baseline justify-between gap-3 text-[12.5px] text-muted">
                  <span>Пополнено · потрачено</span>
                  <span className="tabular-nums">{fmtMoney(p.total)} · {fmtMoney(p.used ?? 0)}</span>
                </div>
              )}
              {p.keys.map((k) => (
                <div key={k.keyId} className="flex items-baseline justify-between gap-3 text-[12.5px] text-muted" title={k.note ?? undefined}>
                  <span className="truncate">{k.label}</span>
                  <span className={`tabular-nums ${tone(k.remaining)}`}>{k.remaining != null ? fmtMoney(k.remaining) : "—"}</span>
                </div>
              ))}
              {p.note && <div className="help mt-1.5">{p.note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
