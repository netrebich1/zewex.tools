"use client";
import { useEffect, useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Field } from "@/components/ui";
import { launchDomainRun } from "@/actions/domains";
import { brandLine, brandTiers, brandTlds, buildCandidatesForBrand, cleanSuffix, modifierPool, normalizeTld, parseBatchBrands, parseBrandLines, parseList, parseZones, type PlanSettings } from "@/lib/domains/generator";
import { countValues, domainsOfBrand, suffixesOf, tldOf } from "@/lib/domains/mining";
import { countryByCode } from "@/lib/domains/countries";
import { defaultCountryPreset } from "@/lib/domains/presets";
import { itemKey, LETTER_MODE_LABELS, LIMITS, PATTERN_LABELS, type BrandItem, type CountryPreset, type DomainRunSettings, type LetterMode, type MinedSuffix, type SerpSnapshot } from "@/lib/domains/types";
import { CountryPicker } from "./CountryPicker";
import { CountryPresetsPanel, draftFromPreset, presetFromDraft, type PresetDraft } from "./CountryPresetsPanel";
import { BrandResearchPanel, entryFromSaved, entryModifiers, entryResearch, type ResearchEntry } from "./BrandResearchPanel";

type SuffixRow = MinedSuffix & { geo: boolean; tier: number };
type Analysis = { snapshot: SerpSnapshot; suffixes: SuffixRow[]; failed: Array<{ query: string; error: string }>; allDomains: string[]; queries: string | null };

const TIER_HINTS = [
  "Перебираются первыми вместе с гео-набором страны.",
  "Второй круг: тематика (casino, play). Бренду со словом casino эти слова не добавляются — только casino → casinos.",
  "Если не хватило: общие слова (app, online, 365).",
];

/** Поле «Бренды» из сохранённых брендов: строки «бренд ; FR». */
const brandsText = (items: BrandItem[]) => items.map((it) => brandLine(it.brand, it.country, it.tlds ?? [])).join("\n");

/** Форма нового подбора: пачка брендов с разными странами, наборы стран, ключи брендов, анализ выдачи, превью доменов. */
export function NewDomainRunForm({ defaults, initialName, savedPresets }: { defaults: DomainRunSettings; initialName?: string; savedPresets: Record<string, CountryPreset> }) {
  const [country, setCountry] = useState(defaults.countryCode);
  const [brands, setBrands] = useState(() => brandsText(defaults.items));
  const [batch, setBatch] = useState("");
  const [batchZones, setBatchZones] = useState("");
  const [batchMsg, setBatchMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [tlds, setTlds] = useState(defaults.tlds.join(", "));
  const [tiers, setTiers] = useState<[string, string, string]>([defaults.suffixTiers[0].join(", "), defaults.suffixTiers[1].join(", "), defaults.suffixTiers[2].join(", ")]);
  const [allowHyphen, setAllowHyphen] = useState(defaults.allowHyphen);
  const [perBrand, setPerBrand] = useState(defaults.perBrand);
  const [letterMode, setLetterMode] = useState<LetterMode>(defaults.letterMode);
  const [usePool, setUsePool] = useState(defaults.usePool);
  const [autoResearch, setAutoResearch] = useState(defaults.autoResearch);
  const [checkAll, setCheckAll] = useState(defaults.checkAll);
  const [autoZones, setAutoZones] = useState(defaults.autoZones);
  const [keyword, setKeyword] = useState(defaults.serpKeyword);
  const [saved, setSaved] = useState<Set<string>>(() => new Set(Object.keys(savedPresets)));
  const [savedMap, setSavedMap] = useState(savedPresets);
  const [drafts, setDrafts] = useState<Record<string, PresetDraft>>(() => {
    const out: Record<string, PresetDraft> = {};
    for (const it of defaults.items) out[it.country] ??= draftFromPreset(defaults.countryPresets[it.country] ?? savedPresets[it.country] ?? defaultCountryPreset(it.country));
    return out;
  });
  const [entries, setEntries] = useState<Record<string, ResearchEntry>>(() => Object.fromEntries(defaults.items.filter((it) => it.modifiers.length).map((it) => [itemKey(it.brand, it.country), entryFromSaved(it.brand, it.country, it.modifiers)])));
  const [analysis, setAnalysis] = useState<Analysis | null>(defaults.serp ? { snapshot: defaults.serp, suffixes: defaults.minedSuffixes.map((m) => ({ ...m, geo: false, tier: 2 })), failed: [], allDomains: defaults.serp.domains, queries: null } : null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, { on: boolean; tier: number }>>({});
  const [view, setView] = useState<"tlds" | "suffixes">("suffixes");
  const [brandTab, setBrandTab] = useState<string>("__all");
  const [previewKey, setPreviewKey] = useState<string>("");

  const parsed = useMemo(() => parseBrandLines(brands), [brands]);
  const countries = useMemo(() => Array.from(new Set(parsed.items.map((it) => it.country))), [parsed]);
  const brandList = useMemo(() => parsed.items.map((it) => it.brand), [parsed]);
  const tierLists = useMemo(() => tiers.map((t) => parseList(t).map(cleanSuffix).filter(Boolean)), [tiers]);
  const tldList = useMemo(() => parseList(tlds).map(normalizeTld).filter(Boolean), [tlds]);

  // Новая страна в пачке — подставляем её сохранённый набор (или стандартный)
  useEffect(() => {
    const missing = countries.filter((c) => !drafts[c]);
    if (missing.length) setDrafts((prev) => ({ ...prev, ...Object.fromEntries(missing.map((c) => [c, draftFromPreset(savedMap[c] ?? defaultCountryPreset(c))])) }));
  }, [countries, drafts, savedMap]);

  // Итог сбора ключей прошлого подбора («Повторить») — чтобы в новой карточке было видно, откуда ключи
  const savedResearch = useMemo(() => new Map(defaults.items.filter((it) => it.research).map((it) => [itemKey(it.brand, it.country), it.research!])), [defaults.items]);
  const items: BrandItem[] = useMemo(() => parsed.items.map((it) => {
    const key = itemKey(it.brand, it.country);
    const research = entryResearch(entries[key]) ?? savedResearch.get(key);
    return { ...it, modifiers: entryModifiers(entries[key]), ...(research ? { research } : {}) };
  }), [parsed, entries, savedResearch]);
  const presets = useMemo(() => Object.fromEntries(countries.filter((c) => drafts[c]).map((c) => [c, presetFromDraft(c, drafts[c]!)])), [countries, drafts]);
  const plan: PlanSettings = { suffixTiers: tierLists, tlds: tldList, countryPresets: presets, usePool, autoZones };
  const pool = useMemo(() => (usePool ? modifierPool(items) : undefined), [items, usePool]);

  // Превью: какие уровни и домены получит бренд (по порядку проверки)
  const previewItem = items.find((it) => itemKey(it.brand, it.country) === previewKey) ?? items[0];
  const preview = useMemo(() => {
    if (!previewItem) return null;
    const t = brandTiers(previewItem, plan, pool);
    const zones = brandTlds(previewItem, plan);
    const list = buildCandidatesForBrand(previewItem.brand, t, zones, { allowHyphen, letterMode });
    return { tiers: t, zones, list };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewItem, JSON.stringify(plan), pool, allowHyphen, letterMode]);

  async function analyze() {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/domains/serp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brands, keyword }) });
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

  /** Пачка брендов одной страны → строки «бренд ; КОД» в конец общего списка (без повторов). */
  function addBatch() {
    const names = parseBatchBrands(batch);
    const c = countryByCode(country);
    if (!c) return setBatchMsg({ tone: "warn", text: "Выберите страну пачки." });
    if (!names.length) return setBatchMsg({ tone: "warn", text: "Вставьте бренды пачки — по одному в строке." });
    const zones = parseZones(batchZones);
    if (zones.bad.length) return setBatchMsg({ tone: "warn", text: `Не похоже на доменную зону: ${zones.bad.join(", ")}` });
    const have = new Set(parsed.items.map((it) => itemKey(it.brand.toLowerCase(), it.country)));
    const fresh = names.filter((b) => !have.has(itemKey(b.toLowerCase(), c.code)));
    if (fresh.length) setBrands((prev) => [prev.trimEnd(), ...fresh.map((b) => brandLine(b, c.code, zones.tlds))].filter(Boolean).join("\n"));
    setBatch("");
    const skipped = names.length - fresh.length;
    setBatchMsg({ tone: fresh.length ? "ok" : "warn", text: `${c.name} (${c.code.toUpperCase()}): добавлено ${fresh.length}${skipped ? `, уже были в списке: ${skipped}` : ""}.` });
  }

  const addCommonTld = (tld: string) => setTlds((prev) => (parseList(prev).includes(tld) ? prev : prev.trim() ? `${prev}, ${tld}` : tld));
  const addCountryTld = (tld: string, code: string) =>
    setDrafts((prev) => {
      const d = prev[code];
      if (!d || parseList(d.tlds).includes(tld)) return prev;
      return { ...prev, [code]: { ...d, tlds: d.tlds.trim() ? `${d.tlds}, ${tld}` : tld } };
    });

  const analysisDomains = analysis ? (brandTab === "__all" ? analysis.snapshot.domains : domainsOfBrand(analysis.snapshot.domains, brandTab)) : [];
  const analysisRows = analysis ? (view === "tlds" ? countValues(analysisDomains.map((d) => [tldOf(d)])) : countValues(analysisDomains.map((d) => suffixesOf(d, brandList)))) : [];
  const brandsWithDomains = analysis ? Array.from(new Set(brandList)).filter((b) => domainsOfBrand(analysis.snapshot.domains, b).length > 0) : [];
  const byCountry = countries.map((c) => ({ c, n: parsed.items.filter((it) => it.country === c).length }));
  const multi = countries.length > 1;

  return (
    <ActionForm
      action={launchDomainRun}
      className="space-y-5"
      hidden={{
        minedSuffixes: JSON.stringify(analysis?.suffixes.map(({ suffix, count, examples }) => ({ suffix, count, examples })) ?? []),
        serp: analysis ? JSON.stringify(analysis.snapshot) : "",
        items: JSON.stringify(items),
        countryPresets: JSON.stringify(presets),
      }}
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card title="1. Бренды, страны и зоны" description="Одна строка — бренд и код страны через точку с запятой: «winzoria ; FR». Код страны — две латинские буквы (FR, NL, DE, ES). Третьей колонкой можно дать зоны бренда: «lucky hills ; CA ; bet, ca» — они добавятся к общим без повторов. Гео-приставки страны система подставит сама.">
            <div className="grid gap-4 sm:grid-cols-[1fr_260px]">
              <Field label={`Бренды${parsed.items.length ? ` · ${parsed.items.length}` : ""}`} hint="Список можно править: удалить строку, поменять код страны.">
                <textarea name="brands" className="input font-mono text-[13.5px]" rows={14} value={brands} onChange={(e) => setBrands(e.target.value)} placeholder={"winzoria ; FR\nalibaba casino ; FR ; fr, org\njackpot raider ; GB ; uk, co.uk"} required />
              </Field>
              <div className="space-y-4">
                <div className="rounded-xl border border-line p-3">
                  <div className="mb-2 text-[14px] font-semibold">Добавить пачку по стране</div>
                  <div className="space-y-2">
                    <CountryPicker value={country} onChange={setCountry} label="Страна пачки" />
                    <textarea className="input font-mono text-[13.5px]" rows={5} value={batch} onChange={(e) => setBatch(e.target.value)} placeholder={"winzoria\nalibaba casino"} aria-label="Бренды пачки" />
                    <input className="input font-mono text-[13.5px]" value={batchZones} onChange={(e) => setBatchZones(e.target.value)} placeholder="зоны пачки: fr, org (необязательно)" aria-label="Зоны пачки" />
                    <button type="button" className="btn-ghost w-full" onClick={addBatch}>Добавить</button>
                    {batchMsg ? <p className={`help ${batchMsg.tone === "warn" ? "text-warn" : ""}`}>{batchMsg.text}</p> : <p className="help">Бренды по одному в строке — в список они попадут с кодом выбранной страны.</p>}
                  </div>
                </div>
                <Field label="Общие зоны" hint="Для всех брендов; зоны отдельной страны — в её наборе">
                  <input name="tlds" className="input" value={tlds} onChange={(e) => setTlds(e.target.value)} required />
                </Field>
                <Field label="Название подбора" hint="Необязательно; по умолчанию дата и время">
                  <input name="name" className="input" defaultValue={initialName ?? ""} placeholder="NL + ES, октябрь" />
                </Field>
              </div>
            </div>
            {byCountry.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="help">По странам:</span>
                {byCountry.map(({ c, n }) => <Badge key={c} tone="brand">{countryByCode(c)?.name ?? c.toUpperCase()} ({c.toUpperCase()}) · {n}</Badge>)}
              </div>
            )}
            {parsed.problems.length > 0 && <div className="mt-3"><Alert tone="warn">Исправьте строки — нужен формат «бренд ; FR», иначе подбор не запустится:{parsed.problems.slice(0, 5).join(" · ")}{parsed.problems.length > 5 ? ` · и ещё ${parsed.problems.length - 5}` : ""}</Alert></div>}
          </Card>

          <CountryPresetsPanel
            countries={countries}
            drafts={drafts}
            saved={saved}
            onChange={(code, d) => setDrafts((prev) => ({ ...prev, [code]: d }))}
            onSaved={(code, preset, isSaved) => {
              setDrafts((prev) => ({ ...prev, [code]: draftFromPreset(preset) }));
              setSaved((prev) => { const n = new Set(prev); if (isSaved) n.add(code); else n.delete(code); return n; });
              setSavedMap((prev) => { const n = { ...prev }; if (isSaved) n[code] = preset; else delete n[code]; return n; });
            }}
          />

          <Card title="3. Общие приставки и правила" description="Приставка ставится только после бренда: brand+nl, brand-nl. У каждого бренда уровень = набор страны + общие приставки + его ключевые слова. Сначала полностью перебирается уровень 1, затем 2, 3, затем запас 4–6.">
            <div className="grid gap-4 sm:grid-cols-3">
              {tiers.map((value, i) => (
                <Field key={i} label={`Уровень ${i + 1}${tierLists[i]?.length ? ` · ${tierLists[i].length}` : ""}`} hint={TIER_HINTS[i]}>
                  <textarea name={`tier${i + 1}`} className="input font-mono text-[13.5px]" rows={4} value={value} onChange={(e) => setTiers((prev) => { const n = [...prev] as [string, string, string]; n[i] = e.target.value; return n; })} placeholder="через запятую или по строке" />
                </Field>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Доменов на бренд" hint="Сколько свободных нужно минимум; меньше — бренд помечается «мало». Без «все варианты» — проверка останавливается на этом числе + запас">
                <input name="perBrand" type="number" min={1} max={100} className="input" value={perBrand} onChange={(e) => setPerBrand(Number(e.target.value) || 1)} />
              </Field>
              <Field label="Запас на бренд" hint="Дополнительные свободные на замену при выгрузке">
                <input name="extraPerBrand" type="number" min={0} max={100} className="input" defaultValue={defaults.extraPerBrand} />
              </Field>
              <Field label="Бренд + одна буква" hint="winzoria → winzorria, winzorias. Только отличительное слово бренда, не casino">
                <select name="letterMode" className="input" value={letterMode} onChange={(e) => setLetterMode(e.target.value as LetterMode)}>
                  {(Object.keys(LETTER_MODE_LABELS) as LetterMode[]).map((m) => <option key={m} value={m}>{LETTER_MODE_LABELS[m]}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="allowHyphen" className="h-4 w-4" checked={allowHyphen} onChange={(e) => setAllowHyphen(e.target.checked)} /> Разрешить дефис</label>
              <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="usePool" className="h-4 w-4" checked={usePool} onChange={(e) => setUsePool(e.target.checked)} /> Запас: ключевые слова других брендов страны как уровни 4–6</label>
            </div>
            {letterMode !== "off" && (
              <p className="help mt-2 text-warn">Домены «бренд + буква» владельцы брендов оспаривают чаще всего (UDRP считает разницу в одну букву «сходством до смешения»), а Chrome может показывать на них предупреждение «Возможно, вы имели в виду…». В результатах они помечены «буква».</p>
            )}
          </Card>

          <BrandResearchPanel items={parsed.items} entries={entries} setEntries={setEntries} onAddTld={addCountryTld} />

          {preview && previewItem && (
            <Card
              title="Превью: что будет проверяться"
              description="Порядок проверки для выбранного бренда. Проверка остановится, как только наберётся нужное число свободных."
              actions={
                items.length > 1 ? (
                  <select className="input !w-auto !py-1.5 text-[13px]" value={itemKey(previewItem.brand, previewItem.country)} onChange={(e) => setPreviewKey(e.target.value)}>
                    {items.map((it) => <option key={itemKey(it.brand, it.country)} value={itemKey(it.brand, it.country)}>{multi ? `${it.brand} · ${it.country.toUpperCase()}` : it.brand}</option>)}
                  </select>
                ) : undefined
              }
            >
              <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
                <div className="space-y-1 text-[13.5px]">
                  {preview.tiers.map((t, i) => (t.length ? <div key={i}><span className="label inline">Уровень {i + 1}{i >= 3 ? " (запас)" : ""}:</span> <span className="font-mono">{t.join(", ")}</span></div> : null))}
                  <div><span className="label inline">Зоны:</span> <span className="font-mono">{preview.zones.join(", ") || "—"}</span></div>
                  <div className="help">Всего вариантов: <b>{preview.list.length}</b></div>
                </div>
                <div className="max-h-72 overflow-auto rounded-xl border border-line p-2 font-mono text-[13px] leading-6">
                  {preview.list.slice(0, 80).map((c) => (
                    <div key={c.domain} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{c.domain}</span><span className="help shrink-0">{c.tier > 0 ? `ур. ${c.tier}` : PATTERN_LABELS[c.pattern]}</span></div>
                  ))}
                  {preview.list.length > 80 && <div className="help">… и ещё {preview.list.length - 80}</div>}
                </div>
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Выдача Google (необязательно)" description="TOP-10 по каждому бренду в его стране: какие приставки и зоны используют конкуренты.">
            <div className="space-y-4">
              <Field label="Ключевое слово для выдачи" hint="Пусто — по каждому бренду (до 50). С ключом — один запрос на страну.">
                <input name="serpKeyword" className="input" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="online casino" />
              </Field>
              <button type="button" className="btn-ghost w-full" onClick={analyze} disabled={analyzing || !parsed.items.length}>
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
            <div className="mb-3 text-[14px] font-semibold">Режим «максимум»</div>
            {([
              ["autoResearch", autoResearch, setAutoResearch, "Собрать ключи и выдачу Google перед проверкой", "Для каждого бренда без ключей: запросы с частотой, подсказки Google, TOP-10 и домены конкурентов (DataForSEO), фильтр ИИ. ~$0.02–0.04 на бренд."],
              ["checkAll", checkAll, setCheckAll, "Проверять все варианты", `Гео, ключи, ваши приставки, все уровни и зоны — до ${LIMITS.checkAllMax} доменов на бренд. Без галочки проверка бренда останавливается, когда набралось «доменов на бренд» + запас.`],
              ["autoZones", autoZones, setAutoZones, "Добавлять зоны из анализа", "Зона страны (.fr, .nl, .uk) и до 6 зон, на которых стоят домены конкурентов в TOP-10."],
            ] as const).map(([name, value, set, title, hint]) => (
              <label key={name} className="mb-3 flex items-start gap-2 text-[14px]">
                <input type="hidden" name={name} value={value ? "on" : "off"} />
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={value} onChange={(e) => set(e.target.checked)} />
                <span>{title}<span className="help block">{hint}</span></span>
              </label>
            ))}
            <p className="help mb-3">В карточке подбора у каждого домена видно, откуда приставка и зона; домены бренда можно фильтровать по источнику, уровню и зоне.</p>
            <SubmitButton className="btn-brand w-full" pendingText="Ставлю в очередь…">Запустить подбор</SubmitButton>
            <p className="help mt-2">Проверка идёт в фоне, страницу можно закрывать. Результаты появятся в карточке подбора.</p>
          </div>
        </div>
      </div>

      {analysis && (
        <Card
          title="Приставки конкурентов из выдачи"
          description="Отметьте, какие приставки взять, и в какой общий уровень. Гео-приставки предлагаются в уровень 1."
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
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1.5">
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
                  <thead><tr><th>{view === "tlds" ? "Зона" : "Приставка"}</th><th>Доменов</th><th>%</th>{view === "tlds" && <th></th>}</tr></thead>
                  <tbody>
                    {analysisRows.slice(0, 40).map((r) => (
                      <tr key={r.value}>
                        <td className="font-mono">{r.value}</td>
                        <td>{r.count}</td>
                        <td className="help">{analysisDomains.length ? Math.round((r.count / analysisDomains.length) * 100) : 0}%</td>
                        {view === "tlds" && (
                          <td className="text-right">
                            {tldList.includes(r.value) ? <span className="help">в общих</span> : <button type="button" className="btn-ghost btn-sm !px-2 !py-0.5 text-[12.5px]" onClick={() => addCommonTld(r.value)}>+ в общие зоны</button>}
                          </td>
                        )}
                      </tr>
                    ))}
                    {analysisRows.length === 0 && <tr><td colSpan={4} className="help">Нет данных</td></tr>}
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
