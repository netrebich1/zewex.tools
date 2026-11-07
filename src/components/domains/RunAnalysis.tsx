"use client";
import { Badge, Card } from "@/components/ui";
import { brandTldEntries } from "@/lib/domains/generator";
import { itemKey, RESEARCH_SOURCE_LABELS, SUFFIX_SOURCE_TAGS, TLD_SOURCE_TAGS, type BrandItem, type DomainRunSettings, type SuffixSource, type SuffixSourceKind } from "@/lib/domains/types";

const KIND_TONE: Record<SuffixSourceKind, string> = {
  geo: "bg-brand-soft text-brand",
  brand: "bg-ok-soft text-ok",
  common: "bg-ink/5 text-muted",
  pool: "bg-warn-soft text-warn",
};

/** 1320 → 1.3k, 50 → 50 */
const fmtVolume = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Метка источника приставки: «гео 1», «ключ 2», «общая 3», «запас 4». Подробности — в подсказке. */
export function SourceTag({ source, suffix }: { source: SuffixSource | undefined; suffix: string | null }) {
  if (!source) return null;
  return (
    <span className={`shrink-0 rounded-md px-1.5 text-[11px] ${KIND_TONE[source.kind]}`} title={`${suffix ?? ""}: ${source.detail} · уровень ${source.tier}`}>
      {SUFFIX_SOURCE_TAGS[source.kind]} {source.tier}
      {source.volume ? <b className="ml-1 tabular-nums" title="частота в месяц">{fmtVolume(source.volume)}</b> : null}
    </span>
  );
}

function ResearchState({ it, auto }: { it: BrandItem; auto: boolean }) {
  const r = it.research;
  if (r) {
    const failed = r.errors.length > 0 && r.queries === 0;
    return <Badge tone={failed ? "danger" : "ok"}>{failed ? "не собралось" : r.origin === "form" ? "собрано в форме" : "собрано подбором"}</Badge>;
  }
  if (it.modifiers.length) return <Badge>ключи из прошлого подбора</Badge>;
  return <Badge tone={auto ? "brand" : "neutral"}>{auto ? "ждёт сбора" : "не собирали"}</Badge>;
}

/**
 * Что анализировали по каждому бренду и откуда приставки: ключи бренда (DataForSEO: запросы с частотой, подсказки Google,
 * похожие запросы, TOP-10 и домены конкурентов) с фильтром ИИ, гео-база страны, общие приставки формы и запас страны.
 */
export function RunAnalysis({ settings }: { settings: DomainRunSettings }) {
  const items = settings.items;
  const researched = items.filter((it) => it.research).length;
  const cost = items.reduce((a, it) => a + (it.research?.costUsd ?? 0), 0);
  return (
    <Card
      title="Анализ брендов: откуда приставки"
      description={
        settings.autoResearch || researched
          ? "По каждому бренду в его стране: запросы с брендом и частотой (DataForSEO), подсказки Google, похожие запросы и TOP-10 выдачи; из адресов конкурентов — их приставки и зоны. ИИ оставляет сильные аффилиатные слова, остальное отбрасывает с причиной. Метка у домена: гео — база страны, ключ — найдено по бренду, общая — приставки формы, запас — ключи других брендов страны; цифра — уровень."
          : "В этом подборе ключи брендов и выдачу Google не собирали: приставки взяты только из гео-базы страны и общих приставок формы. Включите «Собрать ключи и выдачу Google перед проверкой» в новом подборе."
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5 text-[12.5px]">
        <Badge tone="ok">собрано: {researched} из {items.length}</Badge>
        {cost > 0 && <Badge>расход ${cost.toFixed(3)}</Badge>}
        {(Object.keys(SUFFIX_SOURCE_TAGS) as SuffixSourceKind[]).map((k) => <span key={k} className={`rounded-md px-1.5 ${KIND_TONE[k]}`}>{SUFFIX_SOURCE_TAGS[k]}</span>)}
      </div>
      <div className="space-y-2">
        {items.map((it) => {
          const r = it.research;
          return (
            <details key={itemKey(it.brand, it.country)} className="rounded-xl border border-line">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[14px]">
                <b>{it.brand}</b>
                <span className="help uppercase">{it.country}</span>
                <ResearchState it={it} auto={settings.autoResearch} />
                <span className="help ml-auto">
                  {r ? `запросов ${r.queries} · взято ${it.modifiers.length} · отброшено ${r.rejected.length} · конкурентов в TOP-10 ${r.competitorDomains.length}` : it.modifiers.length ? `ключей ${it.modifiers.length}` : "—"}
                </span>
              </summary>
              <div className="grid gap-3 border-t border-line px-3 py-3 text-[13px] md:grid-cols-3">
                <div className="min-w-0">
                  <div className="label">Взяли в домены · {it.modifiers.length}</div>
                  {it.modifiers.length ? (
                    <ul className="space-y-1">
                      {it.modifiers.map((m) => (
                        <li key={m.suffix} title={[m.query ? `запрос «${m.query}»` : "", m.reason ? `ИИ: ${m.reason}` : ""].filter(Boolean).join(" · ")}>
                          <span className="font-mono font-semibold">{m.suffix}</span> <span className="help">ур. {m.tier}{m.volume ? ` · ${m.volume}/мес` : ""}{m.sources?.length ? ` · ${m.sources.map((s) => RESEARCH_SOURCE_LABELS[s]).join(", ")}` : ""}</span>
                          {m.reason && <div className="help truncate">{m.reason}</div>}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="help">Нет — бренд проверялся только с гео и общими приставками.</p>}
                </div>
                <div className="min-w-0">
                  <div className="label">Отбросили · {r?.rejected.length ?? 0}</div>
                  {r?.rejected.length ? (
                    <ul className="space-y-1">
                      {r.rejected.map((x) => (
                        <li key={x.suffix}><span className="font-mono">{x.word}</span>{x.volume ? <span className="help"> · {x.volume}/мес</span> : null}<div className="help truncate" title={x.reason}>{x.reason}</div></li>
                      ))}
                    </ul>
                  ) : <p className="help">—</p>}
                </div>
                <div className="min-w-0">
                  <div className="label">Конкуренты в TOP-10 · {r?.competitorDomains.length ?? 0}</div>
                  {r?.competitorDomains.length ? <div className="break-words font-mono leading-6">{r.competitorDomains.join(", ")}</div> : <p className="help">—</p>}
                  {r?.competitorTlds.length ? <p className="help mt-1">Зоны конкурентов: {r.competitorTlds.map((t) => `${t.value} · ${t.count}`).join(", ")}</p> : null}
                  <div className="label mt-2">Зоны бренда в подборе</div>
                  <div className="flex flex-wrap gap-1">
                    {brandTldEntries(it, settings).map((z) => <span key={z.tld} className="rounded-md bg-ink/5 px-1.5 text-[12px]" title={z.source.detail}><span className="font-mono">.{z.tld}</span> <span className="help">{TLD_SOURCE_TAGS[z.source.kind]}</span></span>)}
                  </div>
                  {r?.errors.length ? <p className="mt-1 text-[12.5px] text-danger">{r.errors.join(" · ")}</p> : null}
                  {r?.at && <p className="help mt-1">{r.origin === "form" ? "Собрано в форме" : "Собрано подбором"} {new Date(r.at).toLocaleString("ru-RU")}{r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : ""}</p>}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </Card>
  );
}
