"use client";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Field } from "@/components/ui";
import { launchDomainRun } from "@/actions/domains";
import { candidatesPerBrand, cleanSuffix, parseList } from "@/lib/domains/generator";
import { countValues, domainsOfBrand, suffixesOf, tldOf } from "@/lib/domains/mining";
import type { DfsCountry, DomainRunSettings, MinedSuffix, SerpSnapshot } from "@/lib/domains/types";

type SuffixRow = MinedSuffix & { geo: boolean; tier: number };
type Analysis = { snapshot: SerpSnapshot; suffixes: SuffixRow[]; failed: Array<{ query: string; error: string }>; allDomains: string[]; queries: string | null };

const TIER_HINTS = [
  "Перебираются первыми: гео и самые важные приставки (nl, nederland, eu).",
  "Второй круг: тематика (casino, play, bet).",
  "Если не хватило: общие слова (app, online, 365).",
];

/** Форма нового подбора с панелью анализа выдачи Google (приставки и зоны конкурентов). */
export function NewDomainRunForm({ defaults, countries, initialName }: { defaults: DomainRunSettings; countries: DfsCountry[]; initialName?: string }) {
  const [brands, setBrands] = useState(defaults.brands.join("\n"));
  const [tlds, setTlds] = useState(defaults.tlds.join(", "));
  const [tiers, setTiers] = useState<[string, string, string]>([defaults.suffixTiers[0].join(", "), defaults.suffixTiers[1].join(", "), defaults.suffixTiers[2].join(", ")]);
  const [allowHyphen, setAllowHyphen] = useState(defaults.allowHyphen);
  const [perBrand, setPerBrand] = useState(defaults.perBrand);
  const [country, setCountry] = useState(defaults.countryCode);
  const [keyword, setKeyword] = useState(defaults.serpKeyword);
  const [analysis, setAnalysis] = useState<Analysis | null>(defaults.serp ? { snapshot: defaults.serp, suffixes: defaults.minedSuffixes.map((m) => ({ ...m, geo: false, tier: 2 })), failed: [], allDomains: defaults.serp.domains, queries: null } : null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, { on: boolean; tier: number }>>({});
  const [view, setView] = useState<"tlds" | "suffixes">("suffixes");
  const [brandTab, setBrandTab] = useState<string>("__all");

  const brandList = useMemo(() => parseList(brands), [brands]);
  const tldList = useMemo(() => parseList(tlds), [tlds]);
  const tierLists = useMemo(() => tiers.map((t) => parseList(t).map(cleanSuffix).filter(Boolean)), [tiers]);
  const multiWord = brandList.some((b) => /[\s-]/.test(b.trim()));
  const perBrandCandidates = candidatesPerBrand(tierLists, tldList.length, allowHyphen, multiWord);

  async function analyze() {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/domains/serp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brands, countryCode: country, keyword }) });
      const data = (await res.json()) as Analysis & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAnalysis(data);
      const init: Record<string, { on: boolean; tier: number }> = {};
      for (const s of data.suffixes) init[s.suffix] = { on: s.geo, tier: s.tier };
      setPicked(init);
      setBrandTab("__all");
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  function applyPicked() {
    const next: [string, string, string] = [...tiers] as [string, string, string];
    const existing = new Set(tierLists.flat());
    let added = 0;
    for (const [suffix, p] of Object.entries(picked)) {
      if (!p.on || p.tier < 1 || p.tier > 3 || existing.has(suffix)) continue;
      const i = p.tier - 1;
      next[i] = next[i] ? `${next[i]}, ${suffix}` : suffix;
      existing.add(suffix);
      added++;
    }
    setTiers(next);
    setPicked((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, on: false }])));
    if (added === 0) setAnalysisError("Нечего добавить: отметьте приставки галочками или они уже есть в уровнях.");
    else setAnalysisError(null);
  }

  const analysisDomains = analysis ? (brandTab === "__all" ? analysis.snapshot.domains : domainsOfBrand(analysis.snapshot.domains, brandTab)) : [];
  const analysisRows = analysis
    ? view === "tlds"
      ? countValues(analysisDomains.map((d) => [tldOf(d)]))
      : countValues(analysisDomains.map((d) => suffixesOf(d, brandList)))
    : [];
  const brandsWithDomains = analysis ? brandList.filter((b) => domainsOfBrand(analysis.snapshot.domains, b).length > 0) : [];

  return (
    <ActionForm action={launchDomainRun} className="space-y-5" hidden={{ minedSuffixes: JSON.stringify(analysis?.suffixes.map(({ suffix, count, examples }) => ({ suffix, count, examples })) ?? []), serp: analysis ? JSON.stringify(analysis.snapshot) : "" }}>
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card title="1. Бренды и зоны" description="Бренды — по одному в строке (латиницей, можно из двух слов). Зоны — через запятую, в порядке важности.">
            <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
              <Field label={`Бренды${brandList.length ? ` · ${brandList.length}` : ""}`}>
                <textarea name="brands" className="input font-mono text-[13.5px]" rows={10} value={brands} onChange={(e) => setBrands(e.target.value)} placeholder={"winplace\nlucky spins\nbetcity"} required />
              </Field>
              <div className="space-y-4">
                <Field label="Доменные зоны" hint="Например: com, nl, net, eu">
                  <input name="tlds" className="input" value={tlds} onChange={(e) => setTlds(e.target.value)} required />
                </Field>
                <Field label="Название подбора" hint="Необязательно; по умолчанию дата и время">
                  <input name="name" className="input" defaultValue={initialName ?? ""} placeholder="Нидерланды, октябрь" />
                </Field>
              </div>
            </div>
          </Card>

          <Card title="2. Приставки по уровням" description="Приставка ставится только после бренда: brand+nl, brand-nl, brand-split-nl. Сначала полностью перебирается уровень 1, затем 2, затем 3.">
            <div className="grid gap-4 sm:grid-cols-3">
              {tiers.map((value, i) => (
                <Field key={i} label={`Уровень ${i + 1}${tierLists[i]?.length ? ` · ${tierLists[i].length}` : ""}`} hint={TIER_HINTS[i]}>
                  <textarea name={`tier${i + 1}`} className="input font-mono text-[13.5px]" rows={5} value={value} onChange={(e) => setTiers((prev) => { const n = [...prev] as [string, string, string]; n[i] = e.target.value; return n; })} placeholder="через запятую или по строке" />
                </Field>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Доменов на бренд" hint="Сколько свободных нужно найти">
                <input name="perBrand" type="number" min={1} max={100} className="input" value={perBrand} onChange={(e) => setPerBrand(Number(e.target.value) || 1)} />
              </Field>
              <Field label="Запас на бренд" hint="Дополнительные свободные на замену при выгрузке">
                <input name="extraPerBrand" type="number" min={0} max={100} className="input" defaultValue={defaults.extraPerBrand} />
              </Field>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="allowHyphen" className="h-4 w-4" checked={allowHyphen} onChange={(e) => setAllowHyphen(e.target.checked)} /> Разрешить дефис</label>
              </div>
            </div>
            <p className="help mt-3">
              На бренд получится до <b>{perBrandCandidates}</b> вариантов{brandList.length ? `, всего до ${perBrandCandidates * brandList.length}` : ""}. Проверка идёт по порядку приоритета и останавливается, как только набралось {perBrand} + запас свободных.
            </p>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="3. Регион и выдача Google" description="Страна нужна для анализа выдачи и для ИИ-отбора. Анализ необязателен.">
            <div className="space-y-4">
              <Field label="Страна продвижения">
                <select name="countryCode" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {countries.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code.toUpperCase()})</option>)}
                </select>
              </Field>
              <Field label="Ключевое слово для выдачи" hint="Пусто — выдача снимается по каждому бренду (до 25). С ключом — один запрос.">
                <input name="serpKeyword" className="input" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="online casino" />
              </Field>
              <button type="button" className="btn-ghost w-full" onClick={analyze} disabled={analyzing || !brandList.length}>
                {analyzing ? "Снимаю TOP-10…" : analysis ? "Снять выдачу заново" : "Проанализировать выдачу"}
              </button>
              {analysisError && <Alert tone="danger">{analysisError}</Alert>}
              {analysis && (
                <div className="help">
                  Источник: {analysis.snapshot.provider === "dataforseo" ? "DataForSEO" : "SerpAPI"} · доменов с брендом: <b>{analysis.snapshot.domains.length}</b> из {analysis.allDomains.length} в выдаче
                  {analysis.queries && <> · {analysis.queries}</>}
                  {analysis.failed.length > 0 && <> · не снято запросов: {analysis.failed.length} ({analysis.failed[0]?.error})</>}
                </div>
              )}
            </div>
          </Card>

          <div className="card p-4 sm:p-5">
            <SubmitButton className="btn-brand w-full" pendingText="Ставлю в очередь…">Запустить подбор</SubmitButton>
            <p className="help mt-2">Проверка идёт в фоне, страницу можно закрывать. Результаты появятся в карточке подбора.</p>
          </div>
        </div>
      </div>

      {analysis && (
        <Card
          title="Приставки конкурентов из выдачи"
          description="Отметьте, какие приставки взять, и в какой уровень. Гео-приставки предлагаются в уровень 1."
          actions={<button type="button" className="btn-primary btn-sm" onClick={applyPicked}>Добавить отмеченные в уровни</button>}
        >
          {analysis.suffixes.length === 0 ? (
            <p className="help">В выдаче нет доменов с брендом — приставок не найдено.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {analysis.suffixes.map((s) => {
                const p = picked[s.suffix] ?? { on: false, tier: s.tier };
                const already = tierLists.flat().includes(s.suffix);
                return (
                  <div key={s.suffix} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${p.on ? "border-brand bg-brand-soft/40" : "border-line"}`}>
                    <input type="checkbox" className="h-4 w-4" checked={p.on} disabled={already} onChange={(e) => setPicked((prev) => ({ ...prev, [s.suffix]: { ...p, on: e.target.checked } }))} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[13.5px] font-semibold">{s.suffix}</span>
                        {s.geo && <Badge tone="brand">гео</Badge>}
                        {already && <Badge tone="ok">уже в уровнях</Badge>}
                      </div>
                      <div className="help truncate" title={s.examples.join(", ")}>{s.count} × · {s.examples.join(", ")}</div>
                    </div>
                    <select className="input !w-auto !py-1 !px-2 !pr-7 text-[13px]" value={p.tier} onChange={(e) => setPicked((prev) => ({ ...prev, [s.suffix]: { on: p.on, tier: Number(e.target.value) } }))}>
                      <option value={1}>уровень 1</option>
                      <option value={2}>уровень 2</option>
                      <option value={3}>уровень 3</option>
                      <option value={0}>пропустить</option>
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="flex gap-1.5 flex-wrap">
                <button type="button" className={`tab ${brandTab === "__all" ? "active" : ""}`} onClick={() => setBrandTab("__all")}>Все</button>
                {brandsWithDomains.map((b) => <button key={b} type="button" className={`tab ${brandTab === b ? "active" : ""}`} onClick={() => setBrandTab(b)}>{b}</button>)}
              </div>
              <div className="ml-auto flex gap-1.5">
                <button type="button" className={`tab ${view === "tlds" ? "active" : ""}`} onClick={() => setView("tlds")}>Доменные зоны</button>
                <button type="button" className={`tab ${view === "suffixes" ? "active" : ""}`} onClick={() => setView("suffixes")}>Приставки</button>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>{view === "tlds" ? "Зона" : "Приставка"}</th><th>Доменов</th><th>%</th></tr></thead>
                  <tbody>
                    {analysisRows.slice(0, 40).map((r) => (
                      <tr key={r.value}><td className="font-mono">{r.value}</td><td>{r.count}</td><td className="help">{analysisDomains.length ? Math.round((r.count / analysisDomains.length) * 100) : 0}%</td></tr>
                    ))}
                    {analysisRows.length === 0 && <tr><td colSpan={3} className="help">Нет данных</td></tr>}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="label">Домены выдачи с брендом · {analysisDomains.length}</div>
                <div className="max-h-72 overflow-auto rounded-xl border border-line p-2 font-mono text-[13px] leading-6">
                  {analysisDomains.map((d) => <div key={d}>{d}</div>)}
                  {analysisDomains.length === 0 && <span className="help">—</span>}
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
    </ActionForm>
  );
}
