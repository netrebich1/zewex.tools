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
import { EMD_DEFAULTS, EMD_LEVEL_LABELS, EMD_MOD_SOURCE_LABELS, EMD_PATTERN_LABELS, eligibleKeywords, emdGeo, emdModifiers, emdSourceKeyword, emdZoneSuggestions, emdRegionalZones, isGeoPattern, usableFound, isModPattern, phraseWords, type EmdFound, type EmdKeyword, type EmdPattern } from "@/lib/domains/emd";
import { addEmdZonesAction } from "@/actions/domainsEmd";
import { buyableTld } from "@/lib/domains/generator";
import { tldOf } from "@/lib/domains/mining";

const LIVE = new Set(["QUEUED", "RUNNING"]);
/** Вкладка «тип» в карточке кластера: группа основы, приписки, гео, вторая пачка зон */
type Kind = "1" | "2" | "3" | "4" | "5" | "6" | "region" | "exact" | "mod" | "geo" | "zones";
const KINDS: Array<[Kind, string]> = [
  ["1", EMD_LEVEL_LABELS[1]], ["2", EMD_LEVEL_LABELS[2]], ["3", EMD_LEVEL_LABELS[3]], ["4", EMD_LEVEL_LABELS[4]],
  ["5", EMD_LEVEL_LABELS[5]], ["6", EMD_LEVEL_LABELS[6]], ["region", "Регион. зоны"], ["exact", "Прямое .io/.co"], ["mod", "С приписками"], ["geo", "Гео"], ["zones", "Доп. зоны"],
];
/** Региональные зоны и io/co — только для точных ключей без приписок: прямое вхождение отдельной вкладкой */
const kindBy = (extra: Set<string>, exactZones: Set<string>) => (d: RunDomainRow): Kind => {
  if (isGeoPattern(d.pattern)) return "geo";
  if (isModPattern(d.pattern)) return "mod";
  const exactCore = d.tier === 1 || d.tier === 3 || d.tier === 5;
  if (exactCore && emdRegionalZones(d.country).includes(d.tld)) return "region";
  if (exactCore && exactZones.has(d.tld)) return "exact";
  if (extra.has(d.tld)) return "zones";
  return String(Math.min(6, Math.max(1, d.tier))) as Kind;
};
/** Приписка/гео домена: «ключ + beste» → beste */
const modOf = (d: RunDomainRow) => (d.suffix?.includes(" + ") ? d.suffix.split(" + ").pop() ?? "" : "");
type CardFilter = { kind: Kind | "all"; add: string; zone: string };
const NO_FILTER: CardFilter = { kind: "all", add: "all", zone: "all" };

function Chip({ active, label, n, onClick, title }: { active: boolean; label: string; n: number; onClick: () => void; title?: string }) {
  return (
    <button type="button" title={title} disabled={!n && !active} onClick={onClick} className={`rounded-md px-1.5 py-0.5 text-[11.5px] whitespace-nowrap ${active ? "bg-ink text-bg" : n ? "bg-ink/5 hover:bg-ink/10" : "bg-ink/5 opacity-40"}`}>
      {label} <span className="opacity-70">{n}</span>
    </button>
  );
}
const fmt = (n: number) => n.toLocaleString("ru-RU");

/** Карточка подбора «EMD по ключам»: кластеры, их ключи с TOP-10 Google, домены по весу, выбор и выгрузка. */
export function EmdRunView({ initial }: { initial: RunPayload }) {
  const [data, setData] = useState(initial);
  const [view, setView] = useState<"available" | "selected" | "taken" | "all">("available");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, CardFilter>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const keys = (items: BrandItem[]) => items.map((it) => itemKey(it.brand, it.country));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initial.run.settings.items.length <= 30 ? keys(initial.run.settings.items) : []));
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const pending = useRef(new Map<string, boolean>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { run } = data;
  // .fr не покупаем — в карточке не показываем и старые проверенные
  const domains = useMemo(() => data.domains.filter((d) => buyableTld(d.tld)), [data.domains]);
  const live = LIVE.has(run.status);
  const s = run.settings;
  const emd = { ...EMD_DEFAULTS, ...s.emd };
  const items = s.items;
  const extraZones = useMemo(() => new Set([...(s.emd?.extraZones ?? []), ...(s.emd?.pendingZones ?? [])]), [s.emd]);
  const exactZones = useMemo(() => new Set(s.emd?.exactZones ?? EMD_DEFAULTS.exactZones), [s.emd]);
  const kindOf = kindBy(extraZones, exactZones);
  const zoneTips = useMemo(() => emdZoneSuggestions(items, { ...emd, tlds: s.tlds, autoZones: s.autoZones }), [items, emd, s.tlds, s.autoZones]);

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
          description={`В карточке кластера домены разбиты на группы: точный ключ, вариации ключа, из выдачи, с приписками; внутри — по весу (частота × точность × зона × длина). ★ — ${s.perBrand} лучших свободных кластера.${serpCost ? ` Выдача Google: $${serpCost.toFixed(3)}.` : ""}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary btn-sm" onClick={() => { for (const rows of byCluster.values()) setRows(bestOf(rows), true); }}>★ Выбрать лучшие во всех</button>
              <button type="button" className="btn-ghost btn-sm" onClick={copyDomains}>Скопировать выбранные</button>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=xlsx&scope=selected`}>XLSX</a>
              <a className="btn-ghost btn-sm" href={`/api/domains/runs/${run.id}/export?format=csv&scope=selected`}>CSV</a>
            </div>
          }
        >
          {copied ? <Alert tone={copied.startsWith("Нечего") ? "warn" : "ok"}>{copied}</Alert> : <p className="help">Выгрузка — выбранные домены; в колонке «Бренд» — тема кластера, в «Приставке» — ключ, из которого собран домен (и «+ приписка», если она есть).</p>}
        </Card>
      )}

      {!live && domains.length > 0 && <ZoneSuggestions runId={run.id} tips={zoneTips} done={[...extraZones]} exactZones={[...exactZones]} onQueued={reload} />}

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
            const f = filters[key] ?? NO_FILTER;
            const setF = (patch: Partial<CardFilter>) => setFilters((prev) => ({ ...prev, [key]: { ...(prev[key] ?? NO_FILTER), ...patch } }));
            const base = rows.filter((d) => (view === "all" || (view === "available" ? d.status === "available" : d.status === "taken")) && (!q || d.domain.includes(q) || item.brand.toLowerCase().includes(q) || (d.suffix ?? "").toLowerCase().includes(q)));
            const geoTier = new Map(emdGeo(item.country).map((g) => [g.mod, g.tier]));
            const addOf = (d: RunDomainRow) => (isGeoPattern(d.pattern) ? `g${geoTier.get(modOf(d)) ?? 3}` : isModPattern(d.pattern) ? "mod" : "none");
            const passAdd = (d: RunDomainRow, add: string) => add === "all" || (add.startsWith("w:") ? modOf(d) === add.slice(2) && (isModPattern(d.pattern) || isGeoPattern(d.pattern)) : addOf(d) === add);
            const pass = (d: RunDomainRow, skip?: "kind" | "add" | "zone") =>
              (skip === "kind" || f.kind === "all" || kindOf(d) === f.kind) && (skip === "add" || passAdd(d, f.add)) && (skip === "zone" || f.zone === "all" || d.tld === f.zone);
            const visible = base.filter((d) => pass(d));
            const count = (skip: "kind" | "add" | "zone", test: (d: RunDomainRow) => boolean) => base.filter((d) => pass(d, skip) && test(d)).length;
            const sections = f.kind === "all"
              ? KINDS.map(([g, label]) => ({ g, label, rows: visible.filter((d) => kindOf(d) === g) })).filter((x) => x.rows.length)
              : [{ g: f.kind, label: KINDS.find(([g]) => g === f.kind)?.[1] ?? "", rows: visible }];
            const mods = c ? emdModifiers(c, item.country, emd) : [];
            const modWords = Array.from(new Set([...mods.map((m) => m.mod), ...rows.filter((d) => isModPattern(d.pattern)).map(modOf)])).filter(Boolean);
            const geoWords = emdGeo(item.country);
            const zonesHere = Array.from(new Set(rows.map((d) => d.tld)));
            const volOf = (d: RunDomainRow) => c?.keywords.find((k) => k.phrase === emdSourceKeyword(d.suffix))?.volume;
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
                    {c && <KeywordsBlock keywords={c.keywords} found={c.found ? usableFound(c, item.country) : undefined} foundError={c.foundError} minVolume={emd.minVolume} matchPct={emd.matchPct} serpDone={!!c.serpAt} serpOn={s.autoResearch} eligible={new Set(eligibleKeywords(c, emd.minVolume).map((k) => k.phrase))} />}
                    {c && <ThemeStatus theme={c.theme} rows={rows} />}
                    {!showSelected && rows.length > 0 && (
                      <div className="space-y-1.5 border-b border-line px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <Chip active={f.kind === "all"} label="Все" n={count("kind", () => true)} onClick={() => setF({ kind: "all" })} />
                          {KINDS.map(([g, label]) => <Chip key={g} active={f.kind === g} label={label} n={count("kind", (d) => kindOf(d) === g)} onClick={() => setF({ kind: g })} />)}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Chip active={f.add === "all"} label="С приписками и без" n={count("add", () => true)} onClick={() => setF({ add: "all" })} />
                          <Chip active={f.add === "none"} label="Без приписок" n={count("add", (d) => addOf(d) === "none")} onClick={() => setF({ add: "none" })} />
                          {(["g1", "g2", "g3"] as const).map((g) => <Chip key={g} active={f.add === g} label={`Гео ${g.slice(1)}`} n={count("add", (d) => addOf(d) === g)} onClick={() => setF({ add: g })} title={geoWords.filter((x) => `g${x.tier}` === g).map((x) => x.mod).join(", ")} />)}
                          {geoWords.map((g) => <Chip key={`g:${g.mod}`} active={f.add === `w:${g.mod}`} label={`+${g.mod}`} n={count("add", (d) => isGeoPattern(d.pattern) && modOf(d) === g.mod)} onClick={() => setF({ add: `w:${g.mod}` })} title={`гео, уровень ${g.tier}`} />)}
                          {modWords.map((m) => {
                            const src = mods.find((x) => x.mod === m);
                            return <Chip key={`m:${m}`} active={f.add === `w:${m}`} label={src?.pos === "start" ? `${m}+` : `+${m}`} n={count("add", (d) => isModPattern(d.pattern) && modOf(d) === m)} onClick={() => setF({ add: `w:${m}` })} title={src ? `${EMD_MOD_SOURCE_LABELS[src.source]}${src.example ? ` · «${src.example}»` : ""}` : "приписка"} />;
                          })}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Chip active={f.zone === "all"} label="Все зоны" n={count("zone", () => true)} onClick={() => setF({ zone: "all" })} />
                          {zonesHere.map((z) => <Chip key={z} active={f.zone === z} label={`.${z}`} n={count("zone", (d) => d.tld === z)} onClick={() => setF({ zone: z })} title={extraZones.has(z) ? "вторая пачка" : undefined} />)}
                        </div>
                      </div>
                    )}
                    {showSelected ? (
                      <BrandSelected rows={rows} onToggle={toggle} />
                    ) : rows.length === 0 ? (
                      <p className="help px-3 py-3">{live ? "Ещё не проверялся" : "Ни одного домена: ключи длиннее лимита или ниже порога частоты"}</p>
                    ) : (
                      <div className="max-h-[30rem] overflow-auto">
                        {sections.map((sec) => (
                          <div key={sec.g}>
                            <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-surface px-3 py-1 text-[11.5px] font-semibold uppercase tracking-wide text-muted">
                              <span>{sec.label}</span><span className="tabular-nums font-normal normal-case">· {sec.rows.length}</span>
                            </div>
                            <ul className="divide-y divide-line">
                              {sec.rows.map((d) => <DomainLine key={d.id} d={d} best={best.has(d.id)} volume={volOf(d)} onToggle={toggle} />)}
                            </ul>
                          </div>
                        ))}
                        {!visible.length && <p className="help px-3 py-3">Нет доменов под фильтр</p>}
                      </div>
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
    <li className={`flex items-center gap-2 px-3 py-1.5 text-[13.5px] ${d.selected ? "bg-brand-soft/40" : ""}`} title={`ключ «${emdSourceKeyword(d.suffix)}»${volume ? ` · ${volume}/мес` : ""}${d.suffix?.includes(" + ") ? ` · приписка ${d.suffix.split(" + ").pop()}` : ""}`}>
      {d.status === "available" ? (
        <input type="checkbox" className="h-4 w-4 shrink-0" checked={d.selected} onChange={(e) => onToggle(d.id, e.target.checked)} />
      ) : (
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${d.status === "taken" ? "bg-danger" : "bg-line-2"}`} title={d.status === "taken" ? "занят" : "не проверен"} />
      )}
      <span className={`font-mono min-w-0 flex-1 truncate ${d.status === "taken" ? "text-muted" : ""}`}>{d.domain}</span>
      {best && d.status === "available" && <span className="shrink-0 text-warn" title="Лучший по весу">★</span>}
      {d.suffix?.includes(" + ") && <span className="shrink-0 font-mono text-[11px] text-brand">+{d.suffix.split(" + ").pop()}</span>}
      <span className="shrink-0 rounded-md bg-ink/5 px-1.5 text-[11px] text-muted">{EMD_PATTERN_LABELS[d.pattern as EmdPattern] ?? d.pattern}</span>
      {volume ? <span className="shrink-0 w-12 text-right text-[11.5px] tabular-nums text-muted">{volume >= 1000 ? `${Math.round(volume / 100) / 10}k` : volume}</span> : null}
    </li>
  );
}

/** Ключи кластера: частота, маленькие сайты в топе и TOP-10 Google с подсветкой доменов, где есть ключ. */
function KeywordsBlock({ keywords, found, foundError, minVolume, matchPct, serpDone, serpOn, eligible }: { keywords: EmdKeyword[]; found?: EmdFound[]; foundError?: string; minVolume: number; matchPct: number; serpDone: boolean; serpOn: boolean; eligible: Set<string> }) {
  const [openKw, setOpenKw] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showFound, setShowFound] = useState(false);
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
      {found && (
        <div className="text-[12.5px]">
          <button type="button" className="text-brand hover:underline" onClick={() => setShowFound(!showFound)}>
            {showFound ? "▾" : "▸"} Найденные ключи темы · {found.length}
          </button>
          {foundError && !/no search results/i.test(foundError) && <span className="ml-2 text-[11px] text-danger" title={foundError}>частично: {foundError.slice(0, 60)}</span>}
          {showFound && (
            <ul className="mt-1 space-y-0.5">
              {found.map((f) => (
                <li key={f.phrase} className="flex items-center gap-2 px-1">
                  <span className="min-w-0 flex-1 truncate">{f.phrase}</span>
                  <span className="shrink-0 text-[11px] text-muted">{f.source === "keywords" ? "запросы" : f.source === "autocomplete" ? "подсказки" : "похожие"}</span>
                  <span className="w-14 shrink-0 text-right tabular-nums">{f.volume ? fmt(f.volume) : "—"}</span>
                </li>
              ))}
              {!found.length && <li className="help px-1">Ничего сверх таблицы не нашлось</li>}
            </ul>
          )}
        </div>
      )}
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

/** Точная тема во всех зонах — с занятыми: видно, что тема проверена, даже если всё занято. */
function ThemeStatus({ theme, rows }: { theme: string; rows: RunDomainRow[] }) {
  const words = phraseWords(theme);
  const labels = new Set([words.join(""), words.join("-")]);
  const list = rows.filter((d) => labels.has(d.domain.slice(0, d.domain.length - d.tld.length - 1)) && !isModPattern(d.pattern));
  if (!list.length) return null;
  const free = list.filter((d) => d.status === "available").length;
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-[11.5px]">
      <span className="help mr-0.5">Тема точно:</span>
      {list.map((d) => (
        <span key={d.id} className={`rounded-md px-1.5 py-0.5 font-mono ${d.status === "available" ? "bg-ok-soft text-ok" : d.status === "taken" ? "bg-ink/5 text-danger line-through" : "bg-ink/5 text-muted"}`} title={d.status === "available" ? "свободен" : d.status === "taken" ? "занят" : "не проверен"}>{d.domain}</span>
      ))}
      {!free && <span className="help ml-1">— все заняты, смотри вариации темы</span>}
    </div>
  );
}

/** Зоны из выдачи, которые ещё не проверялись: отметить и проверить второй пачкой в этом же подборе. */
function ZoneSuggestions({ runId, tips, done, exactZones, onQueued }: { runId: string; tips: Array<{ tld: string; all: number; hits: number; small: number; clusters: number }>; done: string[]; exactZones: string[]; onQueued: () => void }) {
  const [exactOwn, setExactOwn] = useState(exactZones.join(", "));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tips.filter((t) => t.hits > 0).map((t) => t.tld)));
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const zones = [...picked, ...own.split(/[\s,;]+/).map((z) => z.trim().replace(/^\./, "").toLowerCase()).filter(Boolean)];
  async function go(exact = false) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await addEmdZonesAction(runId, exact ? exactOwn.split(/[\s,;]+/).map((z) => z.trim().replace(/^\./, "").toLowerCase()).filter(Boolean) : zones, exact);
      setMsg(r);
      if (r.ok) onQueued();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Другие зоны из выдачи" description="Зоны, которые встречаются в TOP-10 по ключам и у маленьких сайтов таблицы, но в этом подборе не проверялись. Отметь нужные — те же основы и приписки проверятся в них второй пачкой, результаты появятся во вкладке «Доп. зоны».">
      <div className="space-y-3">
        {tips.length ? (
          <div className="flex flex-wrap gap-1.5">
            {tips.map((t) => {
              const on = picked.has(t.tld);
              return (
                <button key={t.tld} type="button" onClick={() => setPicked((prev) => { const n = new Set(prev); if (n.has(t.tld)) n.delete(t.tld); else n.add(t.tld); return n; })}
                  className={`rounded-lg border px-2 py-1 text-[12.5px] ${on ? "border-ink bg-ink text-bg" : "border-line hover:border-ink/40"}`}
                  title={`доменов в TOP-10: ${t.all}; с ключом: ${t.hits}; маленьких сайтов в таблице: ${t.small}; кластеров: ${t.clusters}`}>
                  <span className="font-mono">.{t.tld}</span>
                  <span className={`ml-1.5 text-[11px] ${on ? "opacity-80" : "text-muted"}`}>{t.hits ? `с ключом ${t.hits} · ` : ""}в выдаче {t.all}{t.small ? ` · мал. ${t.small}` : ""}</span>
                </button>
              );
            })}
          </div>
        ) : <p className="help">Новых зон в выдаче нет — можно вписать свои.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <input className="input !w-auto min-w-[220px]" placeholder="Свои зоны: app, io, bet" value={own} onChange={(e) => setOwn(e.target.value)} />
          <button type="button" className="btn-primary" disabled={busy || !zones.length} onClick={() => go()}>{busy ? "Ставлю в очередь…" : `Проверить ${zones.length ? zones.map((z) => `.${z}`).join(", ") : "зоны"}`}</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="text-[13px]">Прямое вхождение: тема, ключи таблицы и найденные ключи точно — в региональных зонах страны и в</span>
          <input className="input !w-auto min-w-[120px]" value={exactOwn} onChange={(e) => setExactOwn(e.target.value)} placeholder="io, co" />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => go(true)}>Дополнить</button>
          <span className="help w-full">Уже проверенные домены не повторяются; новые — во вкладках «Регион. зоны» и «Прямое .io/.co». .fr не проверяем.</span>
        </div>
        {done.length > 0 && <p className="help">Уже добавлены второй пачкой: {done.map((z) => `.${z}`).join(", ")}</p>}
        {msg?.ok && <Alert tone="ok">{msg.ok}. Страница обновится сама.</Alert>}
        {msg?.error && <Alert tone="danger">{msg.error}</Alert>}
      </div>
    </Card>
  );
}
