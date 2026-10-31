"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { fmtMoney } from "@/lib/utils";
import type { MyKeyBalance, ProviderBalance } from "@/lib/balances";

/** Короткие подписи для плашки в шапке; полные имена — в выпадающем окне. */
const SHORT: Record<string, string> = { openrouter: "OR", laozhang: "LZ", openai: "OAI", dataforseo: "DFS" };

function tone(v: number | null) {
  if (v == null) return "text-muted";
  if (v < 5) return "text-danger";
  if (v < 20) return "text-warn";
  return "text-ok";
}

/** Сумма остатков без повторов: ключи одного счёта (laozhang) считаются один раз. */
function sumAccounts(keys: MyKeyBalance[]): number | null {
  const seen = new Map<string, number>();
  for (const k of keys) if (k.remaining != null) seen.set(k.account, k.remaining);
  return seen.size ? [...seen.values()].reduce((a, b) => a + b, 0) : null;
}

/**
 * Балансы в шапке: плашка с остатками, по клику — подробности.
 * Админам и сотрудникам с правом «все провайдеры» — все провайдеры; остальным (`mine`) — ключи их команды в открытых им инструментах.
 * `teamName` — активная команда из шапки: подпись в окне; при смене команды компонент пересоздаётся (key в Shell) и грузит заново.
 */
export function HeaderBalances({ mine = false, teamName = null }: { mine?: boolean; teamName?: string | null }) {
  const [rows, setRows] = useState<ProviderBalance[] | null>(null);
  const [keys, setKeys] = useState<MyKeyBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<Date | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/balances${mine ? "/mine" : ""}${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      if (mine) setKeys((await res.json()) as MyKeyBalance[]);
      else setRows((await res.json()) as ProviderBalance[]);
      setAt(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [mine]);

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
  const loaded = mine ? keys != null : rows != null;
  const chip: { id: string; label: string; remaining: number | null }[] = mine
    ? [...new Set((keys ?? []).map((k) => k.providerSlug))]
        .map((slug) => { const list = keys!.filter((k) => k.providerSlug === slug); return { id: slug, label: SHORT[slug] ?? list[0].provider, remaining: sumAccounts(list) }; })
        .filter((c) => c.remaining != null)
    : (rows ?? []).filter((p) => p.remaining != null).map((p) => ({ id: p.slug, label: SHORT[p.slug] ?? p.name, remaining: p.remaining }));
  const title = mine ? (teamName ? `Балансы ключей команды «${teamName}»` : "Балансы ваших ключей") : "Балансы провайдеров";
  const total = mine && keys ? sumAccounts(keys) : null;

  return (
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full min-w-0 items-center gap-2 h-9 overflow-hidden rounded-full border border-line bg-surface px-3 hover:border-line-2 transition text-[13px]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
      >
        <Icon.wallet width={15} height={15} className={`text-muted shrink-0 ${busy ? "animate-pulse" : ""}`} />
        {loaded ? (
          <span className="hidden sm:flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap tabular-nums">
            {chip.length === 0 && <span className="text-muted">нет данных</span>}
            {chip.map((c) => (
              <span key={c.id} className="inline-flex shrink-0 items-baseline gap-1">
                <span className="text-muted font-medium">{c.label}</span>
                <span className={`font-semibold ${tone(c.remaining)}`}>{fmtMoney(c.remaining)}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="hidden sm:block text-muted">{error ? "ошибка" : "…"}</span>
        )}
      </button>

      {open && (
        <div className="menu popover !p-0 sm:!w-[340px]" role="dialog" aria-label={title}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <div>
              <div className="text-[14px] font-semibold">{mine ? (teamName ? `Ключи команды «${teamName}»` : "Балансы ваших ключей") : "Балансы"}</div>
              <div className="help">{at ? `Обновлено ${at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "Загружаем…"}</div>
            </div>
            <button type="button" onClick={() => void load(true)} disabled={busy} className="btn-ghost btn-sm" title="Запросить у провайдеров заново">
              <Icon.refresh width={14} height={14} className={busy ? "animate-spin" : ""} /> Обновить
            </button>
          </div>
          {error && <div className="px-4 py-3 text-[13px] text-danger">{error}</div>}
          {mine && keys && (
            <>
              {keys.length === 0 && <div className="px-4 py-3 help">{teamName ? `У команды «${teamName}» пока нет ключей в открытых вам инструментах.` : "У вашей команды пока нет ключей в открытых вам инструментах."}</div>}
              {keys.length > 1 && total != null && (
                <div className="flex items-baseline justify-between gap-3 px-4 py-3 border-b border-line">
                  <div className="text-[14px] font-semibold">Всего на ключах</div>
                  <div className={`text-[18px] font-bold tabular-nums tracking-tight ${tone(total)}`}>{fmtMoney(total)}</div>
                </div>
              )}
              {keys.map((k) => (
                <div key={k.keyId} className="px-4 py-3 border-b border-line last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0"><span className="text-[14px] font-semibold">{k.label}</span> <span className="help">· {k.provider} · {k.owner}</span></div>
                    <div className={`text-[18px] font-bold tabular-nums tracking-tight ${tone(k.remaining)}`}>{k.remaining != null ? fmtMoney(k.remaining) : "—"}</div>
                  </div>
                  <div className="mt-1 text-[12.5px] text-muted">{k.tools.join(", ")}</div>
                  {k.note && <div className="help mt-1">{k.note}</div>}
                </div>
              ))}
              {keys.length > 0 && <div className="px-4 py-2.5 help border-t border-line">Остаток общий для ключа: в нём учтён расход всех инструментов и команд, где ключ работает. Если денег мало, предупредите администратора.</div>}
            </>
          )}
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
                  <span className="truncate">{k.label} <span className="opacity-70">· {k.owner}</span></span>
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
