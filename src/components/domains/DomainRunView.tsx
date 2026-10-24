"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import { STATUS_TONE } from "./DomainsNav";
import { computeStats, formatCounts, itemsByGeo, rowsByGeo } from "@/lib/domains/selection";
import { itemKey, RUN_STATUS_LABELS, type DomainRunProgress, type DomainRunSettings } from "@/lib/domains/types";
import type { RunDomainRow } from "@/lib/domains/runs";
import { brandTierEntries, brandTldEntries, modifierPool } from "@/lib/domains/generator";
import { RunAnalysis } from "./RunAnalysis";
import { BrandDomains, DEFAULT_FILTER, filterRows, kindOf, MODE_OPTIONS, SRC_OPTIONS, TIER_OPTIONS, type DomainFilter } from "./BrandDomains";
import { recommendDomains } from "@/lib/domains/recommend";

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

type AiResult = { brand: string; key?: string; picked: number; note: string | null; error: string | null; costUsd: number | null };

const LIVE = new Set(["QUEUED", "RUNNING"]);

/** Живая карточка подбора: прогресс, домены по брендам, ручной и ИИ-выбор, статистика, выгрузка. */
export function DomainRunView({ initial }: { initial: RunPayload }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<"available" | "selected" | "taken" | "all">("available");
  const [copied, setCopied] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const allKeys = (s: DomainRunSettings) => s.items.map((it) => itemKey(it.brand, it.country));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial.run.settings.items.length <= 30 ? allKeys(initial.run.settings) : []));
  const [groupBrands, setGroupBrands] = useState<Set<string>>(new Set());
  const [balanceZones, setBalanceZones] = useState(false);
  const [balanceSuffixes, setBalanceSuffixes] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiLog, setAiLog] = useState<AiResult[] | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scope, setScope] = useState<"selected" | "available" | "all">("selected");
  // Фильтр для всех брендов; у бренда можно переключить свой — он хранится отдельно, пока не сменят общий
  const [globalFilter, setGlobalFilter] = useState<DomainFilter>(DEFAULT_FILTER);
  const [brandFilters, setBrandFilters] = useState<Record<string, DomainFilter>>({});
  const [cols, setCols] = useState<1 | 2 | 3>(3);
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

  // Бренды по гео (код страны по алфавиту), внутри страны — в порядке ввода
  const items = useMemo(() => itemsByGeo(run.settings.items), [run.settings.items]);
  const multiCountry = new Set(items.map((it) => it.country)).size > 1;
  /** Подпись бренда пачки; в пачке из одной страны — просто бренд. */
  const labelOf = (it: { brand: string; country: string }) => (multiCountry ? `${it.brand} · ${it.country.toUpperCase()}` : it.brand);
  const byBrand = useMemo(() => {
    const map = new Map<string, RunDomainRow[]>();
    // У строк старых подборов страны нет — относим их к первому бренду с таким именем
    const legacy = new Map<string, string>();
    for (const it of items) {
      const k = itemKey(it.brand, it.country);
      map.set(k, []);
      if (!legacy.has(it.brand)) legacy.set(it.brand, k);
    }
    for (const d of domains) {
      const k = d.country ? itemKey(d.brand, d.country) : legacy.get(d.brand) ?? itemKey(d.brand, "");
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(d);
    }
    return map;
  }, [domains, items]);
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
  function toggleRows(rows: RunDomainRow[], selected: boolean) {
    for (const d of rows) if (d.status === "available" && d.selected !== selected) toggle(d.id, selected);
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
  const scopedRows = (s: typeof scope) => rowsByGeo(domains.filter((d) => (s === "selected" ? d.selected : s === "available" ? d.status === "available" : true)), items);
  async function copyList(format: "domains" | "sheet") {
    const rows = scopedRows(scope);
    if (!rows.length) { setCopied("Нечего копировать: отметьте домены или смените область"); return; }
    // Для таблицы: гео | бренд | домен — три колонки, по гео и бренду
    const text = format === "domains" ? rows.map((d) => d.domain).join("\n") : rows.map((d) => `${(d.country || "").toUpperCase()}\t${d.brand}\t${d.domain}`).join("\n");
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
    setCopied(`Скопировано: ${rows.length} ${format === "sheet" ? "строк (гео, бренд и домен в трёх колонках, по гео)" : "доменов (по гео)"}`);
    setTimeout(() => setCopied(null), 4000);
  }

  // Источник каждой приставки бренда: гео-база, ключи бренда, общие приставки, запас страны
  const sources = useMemo(() => {
    const s = run.settings;
    const pool = s.usePool ? modifierPool(s.items) : undefined;
    return new Map(s.items.map((it) => [itemKey(it.brand, it.country), new Map(brandTierEntries(it, s, pool, s.items).flat().map((e) => [e.suffix, e.source]))]));
  }, [run.settings]);
  // Источник каждой зоны бренда: общая, набор страны, зона страны, из выдачи
  const zoneSources = useMemo(() => new Map(run.settings.items.map((it) => [itemKey(it.brand, it.country), new Map(brandTldEntries(it, run.settings).map((e) => [e.tld, e.source]))])), [run.settings]);
  const allZones = useMemo(() => Array.from(new Set(domains.map((d) => d.tld))), [domains]);
  const setAllFilters = (f: DomainFilter) => { setGlobalFilter(f); setBrandFilters({}); };
  /** Рекомендованные к покупке у бренда под его фильтр: столько, сколько «доменов на бренд». */
  const recFor = (key: string, rows: RunDomainRow[], f: DomainFilter) => {
    const src = sources.get(key);
    return new Map(recommendDomains(filterRows(rows, src, f), run.settings.perBrand, (d) => String(kindOf(d, src))).map((r) => [r.id, r.reason]));
  };
  function selectAllRecommended() {
    for (const it of items) {
      const key = itemKey(it.brand, it.country);
      const rows = (byBrand.get(key) ?? []).filter((d) => d.status === "available");
      const rec = recFor(key, rows, brandFilters[key] ?? globalFilter);
      toggleRows(rows.filter((d) => rec.has(d.id)), true);
    }
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
          { label: "Брендов", value: items.length },
        ].map((s) => (
          <div key={s.label} className="kpi"><div className="kpi-value">{s.value}</div><div className="help">{s.label}</div></div>
        ))}
      </div>

      {live && (
        <Card>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2"><Badge tone={STATUS_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge><span className="help">{run.status === "QUEUED" ? "Ждёт воркер: обычно несколько секунд" : run.progress ? (run.progress.brand.startsWith("ключи и выдача") ? `Собираю ${run.progress.brand}` : `${run.progress.brandIndex} из ${run.progress.brandsTotal} брендов · сейчас «${run.progress.brand}»`) : "Запускается…"}</span></div>
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

      <RunAnalysis settings={run.settings} />

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
                <div key={r.key ?? r.brand} className={r.error ? "text-danger" : ""}>
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
          description="Область действует и на файлы, и на копирование. «Для таблицы» копирует три колонки: гео, бренд и домен — вставляется в Google Таблицу как есть. Всё упорядочено по гео, внутри — по бренду."
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
          <div className="flex flex-wrap gap-1.5">
            {([["available", `Свободные · ${overall.counts.available}`], ["selected", `✓ Выбранные · ${overall.counts.selected}`], ["taken", `Занятые · ${overall.counts.taken}`], ["all", `Все · ${overall.counts.total}`]] as const).map(([v, label]) => (
              <button key={v} type="button" className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{label}</button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set(allKeys(run.settings)))}>Развернуть все</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>Свернуть все</button>
          </div>
        </div>
      )}
      {domains.length > 0 && (
        <div className="card flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
          <span className="font-semibold">Для всех брендов:</span>
          <select className="input !w-auto !py-1 text-[13px]" value={globalFilter.src} onChange={(e) => setAllFilters({ ...globalFilter, src: e.target.value as DomainFilter["src"] })}>
            {SRC_OPTIONS.map(([v, l]) => <option key={v} value={v}>{v === "all" ? "Все источники" : l}</option>)}
          </select>
          <select className="input !w-auto !py-1 text-[13px]" value={globalFilter.tier} onChange={(e) => setAllFilters({ ...globalFilter, tier: e.target.value as DomainFilter["tier"] })}>
            {TIER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input !w-auto !py-1 text-[13px]" value={globalFilter.zone} onChange={(e) => setAllFilters({ ...globalFilter, zone: e.target.value })}>
            <option value="all">Все зоны</option>
            {allZones.map((z) => <option key={z} value={z}>.{z}</option>)}
          </select>
          <select className="input !w-auto !py-1 text-[13px]" value={globalFilter.mode} onChange={(e) => setAllFilters({ ...globalFilter, mode: e.target.value as DomainFilter["mode"] })}>
            {MODE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {!live && <button type="button" className="btn-primary btn-sm" onClick={selectAllRecommended} title="У каждого бренда отметить рекомендованные под его фильтр">★ Выбрать рекомендованные во всех</button>}
          {/* Ниже md всегда одна колонка — переключатель там ничего не меняет. */}
          <div className="ml-auto hidden md:flex items-center gap-1">
            <span className="help">Колонок:</span>
            {([1, 2, 3] as const).map((n) => <button key={n} type="button" className={`tab !px-2 !py-0.5 ${cols === n ? "active" : ""}`} onClick={() => setCols(n)}>{n}</button>)}
          </div>
        </div>
      )}

      <div className={`grid gap-3 ${cols === 1 ? "" : cols === 2 ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
        {items.map((item) => {
          const brand = item.brand;
          const key = itemKey(item.brand, item.country);
          const label = labelOf(item);
          const rows = byBrand.get(key) ?? [];
          if (q && !brand.toLowerCase().includes(q) && !rows.some((d) => d.domain.includes(q))) return null;
          const stats = computeStats(rows);
          const visible = rows.filter((d) => (view === "all" || (view === "selected" ? d.selected : view === "available" ? d.status === "available" : d.status === "taken")) && (!q || d.domain.includes(q) || brand.toLowerCase().includes(q)));
          // Во вкладке «Выбранные» бренды без выбора не показываем
          if (view === "selected" && !rows.some((d) => d.selected)) return null;
          const open = expanded.has(key);
          const filter = brandFilters[key] ?? globalFilter;
          const rec = recFor(key, visible, filter);
          const fullLabel = `${item.brand} · ${item.country.toUpperCase()}`;
          const incomplete = run.incompleteBrands.includes(fullLabel) || run.incompleteBrands.includes(brand);
          const inProgress = live && (run.progress?.brand === fullLabel || run.progress?.brand === brand);
          const toggleOpen = () => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
          return (
            <section key={key} className="card flex flex-col min-w-0">
              <div className="flex items-center gap-2 px-3 py-2.5">
                {!live && <label className="-m-2 p-2 shrink-0 cursor-pointer" title="В группу для ИИ-отбора"><input type="checkbox" className="block h-4 w-4" checked={groupBrands.has(key)} onChange={(e) => setGroupBrands((prev) => { const n = new Set(prev); if (e.target.checked) n.add(key); else n.delete(key); return n; })} /></label>}
                <button type="button" className="min-w-0 flex-1 text-left font-semibold text-[15px] truncate hover:underline" onClick={toggleOpen} title={label}>
                  {label}
                </button>
                {inProgress && <Badge tone="brand">идёт</Badge>}
                {incomplete && <Badge tone="warn">мало</Badge>}
                <span className="shrink-0 text-[12.5px] tabular-nums whitespace-nowrap" title="выбрано / свободно / занято">
                  <b className={stats.counts.selected ? "text-brand" : ""}>{stats.counts.selected}</b>
                  <span className="text-muted"> / </span><b className="text-ok">{stats.counts.available}</b>
                  <span className="text-muted"> / {stats.counts.taken}</span>
                </span>
                <button type="button" className="shrink-0 text-muted hover:text-ink px-2 py-1" onClick={toggleOpen} aria-label={open ? "Свернуть" : "Развернуть"}>{open ? "▾" : "▸"}</button>
              </div>
              {open && (
                <div className="border-t border-line flex flex-col min-h-0">
                  {rows.length === 0 ? (
                    <p className="help px-3 py-3">Ещё не проверялся</p>
                  ) : (
                    <>
                      <BrandDomains
                        rows={visible}
                        sources={sources.get(key)}
                        zoneSources={zoneSources.get(key)}
                        filter={filter}
                        setFilter={(f) => setBrandFilters((prev) => ({ ...prev, [key]: f }))}
                        onToggle={toggle}
                        rec={rec}
                        top={item.research?.competitorDomains}
                      />
                      <div className="help px-3 py-1.5 border-t border-line truncate" title={`Зоны: выбрано ${formatCounts(stats.zones.selected)} · свободно ${formatCounts(stats.zones.available)}\nПриставки: выбрано ${formatCounts(stats.suffixes.selected)} · свободно ${formatCounts(stats.suffixes.available)}`}>
                        {stats.counts.selected ? <>зоны {formatCounts(stats.zones.selected)} · приставки {formatCounts(stats.suffixes.selected)}</> : <>свободно: {formatCounts(stats.zones.available)}</>}
                      </div>
                      {!live && (
                        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-t border-line">
                          <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => toggleRows(visible.filter((d) => rec.has(d.id)), true)} title="Отметить рекомендованные под текущий фильтр"><span className="sm:hidden">★ Реком.</span><span className="hidden sm:inline">★ Выбрать рекомендованные</span></button>
                          <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => toggleRows(filterRows(visible, sources.get(key), filter), true)} title="Выбрать свободные домены под текущий фильтр">Видимые</button>
                          <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => toggleRows(filterRows(visible, sources.get(key), filter), false)}>Снять</button>
                          <button type="button" className="btn-primary btn-sm !px-2.5 !py-1 text-[12.5px] ml-auto" disabled={!!aiBusy || stats.counts.available === 0} onClick={() => runAi([key], key)}>{aiBusy === key ? "ИИ…" : "ИИ-отбор"}</button>
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
          <tbody><Row label="Выбрано" pairs={stats.zones.selected} /><Row label="Свободно" pairs={stats.zones.available} /><Row label="Свободно, не выбрано" pairs={stats.zones.unused} /></tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th colSpan={2}>Приставки</th></tr></thead>
          <tbody><Row label="Выбрано" pairs={stats.suffixes.selected} /><Row label="Свободно" pairs={stats.suffixes.available} /><Row label="Свободно, не выбрано" pairs={stats.suffixes.unused} /></tbody>
        </table>
      </div>
    </div>
  );
}
