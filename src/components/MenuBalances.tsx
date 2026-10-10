"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icons";
import { fmtMoney } from "@/lib/utils";
import type { ProviderBalance } from "@/lib/balances";

/** Блок в меню для администраторов: остатки на OpenRouter / laozhang / OpenAI по активным ключам. */
export function MenuBalances() {
  const [rows, setRows] = useState<ProviderBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/balances${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRows((await res.json()) as ProviderBalance[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="border-b border-line mb-1 pb-1">
      <div className="flex items-center justify-between px-3 pt-1.5 pb-1">
        <span className="text-[11.5px] uppercase tracking-wider text-muted font-semibold inline-flex items-center gap-1.5"><Icon.wallet width={13} height={13} /> Балансы</span>
        <button type="button" onClick={() => void load(true)} disabled={busy} className="text-muted hover:text-ink transition disabled:opacity-50" title="Обновить" aria-label="Обновить балансы">
          <Icon.refresh width={13} height={13} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      {error && <div className="px-3 pb-1.5 text-[12.5px] text-danger">{error}</div>}
      {!rows && !error && <div className="px-3 pb-1.5 help">Загружаем…</div>}
      {rows?.map((p) => (
        <div key={p.slug} className="px-3 py-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13.5px] font-medium text-ink truncate">{p.name}</span>
            <span className="help whitespace-nowrap" title="Расход за этот месяц по журналу портала">мес. {fmtMoney(p.monthSpendUsd)}</span>
          </div>
          {p.keys.length === 0 && <div className="help">Нет активных ключей</div>}
          {p.keys.map((k) => {
            const title = [
              k.total != null ? `Лимит/пополнено ${fmtMoney(k.total)}` : null,
              k.used != null ? `Потрачено ${fmtMoney(k.used)}` : null,
              `Проверено ${new Date(k.checkedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`,
            ].filter(Boolean).join(" · ");
            return (
              <div key={k.keyId} className="flex items-baseline justify-between gap-2 text-[13px]" title={title}>
                <span className="text-muted truncate">{p.keys.length > 1 ? k.label : k.hint}</span>
                {k.remaining != null
                  ? <span className={`font-semibold tabular-nums whitespace-nowrap ${k.remaining < 5 ? "text-danger" : k.remaining < 20 ? "text-warn" : "text-ok"}`}>{fmtMoney(k.remaining)}</span>
                  : <span className="text-muted whitespace-nowrap" title={k.note ?? undefined}>нет данных</span>}
              </div>
            );
          })}
          {p.keys.some((k) => k.remaining == null && k.note) && (
            <div className="help mt-0.5 line-clamp-2" title={p.keys.find((k) => k.note)?.note ?? undefined}>{p.keys.find((k) => k.note)?.note}</div>
          )}
        </div>
      ))}
    </div>
  );
}
