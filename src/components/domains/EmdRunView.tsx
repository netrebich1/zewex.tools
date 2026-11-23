"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { pollWhileVisible } from "@/lib/poll";
import { Alert, Badge, Card } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { recheckUnknownDomainsAction } from "@/actions/domains";
import { STATUS_TONE } from "./DomainsNav";
import { BrandSelected, SelectedDomains } from "./SelectedDomains";
import type { RunPayload } from "./DomainRunView";
import { computeStats } from "@/lib/domains/selection";
import { itemKey, RUN_STATUS_LABELS, type BrandItem } from "@/lib/domains/types";
import type { RunDomainRow } from "@/lib/domains/runs";
import { EMD_DEFAULTS, EMD_PATTERN_LABELS, eligibleKeywords, type EmdKeyword, type EmdPattern } from "@/lib/domains/emd";
import { tldOf } from "@/lib/domains/mining";

const LIVE = new Set(["QUEUED", "RUNNING"]);
const fmt = (n: number) => n.toLocaleString("ru-RU");

/** Карточка подбора «EMD по ключам»: кластеры, их ключи с TOP-10 Google, домены по весу, выбор и выгрузка. */
export function EmdRunView({ initial }: { initial: RunPayload }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<"available" | "selected" | "taken" | "all">("available");
  const [query, setQuery] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const keys = (items: BrandItem[]) => items.map((it) => itemKey(it.brand, it.country));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial.run.settings.items.length <= 30 ? keys(initial.run.settings.items) : []));
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const pending = useRef(new Map<string, boolean>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { run, domains } = data;
  const live = LIVE.has(run.status);
  const s = run.settings;
  const emd = { ...EMD_DEFAULTS, ...s.emd };
  const items = s.items;

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
    return pollWhileVisible(reload, 5_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, run.id]);

  const byCluster = useMemo(() => {
    const map = new Map<string, RunDomainRow[]>(items.map((it) => [itemKey(it.brand, it.country), []]));
    for (const d of domains) map.get(itemKey(d.brand, d.country))?.push(d);
    for (const rows of map.values()) rows.sort((a, b) => a.sortOrder - b.sortOrder);
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
  const setRows = (rows: RunDomainRow[], selected: boolean) => { for (const d of rows) if (d.status === "available" && d.selected !== selected) toggle(d.id, selected); };
  /** Лучшие свободные кластера по весу: столько, сколько «доменов на кластер». */
  const bestOf = (rows: RunDomainRow[]) => rows.filter((d) => d.status === "available").slice(0, s.perBrand);

  async function copyDomains() {
    const rows = domains.filter((d) => d.selected);
    if (!rows.length) { setCopied("Нечего копировать: ничего не выбрано"); return; }
    const text = rows.map((d) => `${(d.country || "").toUpperCase()}\t${d.brand}\t${d.suffix ?? ""}\t${d.domain}`).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* старый браузер */ }
    setCopied(`Скопировано ${rows.length} строк: гео, тема, ключ и домен в четырёх колонках`);
    setTimeout(() => setCopied(null), 4000);
  }

  const serpCost = items.reduce((a, it) => a + (it.emd?.serpCostUsd ?? 0), 0);
  const pct = run.progress && run.progress.brandsTotal ? Math.round((run.progress.brandIndex / run.progress.brandsTotal) * 100) : run.status === "DONE" ? 100 : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Кластеров", value: items.length },
          { label: "Проверено доменов", value: Math.max(0, run.totalChecked - overall.counts.unknown) },
          { label: "Свободно", value: overall.counts.available },
          { label: "Выбрано", value: overall.counts.selected },
        ].map((k) => (
          <div key={k.label} className="kpi"><div className="kpi-value">{fmt(k.value)}</div><div className="help">{k.label}</div></div>
        ))}
      </div>

      {live && (
        <Card>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2"><Badge tone={STATUS_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge><span className="help">{run.status === "QUEUED" ? "Ждёт воркер: обычно несколько секунд" : run.progress ? (run.progress.brand.startsWith("выдача") ? `Снимаю ${run.progress.brand}` : `${run.progress.brandIndex} из ${run.progress.brandsTotal} кластеров · сейчас «${run.progress.brand}»`) : "Запускается…"}</span></div>
            <span className="help">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-ink/10 overflow-hidden"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
          <p className="help mt-2">Страница обновляется сама. Можно уйти — подбор продолжится в фоне.</p>
        </Card>
      )}
      {run.status === "FAILED" && run.error && <Alert tone="danger">Подбор прерван ошибкой: {run.error}</Alert>}
      {run.status === "STOPPED" && <Alert tone="warn">Подбор остановлен. Проверенные домены сохранены.</Alert>}
      {overall.counts.unknown > 0 && !live && (
        <Alert tone="danger">
          Не удалось проверить {overall.counts.unknown} доменов: реестры не ответили.
          {run.status === "DONE" && (
            <ActionForm action={recheckUnknownDomainsAction} className="mt-2" hidden={{ id: run.id }}>
              <SubmitButton className="btn-primary btn-sm" pendingText="…">Допроверить непроверенные</SubmitButton>
            </ActionForm>
          )}
        </Alert>
      )}
      {run.incompleteBrands.length > 0 && !live && <Alert tone="warn">Меньше {s.perBrand} свободных доменов у {run.incompleteBrands.length} кластеров: {run.incompleteBrands.slice(0, 12).join(", ")}{run.incompleteBrands.length > 12 ? "…" : ""}. Снизьте порог частоты, добавьте зоны или разрешите дефис и повторите подбор.</Alert>}
      {saveError && <Alert tone="danger">{saveError}</Alert>}

      {domains.length > 0 && (
        <Card
          title="Выгрузка"
          description={`Домены в карточке кластера идут по весу: частота ключа × точность совпадения × зона × длина. ★ — лучшие свободные, столько, сколько «доменов на кластер» (${s.perBrand}).${serpCost ? ` Выдача Google: $${serpCost.toFixed(3)}.` : ""}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary btn-sm" onClick={() => { for (const rows of byCluster.values()) setRows(bestOf(rows), true); }}>★ Выбрать лучшие во всех</button>
              <button type="button" className="btn-ghost btn-sm" onClick={copyDomains}>Скопировать выбранные</button>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=xlsx&scope=selected`}>XLSX</a>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=csv&scope=selected`}>CSV</a>
            </div>
          }
        >
          {copied ? <Alert tone={copied.startsWith("Нечего") ? "warn" : "ok"}>{copied}</Alert> : <p className="help">Выгрузка — выбранные домены; в колонке «Бренд» — тема кластера, в «Приставке» — ключ, из которого собран домен.</p>}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input className="input !w-auto min-w-[220px]" placeholder="Поиск по домену, теме или ключу" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          {([["available", `Свободные · ${overall.counts.available}`], ["selected", `✓ Выбранные · ${overall.counts.selected}`], ["taken", `Занятые · ${overall.counts.taken}`], ["all", `Все · ${overall.counts.total}`]] as const).map(([v, label]) => (
            <button key={v} type="button" className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{label}</button>
          ))}
        </div>
        {view !== "selected" && (
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set(keys(items)))}>Развернуть все</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>Свернуть все</button>
          </div>
        )}
      </div>

      {view === "selected" ? (
        <SelectedDomains items={items} byBrand={byCluster} labelOf={(it) => `${it.brand} · ${it.country.toUpperCase()}`} query={q} onToggle={toggle} />
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const key = itemKey(item.brand, item.country);
            const c = item.emd;
            const rows = byCluster.get(key) ?? [];
            const kwMatch = (k: EmdKeyword) => k.phrase.toLowerCase().includes(q);
            if (q && !item.brand.toLowerCase().includes(q) && !rows.some((d) => d.domain.includes(q)) && !c?.keywords.some(kwMatch)) return null;
            const stats = computeStats(rows);
            const visible = rows.filter((d) => (view === "all" || (view === "available" ? d.status === "available" : d.status === "taken")) && (!q || d.domain.includes(q) || item.brand.toLowerCase().includes(q) || (d.suffix ?? "").toLowerCase().includes(q)));
            const best = new Set(bestOf(rows).map((d) => d.id));
            const open = expanded.has(key);
            const showSelected = selectedCards.has(key);
            const toggleOpen = () => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
            const inProgress = live && run.progress?.brand === `${item.brand} · ${item.country.toUpperCase()}`;
            const incomplete = run.incompleteBrands.includes(`${item.brand} · ${item.country.toUpperCase()}`);
            return (
              <section key={key} className="card flex flex-col min-w-0">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={toggleOpen}>
                    <span className="block truncate font-semibold text-[15px] hover:underline" title={item.brand}>{item.brand} · {item.country.toUpperCase()}</span>
                    {c && <span className="block truncate help" title={c.projects.join("\n")}>{c.themeRu ? `${c.themeRu} · ` : ""}{fmt(c.themeVolume)}/мес в теме</span>}
                  </button>
                  {inProgress && <Badge tone="brand">идёт</Badge>}
                  {incomplete && <Badge tone="warn">мало</Badge>}
                  {stats.counts.unknown > 0 && !inProgress && <Badge tone="danger">не проверено {stats.counts.unknown}</Badge>}
                  <span className="shrink-0 text-[12.5px] tabular-nums whitespace-nowrap" title="выбрано / свободно / занято">
                    <b className={stats.counts.selected ? "text-brand" : ""}>{stats.counts.selected}</b>
                    <span className="text-muted"> / </span><b className="text-ok">{stats.counts.available}</b>
                    <span className="text-muted"> / {stats.counts.taken}</span>
                  </span>
                  <button type="button" className="shrink-0 text-muted hover:text-ink px-2 py-1" onClick={toggleOpen} aria-label={open ? "Свернуть" : "Развернуть"}>{open ? "▾" : "▸"}</button>
                </div>
                {open && (
                  <div className="border-t border-line flex flex-col min-h-0">
                    {c && <KeywordsBlock keywords={c.keywords} minVolume={emd.minVolume} matchPct={emd.matchPct} serpDone={!!c.serpAt} serpOn={s.autoResearch} eligible={new Set(eligibleKeywords(c, emd.minVolume).map((k) => k.phrase))} />}
                    {showSelected ? (
                      <BrandSelected rows={rows} onToggle={toggle} />
                    ) : rows.length === 0 ? (
                      <p className="help px-3 py-3">{live ? "Ещё не проверялся" : "Ни одного домена: ключи длиннее лимита или ниже порога частоты"}</p>
                    ) : (
                      <ul className="max-h-80 overflow-auto divide-y divide-line">
                        {visible.map((d) => <DomainLine key={d.id} d={d} best={best.has(d.id)} volume={c?.keywords.find((k) => k.phrase === d.suffix)?.volume} onToggle={toggle} />)}
                        {!visible.length && <li className="help px-3 py-3">В этой вкладке доменов нет</li>}
                      </ul>
                    )}
                    {!live && rows.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 px-3 py-2 border-t border-line">
                        {!showSelected && (
                          <>
                            <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => setRows(bestOf(rows), true)} title="Отметить лучшие свободные по весу">★ Выбрать {s.perBrand} лучших</button>
                            <button type="button" className="btn-ghost btn-sm !px-2.5 !py-1 text-[12.5px]" onClick={() => setRows(rows, false)}>Снять все</button>
                          </>
                        )}
                        <button type="button" className={`${showSelected ? "btn-primary" : "btn-ghost"} btn-sm !px-2.5 !py-1 text-[12.5px] ml-auto`} onClick={() => setSelectedCards((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>{showSelected ? "← Все домены" : `✓ Выбранные · ${stats.counts.selected}`}</button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DomainLine({ d, best, volume, onToggle }: { d: RunDomainRow; best: boolean; volume?: number; onToggle: (id: string, selected: boolean) => void }) {
  return (
    <li className={`flex items-center gap-2 px-3 py-1.5 text-[13.5px] ${d.selected ? "bg-brand-soft/40" : ""}`} title={`ключ «${d.suffix ?? ""}»${volume ? ` · ${volume}/мес` : ""}`}>
      {d.status === "available" ? (
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={d.selected} onChange={(e) => onToggle(d.id, e.target.checked)} />
      ) : (
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${d.status === "taken" ? "bg-danger" : "bg-line-2"}`} title={d.status === "taken" ? "занят" : "не проверен"} />
      )}
      <span className={`font-mono min-w-0 flex-1 truncate ${d.status === "taken" ? "text-muted" : ""}`}>{d.domain}</span>
      {best && d.status === "available" && <span className="shrink-0 text-warn" title="Лучший по весу">★</span>}
      <span className="shrink-0 rounded-md bg-ink/5 px-1.5 text-[11px] text-muted">{EMD_PATTERN_LABELS[d.pattern as EmdPattern] ?? d.pattern}</span>
      {volume ? <span className="shrink-0 w-12 text-right text-[11.5px] tabular-nums text-muted">{volume >= 1000 ? `${Math.round(volume / 100) / 10}k` : volume}</span> : null}
    </li>
  );
}

/** Ключи кластера: частота, маленькие сайты в топе и TOP-10 Google с подсветкой доменов, где есть ключ. */
function KeywordsBlock({ keywords, minVolume, matchPct, serpDone, serpOn, eligible }: { keywords: EmdKeyword[]; minVolume: number; matchPct: number; serpDone: boolean; serpOn: boolean; eligible: Set<string> }) {
  const [openKw, setOpenKw] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Сводка по кластеру: домены с ключом во всех TOP-10 и их зоны
  const matched = new Map<string, { domain: string; match: number; pos: number; kw: string }>();
  for (const k of keywords) for (const e of k.top10 ?? []) if ((e.match ?? 0) >= matchPct) {
    const prev = matched.get(e.domain);
    if (!prev || (e.match ?? 0) > prev.match) matched.set(e.domain, { domain: e.domain, match: e.match ?? 0, pos: e.pos, kw: k.phrase });
  }
  const zones = new Map<string, number>();
  for (const m of matched.values()) zones.set(tldOf(m.domain), (zones.get(tldOf(m.domain)) ?? 0) + 1);
  return (
    <div className="border-b border-line px-3 py-2 space-y-2">
      <ul className="space-y-0.5">
        {keywords.map((k) => {
          const inUse = eligible.has(k.phrase);
          const hits = (k.top10 ?? []).filter((e) => (e.match ?? 0) >= matchPct).length;
          const isOpen = openKw === k.phrase;
          return (
            <li key={k.phrase}>
              <button type="button" className={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] hover:bg-ink/5 ${inUse ? "" : "opacity-55"}`} onClick={() => setOpenKw(isOpen ? null : k.phrase)} title={[k.ru, k.trend, k.kd !== null ? `сложность ${k.kd}` : "", k.officialInTop ? "официальный сайт в топе" : ""].filter(Boolean).join(" · ")}>
                <span className="w-3 shrink-0 text-muted">{k.top10 ? (isOpen ? "▾" : "▸") : ""}</span>
                <span className="min-w-0 flex-1 truncate">{k.phrase}{k.theme && <span className="ml-1.5 rounded bg-brand-soft px-1 text-[10.5px] text-brand">тема</span>}</span>
                {!inUse && <span className="shrink-0 text-[11px] text-muted">ниже {minVolume}</span>}
                {k.smallSites > 0 && <span className="shrink-0 text-[11px] text-ok" title={`Маленьких сайтов в топе: ${k.smallSites}${k.smallTlds.length ? ` (${k.smallTlds.map(([t, n]) => `${t} ×${n}`).join(", ")})` : ""}`}>мал. {k.smallSites}</span>}
                {k.top10 && <span className={`shrink-0 text-[11px] ${hits ? "font-semibold text-ok" : "text-muted"}`} title="Доменов с ключом в TOP-10">с ключом {hits}</span>}
                {k.serpError && <span className="shrink-0 text-[11px] text-danger" title={k.serpError}>выдача ✕</span>}
                <span className="w-14 shrink-0 text-right tabular-nums">{fmt(k.volume)}</span>
              </button>
              {isOpen && k.top10 && (
                <ol className="ml-4 mt-1 mb-1.5 rounded-lg border border-line divide-y divide-line">
                  {k.top10.filter((e) => showAll || (e.match ?? 0) >= matchPct).map((e) => {
                    const hit = (e.match ?? 0) >= matchPct;
                    return (
                      <li key={e.domain} className={`flex items-center gap-2 px-2 py-1 text-[12.5px] ${hit ? "bg-ok-soft/50" : "opacity-55"}`} title={e.title}>
                        <span className="w-4 shrink-0 text-right tabular-nums text-muted">{e.pos}</span>
                        <a href={`https://${e.domain}`} target="_blank" rel="noreferrer" className={`min-w-0 flex-1 truncate font-mono hover:underline ${hit ? "font-semibold" : ""}`}>{e.domain}</a>
                        <span className={`shrink-0 text-[11px] tabular-nums ${hit ? "text-ok font-semibold" : "text-muted"}`}>{e.match ?? 0}%</span>
                      </li>
                    );
                  })}
                  {!k.top10.some((e) => (e.match ?? 0) >= matchPct) && !showAll && <li className="help px-2 py-1">Доменов с ключом от {matchPct}% нет</li>}
                  <li className="px-2 py-1">
                    <button type="button" className="text-[12px] text-brand hover:underline" onClick={() => setShowAll(!showAll)}>{showAll ? "Только с ключом" : `Показать всю выдачу (${k.top10.length})`}</button>
                  </li>
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      {serpDone ? (
        <div className="space-y-1 text-[11.5px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="help mr-0.5">С ключом в TOP-10:</span>
            {matched.size ? [...matched.values()].sort((a, b) => b.match - a.match || a.pos - b.pos).slice(0, 12).map((m) => (
              <a key={m.domain} href={`https://${m.domain}`} target="_blank" rel="noreferrer" className="rounded-md bg-ok-soft px-1.5 py-0.5 font-mono text-ok hover:underline" title={`«${m.kw}» · позиция ${m.pos} · ключа ${m.match}%`}>{m.domain}</a>
            )) : <span className="help">нет — EMD-сайтов в выдаче не видно</span>}
          </div>
          {zones.size > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="help mr-0.5">Их зоны:</span>
              {[...zones.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => <span key={t} className="rounded-md bg-ink/5 px-1.5 py-0.5">.{t} · {n}</span>)}
            </div>
          )}
        </div>
      ) : (
        <p className="help text-[11.5px]">{serpOn ? "Выдача Google по ключам ещё снимается" : "Выдачу Google в этом подборе не снимали"}</p>
      )}
    </div>
  );
}
