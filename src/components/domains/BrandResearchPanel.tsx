"use client";
import { useRef, useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import type { BrandResearch, ResearchModifier, ResearchSource } from "@/lib/domains/research";
import { itemKey, LIMITS, type BrandModifier, type BrandResearchSummary } from "@/lib/domains/types";
import { researchSummary, toBrandModifier } from "@/lib/domains/researchSummary";

export type Pick = { keep: boolean; tier: 1 | 2 | 3 };
export type ResearchEntry = { status: "loading" | "done" | "error"; result?: BrandResearch; picks: Record<string, Pick>; error?: string };

const SOURCE_LABELS: Record<ResearchSource, string> = { keywords: "частота", autocomplete: "подсказки", related: "похожие", competitors: "конкуренты" };

/** Одобренные модификаторы бренда — уходят в настройки подбора. */
export function entryModifiers(e: ResearchEntry | undefined): BrandModifier[] {
  if (!e?.result) return [];
  return e.result.modifiers
    .filter((m) => e.picks[m.suffix]?.keep)
    .map((m) => toBrandModifier(m, e.picks[m.suffix]!.tier))
    .slice(0, LIMITS.modifiersPerBrand);
}

/** Итог сбора ключей в форме — уходит в подбор, чтобы в карточке было видно, что нашли и что отбросили. */
export function entryResearch(e: ResearchEntry | undefined): BrandResearchSummary | undefined {
  if (e?.status !== "done" || !e.result || !e.result.queries) return undefined;
  return researchSummary(e.result, new Set(entryModifiers(e).map((m) => m.suffix)), "form");
}

/** Запись исследования из модификаторов прошлого подбора («Повторить»). */
export function entryFromSaved(brand: string, country: string, mods: BrandModifier[]): ResearchEntry {
  const modifiers: ResearchModifier[] = mods.map((m) => ({ suffix: m.suffix, word: m.suffix, volume: m.volume, count: 0, query: m.query ?? "", sources: m.sources ?? [], keep: true, tier: m.tier, reason: m.reason ?? "из прошлого подбора" }));
  return { status: "done", result: { brand, country, modifiers, queries: 0, competitorDomains: [], tlds: [], errors: [], costUsd: 0 }, picks: Object.fromEntries(modifiers.map((m) => [m.suffix, { keep: true, tier: m.tier }])) };
}

/**
 * Ключевые слова брендов: запросы с брендом (DataForSEO), подсказки Google, похожие запросы и домены конкурентов.
 * Дешёвая модель отмечает, какие слова годятся аффилиату; галочки и уровни можно поправить вручную.
 * Модификаторы привязываются к своему бренду; в уровни 4–6 других брендов страны они идут только как запас.
 */
export function BrandResearchPanel({
  items,
  entries,
  setEntries,
  onAddTld,
}: {
  items: Array<{ brand: string; country: string }>;
  entries: Record<string, ResearchEntry>;
  setEntries: (fn: (prev: Record<string, ResearchEntry>) => Record<string, ResearchEntry>) => void;
  onAddTld: (tld: string, country: string) => void;
}) {
  const [useAi, setUseAi] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const stop = useRef(false);
  const multi = new Set(items.map((it) => it.country)).size > 1;
  const label = (it: { brand: string; country: string }) => (multi ? `${it.brand} · ${it.country.toUpperCase()}` : it.brand);

  async function run(onlyMissing: boolean) {
    const todo = items.filter((it) => !onlyMissing || entries[itemKey(it.brand, it.country)]?.status !== "done");
    if (!todo.length) return;
    setRunning(true);
    setError(null);
    stop.current = false;
    setProgress({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i += LIMITS.researchChunk) {
      if (stop.current) break;
      const chunk = todo.slice(i, i + LIMITS.researchChunk);
      setEntries((prev) => ({ ...prev, ...Object.fromEntries(chunk.map((it) => [itemKey(it.brand, it.country), { status: "loading" as const, picks: {} }])) }));
      try {
        const res = await fetch("/api/domains/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: chunk, useAi }) });
        const body = (await res.json()) as { results?: BrandResearch[]; error?: string };
        if (!res.ok || !body.results) throw new Error(body.error ?? `HTTP ${res.status}`);
        setEntries((prev) => {
          const next = { ...prev };
          for (const r of body.results!) {
            next[itemKey(r.brand, r.country)] = { status: "done", result: r, picks: Object.fromEntries(r.modifiers.map((m) => [m.suffix, { keep: m.keep, tier: m.tier }])) };
          }
          return next;
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setEntries((prev) => ({ ...prev, ...Object.fromEntries(chunk.map((it) => [itemKey(it.brand, it.country), { status: "error" as const, picks: {}, error: msg }])) }));
        setError(msg);
        if (/не подключ|429|лимит/i.test(msg)) break;
      }
      setProgress({ done: Math.min(todo.length, i + chunk.length), total: todo.length });
    }
    setRunning(false);
  }

  const results = items.map((it) => entries[itemKey(it.brand, it.country)]).filter((e): e is ResearchEntry => !!e?.result);
  const cost = results.reduce((a, e) => a + (e.result?.costUsd ?? 0), 0);
  // Зоны конкурентов по странам: подсказка, что добавить в набор страны
  const zoneMap = new Map<string, Map<string, number>>();
  for (const e of results) {
    const m = zoneMap.get(e.result!.country) ?? new Map<string, number>();
    for (const t of e.result!.tlds) m.set(t.value, (m.get(t.value) ?? 0) + t.count);
    zoneMap.set(e.result!.country, m);
  }
  const doneCount = items.filter((it) => entries[itemKey(it.brand, it.country)]?.status === "done").length;

  const setPick = (key: string, suffix: string, patch: Partial<Pick>) =>
    setEntries((prev) => {
      const e = prev[key];
      if (!e) return prev;
      return { ...prev, [key]: { ...e, picks: { ...e.picks, [suffix]: { ...(e.picks[suffix] ?? { keep: false, tier: 3 }), ...patch } } } };
    });

  return (
    <Card
      title="4. Ключевые слова брендов"
      description="Для каждого бренда в его стране: запросы с брендом и частота (DataForSEO), подсказки Google, похожие запросы и домены конкурентов. Дешёвая модель (OpenRouter) оставляет только сильные аффилиатные слова — «вывод средств», «поддержка», «жалобы» отбрасываются."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" className="h-4 w-4" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Фильтр ИИ</label>
          {running ? (
            <button type="button" className="btn-ghost btn-sm" onClick={() => { stop.current = true; }}>Остановить</button>
          ) : (
            <>
              {doneCount > 0 && <button type="button" className="btn-ghost btn-sm" onClick={() => run(false)} disabled={!items.length}>Собрать заново</button>}
              <button type="button" className="btn-primary btn-sm" onClick={() => run(true)} disabled={!items.length || doneCount === items.length}>
                {doneCount ? `Собрать для остальных (${items.length - doneCount})` : `Собрать ключи (${items.length})`}
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {progress && (
          <div>
            <div className="help mb-1">{running ? "Собираю" : "Готово"}: {progress.done} из {progress.total}{cost > 0 ? ` · потрачено $${cost.toFixed(3)}` : ""}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-ink/10"><div className="h-full bg-brand transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {!results.length && !running && <p className="help">Здесь — чтобы посмотреть и поправить ключи заранее. Если включено «Собрать ключи и выдачу Google перед проверкой», подбор сам соберёт их для брендов без ключей. Примерно $0.02–0.04 на бренд (DataForSEO + ИИ).</p>}

        {zoneMap.size > 0 && (
          <div className="rounded-xl border border-line p-3">
            <div className="label">Зоны конкурентов в выдаче — нажмите, чтобы добавить в набор страны</div>
            <div className="flex flex-col gap-1.5">
              {Array.from(zoneMap.entries()).map(([country, m]) => (
                <div key={country} className="flex flex-wrap items-center gap-1.5">
                  <span className="help w-8 uppercase">{country}</span>
                  {Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tld, n]) => (
                    <button key={tld} type="button" className="tab" onClick={() => onAddTld(tld, country)} title={`добавить .${tld} в зоны ${country.toUpperCase()}`}>+ .{tld} · {n}</button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {items.some((it) => entries[itemKey(it.brand, it.country)]) && (
          <div className="divide-y divide-line rounded-xl border border-line">
            {items.map((it) => {
              const key = itemKey(it.brand, it.country);
              const e = entries[key];
              if (!e) return null;
              const mods = e.result?.modifiers ?? [];
              const kept = mods.filter((m) => e.picks[m.suffix]?.keep).length;
              const isOpen = open === key;
              return (
                <div key={key}>
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink/5" onClick={() => setOpen(isOpen ? null : key)}>
                    <b className="min-w-0 flex-1 truncate text-[14px]">{label(it)}</b>
                    {e.status === "loading" && <Badge tone="brand">собираю…</Badge>}
                    {e.status === "error" && <Badge tone="danger">ошибка</Badge>}
                    {e.status === "done" && <span className="help whitespace-nowrap">оставлено <b className="text-ink">{kept}</b> из {mods.length}{e.result?.queries ? <span className="hidden sm:inline"> · запросов {e.result.queries}</span> : ""}</span>}
                    {!!e.result?.errors.length && <Badge tone="warn">{e.result.errors.length} предупр.</Badge>}
                    <span className="text-muted">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-line px-3 py-2">
                      {e.error && <Alert tone="danger">{e.error}</Alert>}
                      {e.result?.errors.map((x) => <div key={x} className="help text-warn">{x}</div>)}
                      {mods.length === 0 ? (
                        <p className="help py-2">Слов не найдено: по бренду мало запросов. Сработают общие приставки и набор страны.</p>
                      ) : (
                        <div className="table-wrap mt-2 max-h-80 overflow-auto">
                          <table className="table">
                            <thead><tr><th></th><th>В домен</th><th>Уровень</th><th>Частота</th><th>Откуда</th><th>Пример / причина</th></tr></thead>
                            <tbody>
                              {mods.map((m) => {
                                const p = e.picks[m.suffix] ?? { keep: false, tier: m.tier };
                                return (
                                  <tr key={m.suffix} className={p.keep ? "" : "opacity-55"}>
                                    <td><input type="checkbox" className="h-4 w-4" checked={p.keep} onChange={(ev) => setPick(key, m.suffix, { keep: ev.target.checked })} /></td>
                                    <td className="font-mono">{m.suffix}{m.word !== m.suffix && <span className="help"> ({m.word})</span>}</td>
                                    <td>
                                      <select className="input !w-auto !px-2 !py-0.5 !pr-7 text-[13px]" value={p.tier} onChange={(ev) => setPick(key, m.suffix, { tier: Number(ev.target.value) as 1 | 2 | 3 })}>
                                        <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
                                      </select>
                                    </td>
                                    <td className="tabular-nums">{m.volume || "—"}</td>
                                    <td className="help whitespace-nowrap">{m.sources.map((s) => SOURCE_LABELS[s]).join(", ") || "—"}</td>
                                    <td className="help"><span className="font-mono">{m.query}</span>{m.reason ? <> · {m.reason}</> : null}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {e.result && e.result.competitorDomains.length > 0 && (
                        <div className="help mt-2">Конкуренты в TOP-10: <span className="font-mono">{e.result.competitorDomains.join(", ")}</span></div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
