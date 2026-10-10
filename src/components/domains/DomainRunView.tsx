"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import { STATUS_TONE } from "./DomainsNav";
import { computeStats, formatCounts } from "@/lib/domains/selection";
import { PATTERN_LABELS, RUN_STATUS_LABELS, type CandidatePattern, type DomainRunProgress, type DomainRunSettings } from "@/lib/domains/types";
import type { RunDomainRow } from "@/lib/domains/runs";

export type RunPayload = {
  run: {
    id: string;
    name: string;
    status: string;
    progress: DomainRunProgress | null;
    totalChecked: number;
    totalAvailable: number;
    incompleteBrands: string[];
    error: string | null;
    startedAt: string | Date | null;
    finishedAt: string | Date | null;
    settings: DomainRunSettings;
  };
  domains: RunDomainRow[];
};

type AiResult = { brand: string; picked: number; note: string | null; error: string | null; costUsd: number | null };

const LIVE = new Set(["QUEUED", "RUNNING"]);
const STATUS_BADGE: Record<string, { label: string; tone: "ok" | "danger" | "neutral" }> = {
  available: { label: "свободен", tone: "ok" },
  taken: { label: "занят", tone: "danger" },
  unknown: { label: "не проверен", tone: "neutral" },
};

/** Живая карточка подбора: прогресс, домены по брендам, ручной и ИИ-выбор, статистика, выгрузка. */
export function DomainRunView({ initial }: { initial: RunPayload }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<"available" | "taken" | "all">("available");
  const [copied, setCopied] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial.run.settings.brands.length <= 30 ? initial.run.settings.brands : []));
  const [groupBrands, setGroupBrands] = useState<Set<string>>(new Set());
  const [balanceZones, setBalanceZones] = useState(false);
  const [balanceSuffixes, setBalanceSuffixes] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiLog, setAiLog] = useState<AiResult[] | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scope, setScope] = useState<"selected" | "available" | "all">("selected");
  const pending = useRef(new Map<string, boolean>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { run, domains } = data;
  const live = LIVE.has(run.status);

  async function reload() {
    try {
      const res = await fetch(`/api/domains/runs/${run.id}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* показываем прошлое */
    }
  }
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, run.id]);

  const byBrand = useMemo(() => {
    const map = new Map<string, RunDomainRow[]>();
    for (const b of run.settings.brands) map.set(b, []);
    for (const d of domains) {
      if (!map.has(d.brand)) map.set(d.brand, []);
      map.get(d.brand)!.push(d);
    }
    return map;
  }, [domains, run.settings.brands]);
  const overall = useMemo(() => computeStats(domains), [domains]);
  const q = query.trim().toLowerCase();

  function toggle(id: string, selected: boolean) {
    setData((prev) => ({ ...prev, domains: prev.domains.map((d) => (d.id === id ? { ...d, selected } : d)) }));
    pending.current.set(id, selected);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flush, 500);
  }
  async function flush() {
    const changes = Array.from(pending.current.entries()).map(([id, selected]) => ({ id, selected }));
    pending.current.clear();
    if (!changes.length) return;
    try {
      const res = await fetch(`/api/domains/runs/${run.id}/select`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setSaveError(null);
    } catch (e) {
      setSaveError(`Выбор не сохранился: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  function toggleBrandAll(brand: string, selected: boolean) {
    for (const d of byBrand.get(brand) ?? []) if (d.status === "available" && d.selected !== selected) toggle(d.id, selected);
  }

  async function runAi(brands: string[] | null, label: string) {
    setAiBusy(label);
    setAiError(null);
    setAiLog(null);
    try {
      const res = await fetch(`/api/domains/runs/${run.id}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brands: brands ?? [], balanceZones, balanceSuffixes }) });
      const body = (await res.json()) as { results?: AiResult[]; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAiLog(body.results ?? []);
      await reload();
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(null);
    }
  }

  /** Домены по текущему выбору области (как у выгрузки): только выбранные / все свободные / все проверенные. */
  const scopedRows = (s: typeof scope) => domains.filter((d) => (s === "selected" ? d.selected : s === "available" ? d.status === "available" : true));
  async function copyList(format: "domains" | "sheet") {
    const rows = scopedRows(scope);
    if (!rows.length) { setCopied("Нечего копировать: отметьте домены или смените область"); return; }
    const text = format === "domains" ? rows.map((d) => d.domain).join("\n") : rows.map((d) => `${d.brand}\t${d.domain}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(`Скопировано: ${rows.length} ${format === "sheet" ? "строк (бренд и домен в двух колонках)" : "доменов"}`);
    setTimeout(() => setCopied(null), 4000);
  }

  const pct = run.progress && run.progress.brandsTotal ? Math.round((run.progress.brandIndex / run.progress.brandsTotal) * 100) : run.status === "DONE" ? 100 : 0;
  const aiCost = aiLog?.reduce((a, r) => a + (r.costUsd ?? 0), 0) ?? 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Проверено доменов", value: run.totalChecked },
          { label: "Свободно", value: run.totalAvailable },
          { label: "Выбрано", value: overall.counts.selected },
          { label: "Брендов", value: run.settings.brands.length },
        ].map((s) => (
          <div key={s.label} className="kpi"><div className="kpi-value">{s.value}</div><div className="help">{s.label}</div></div>
        ))}
      </div>

      {live && (
        <Card>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2"><Badge tone={STATUS_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge><span className="help">{run.status === "QUEUED" ? "Ждёт воркер: обычно несколько секунд" : run.progress ? `${run.progress.brandIndex} из ${run.progress.brandsTotal} брендов · сейчас «${run.progress.brand}»` : "Запускается…"}</span></div>
            <span className="help">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-ink/10 overflow-hidden"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
          <p className="help mt-2">Страница обновляется сама. Можно уйти — проверка продолжится в фоне.</p>
        </Card>
      )}
      {run.status === "FAILED" && run.error && <Alert tone="danger">Подбор прерван ошибкой: {run.error}</Alert>}
      {run.status === "STOPPED" && <Alert tone="warn">Подбор остановлен. Проверенные домены сохранены; «Запустить заново» начнёт с чистого листа.</Alert>}
      {run.incompleteBrands.length > 0 && !live && (
        <Alert tone="warn">Не хватило свободных доменов ({run.settings.perBrand} на бренд) для: {run.incompleteBrands.join(", ")}. Добавьте приставки или зоны и повторите подбор.</Alert>
      )}
      {saveError && <Alert tone="danger">{saveError}</Alert>}

      {!live && domains.length > 0 && (
        <Card title="ИИ-отбор" description="Модель оценивает свободные домены бренда и выбирает лучшие под TOP-1 по бренд-запросу. Выбор ИИ заменяет текущий выбор бренда; оценку и объяснение видно в таблице.">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4" checked={balanceZones} onChange={(e) => setBalanceZones(e.target.checked)} /> Балансировать зоны</label>
            <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" className="h-4 w-4" checked={balanceSuffixes} onChange={(e) => setBalanceSuffixes(e.target.checked)} /> Балансировать приставки</label>
            <div className="ml-auto flex flex-wrap gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={!!aiBusy || groupBrands.size === 0} onClick={() => runAi(Array.from(groupBrands), "group")}>
                {aiBusy === "group" ? "ИИ думает…" : `ИИ для отмеченных (${groupBrands.size})`}
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={!!aiBusy} onClick={() => runAi(null, "all")}>
                {aiBusy === "all" ? "ИИ думает…" : "ИИ для всех брендов"}
              </button>
            </div>
          </div>
          {aiError && <div className="mt-3"><Alert tone="danger">{aiError}</Alert></div>}
          {aiLog && (
            <div className="mt-3 rounded-xl border border-line p-3 text-[13.5px] space-y-1">
              {aiLog.map((r) => (
                <div key={r.brand} className={r.error ? "text-danger" : ""}>
                  <b>{r.brand}</b>: {r.error ? r.error : `выбрано ${r.picked}${r.note ? ` · ${r.note}` : ""}`}
                </div>
              ))}
              {aiCost > 0 && <div className="help">Стоимость: ${aiCost.toFixed(4)}</div>}
            </div>
          )}
        </Card>
      )}

      {domains.length > 0 && (
        <Card
          title="Выгрузка и статистика"
          description="Область действует и на файлы, и на копирование. «Для таблицы» копирует две колонки: бренд и домен — вставляется в Google Таблицу как есть."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <select className="input !w-auto !py-1.5 text-[13px]" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="selected">только выбранные</option>
                <option value="available">все свободные</option>
                <option value="all">все проверенные</option>
              </select>
              <button type="button" className="btn-primary btn-sm" onClick={() => copyList("domains")}>Скопировать домены</button>
              <button type="button" className="btn-primary btn-sm" onClick={() => copyList("sheet")}>Скопировать для таблицы</button>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=xlsx&scope=${scope}`}>XLSX</a>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=csv&scope=${scope}`}>CSV</a>
            </div>
          }
        >
          {copied && <div className="mb-3"><Alert tone={copied.startsWith("Нечего") ? "warn" : "ok"}>{copied}</Alert></div>}
          <StatsTable stats={overall} />
        </Card>
      )}

      {domains.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <input className="input !w-auto min-w-[220px]" placeholder="Поиск по домену или бренду" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="flex gap-1.5">
            {([["available", `Свободные · ${overall.counts.available}`], ["taken", `Занятые · ${overall.counts.taken}`], ["all", `Все · ${overall.counts.total}`]] as const).map(([v, label]) => (
              <button key={v} type="button" className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set(run.settings.brands))}>Развернуть все</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>Свернуть все</button>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {run.settings.brands.map((brand) => {
          const rows = byBrand.get(brand) ?? [];
          if (q && !brand.toLowerCase().includes(q) && !rows.some((d) => d.domain.includes(q))) return null;
          const stats = computeStats(rows);
          const visible = rows.filter((d) => (view === "all" || (view === "available" ? d.status === "available" : d.status === "taken")) && (!q || d.domain.includes(q) || brand.toLowerCase().includes(q)));
          const open = expanded.has(brand);
          const incomplete = run.incompleteBrands.includes(brand);
          const inProgress = live && run.progress?.brand === brand;
          const toggleOpen = () => setExpanded((prev) => { const n = new Set(prev); if (n.has(brand)) n.delete(brand); else n.add(brand); return n; });
          return (
            <section key={brand} className="card flex flex-col min-w-0">
              <div className="flex items-center gap-2 px-3 py-2.5">
                {!live && <input type="checkbox" className="h-4 w-4 shrink-0" checked={groupBrands.has(brand)} onChange={(e) => setGroupBrands((prev) => { const n = new Set(prev); if (e.target.checked) n.add(brand); else n.delete(brand); return n; })} title="В группу для ИИ-отбора" />}
                <button type="button" className="min-w-0 flex-1 text-left font-semibold text-[15px] truncate hover:underline" onClick={toggleOpen} title={brand}>
                  {brand}
                </button>
                {inProgress && <Badge tone="brand">идёт</Badge>}
                {incomplete && <Badge tone="warn">мало</Badge>}
                <span className="shrink-0 text-[12.5px] tabular-nums whitespace-nowrap" title="выбрано / свободно / занято">
                  <b className={stats.counts.selected ? "text-brand" : ""}>{stats.counts.selected}</b>
                  <span className="text-muted"> / </span><b className="text-ok">{stats.counts.available}</b>
                  <span className="text-muted"> / {stats.counts.taken}</span>
                </span>
                <button type="button" className="shrink-0 text-muted hover:text-ink px-1" onClick={toggleOpen} aria-label={open ? "Свернуть" : "Развернуть"}>{open ? "▾" : "▸"}</button>
              </div>
              {open && (
                <div className="border-t border-line flex flex-col min-h-0">
                  {rows.length === 0 ? (
                    <p className="help px-3 py-3">Ещё не проверялся</p>
                  ) : (
                    <>
                      <ul className="max-h-72 overflow-auto divide-y divide-line/70">
                        {visible.map((d) => (
                          <li key={d.id} className={`flex items-center gap-2 px-3 py-1.5 text-[13.5px] ${d.selected ? "bg-brand-soft/40" : ""}`} title={[PATTERN_LABELS[d.pattern as CandidatePattern] ?? d.pattern, d.aiReason].filter(Boolean).join(" · ")}>
                            {d.status === "available" ? (
                              <input type="checkbox" className="h-4 w-4 shrink-0" checked={d.selected} onChange={(e) => toggle(d.id, e.target.checked)} />
                            ) : (
                              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${d.status === "taken" ? "bg-danger" : "bg-line-2"}`} title={STATUS_BADGE[d.status]?.label} />
                            )}
                            <span className="font-mono min-w-0 flex-1 truncate">{d.domain}</span>
                            {d.tier > 0 && <span className="shrink-0 rounded-md bg-ink/5 px-1.5 text-[11px] text-muted" title={`приставка ${d.suffix}, уровень ${d.tier}`}>{d.tier}</span>}
                            {d.aiScore != null && <span className="shrink-0 rounded-md bg-ok-soft px-1.5 text-[11px] font-semibold text-ok" title={d.aiReason ?? "оценка ИИ"}>{d.aiScore}</span>}
                          </li>
                        ))}
                        {visible.length === 0 && <li className="help px-3 py-2">Нет доменов под фильтр</li>}
                      </ul>
                      <div className="help px-3 py-1.5 border-t border-line truncate" title={`Зоны: выбрано ${formatCounts(stats.zones.selected)} · свободно ${formatCounts(stats.zones.available)}\nПриставки: выбрано ${formatCounts(stats.suffixes.selected)} · свободно ${formatCounts(stats.suffixes.available)}`}>
                        {stats.counts.selected ? <>зоны {formatCounts(stats.zones.selected)} · приставки {formatCounts(stats.suffixes.selected)}</> : <>свободно: {formatCounts(stats.zones.available)}</>}
                      </div>
                      {!live && (
                        <div className="flex gap-1.5 px-3 py-2 border-t border-line">
                          <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => toggleBrandAll(brand, true)} title="Выбрать все свободные">Все</button>
                          <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => toggleBrandAll(brand, false)}>Снять</button>
                          <button type="button" className="btn-primary btn-sm !px-2.5 !py-1 text-[12.5px] ml-auto" disabled={!!aiBusy || stats.counts.available === 0} onClick={() => runAi([brand], brand)}>{aiBusy === brand ? "ИИ…" : "ИИ-отбор"}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function StatsTable({ stats }: { stats: ReturnType<typeof computeStats> }) {
  const Row = ({ label, pairs }: { label: string; pairs: [string, number][] }) => (
    <tr><td className="font-medium whitespace-nowrap">{label}</td><td className="font-mono text-[13px]">{formatCounts(pairs)}</td></tr>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th colSpan={2}>Зоны</th></tr></thead>
          <tbody><Row label="Выбрано" pairs={stats.zones.selected} /><Row label="Свободно" pairs={stats.zones.available} /><Row label="Не задействовано" pairs={stats.zones.unused} /></tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th colSpan={2}>Приставки</th></tr></thead>
          <tbody><Row label="Выбрано" pairs={stats.suffixes.selected} /><Row label="Свободно" pairs={stats.suffixes.available} /><Row label="Не задействовано" pairs={stats.suffixes.unused} /></tbody>
        </table>
      </div>
    </div>
  );
}
