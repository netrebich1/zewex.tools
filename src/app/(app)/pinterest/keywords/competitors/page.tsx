import { requireKeywords } from "@/lib/keywords/access";
import { competitors } from "@/lib/keywords/competitors";
import { NICHES } from "@/lib/keywords/types";
import { Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { KeywordsNav } from "@/components/keywords/KeywordsNav";
import { SearchBox } from "@/components/analytics/SearchBox";
import { ParamSelect } from "@/components/analytics/ParamSelect";

export const dynamic = "force-dynamic";

const PER_PAGE = 100;
const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("ru-RU"));
const P = ({ p }: { p: number }) => <span className="text-muted font-normal"> · {p}%</span>;

/** Конкуренты: сайты, которые держат топ-10 по многим ключам (как competitors.py прототипа). */
export default async function CompetitorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireKeywords();
  const q = await searchParams;
  const niche = sp(q, "niche") || "";
  // По умолчанию — только блоги: платформы и магазины (Instagram, Amazon…) владельцу не конкуренты.
  const kindParam = sp(q, "kind") || "";
  const kind = kindParam === "all" ? "" : kindParam || "site";
  const search = sp(q, "q") || "";
  const all = sp(q, "all") === "1";
  const { total, rows } = await competitors({ niche, kind, q: search });
  const shown = all ? rows : rows.slice(0, PER_PAGE);
  const qs = new URLSearchParams(Object.entries({ niche, kind, q: search }).filter(([, v]) => v) as Array<[string, string]>);
  return (
    <>
      <PageHeader
        title="Конкуренты"
        subtitle={`Сайты, чьи пины стоят в топ-10 выдачи по двум и более ключам. Считается по последнему снимку каждого ключа (${fmt(total)} ключей со снятой выдачей). Возраст статей — по датам публикации, которые проверил воркер.`}
        actions={<a href={`/api/keywords/export?format=competitors&${qs}`} className="btn-ghost btn-sm">CSV</a>}
      />
      <KeywordsNav />
      {!total ? (
        <Empty title="Выдача ещё не снята" hint="Конкуренты считаются по снимкам выдачи. Загрузите стартовые данные или запустите сбор на вкладке «Сбор»." />
      ) : (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchBox placeholder="Поиск по домену" className="w-60" />
            <ParamSelect param="niche" allLabel="Все ниши" options={NICHES.map((n) => ({ value: n.key, label: n.label }))} />
            <ParamSelect param="kind" allLabel="Только блоги" options={[{ value: "all", label: "Блоги и платформы" }, { value: "platform", label: "Только платформы/магазины" }]} />
            <span className="help ml-auto">Доменов: {fmt(rows.length)}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Домен</th><th className="text-right">В топ-10 ключей</th><th className="text-right">Пинов в топ-10</th><th className="text-right">Ср. позиция</th>
                  <th className="text-right">Частотность их ключей</th>{NICHES.map((n) => <th key={n.key} className="text-right">{n.label}</th>)}
                  <th className="text-right">Медиана сохранений</th><th className="text-right">Статьи, мес: свежая / ср / старая</th><th className="text-right">С датой</th><th>Примеры ключей</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.host} className="align-top">
                    <td className="whitespace-nowrap">
                      <a href={`https://${r.host}`} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">{r.host}</a>
                      <span className="help block">{r.kind === "platform" ? "платформа/магазин" : "сайт/блог"}</span>
                    </td>
                    <td className="text-right tabular-nums font-semibold whitespace-nowrap">{r.kws}<P p={r.kwsPct} /></td>
                    <td className="text-right tabular-nums">{r.pins}</td>
                    <td className="text-right tabular-nums">{r.avgPos}</td>
                    <td className="text-right tabular-nums">{fmt(r.vol)}</td>
                    {NICHES.map((n) => <td key={n.key} className="text-right tabular-nums whitespace-nowrap">{r.niches[n.key] ? <>{r.niches[n.key]}<P p={Math.round((100 * r.niches[n.key]) / r.kws)} /></> : <span className="text-muted">—</span>}</td>)}
                    <td className="text-right tabular-nums">{fmt(r.medSaves)}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{r.ageAvg != null ? `${r.ageNewest} / ${r.ageAvg} / ${r.ageOldest}` : "—"}</td>
                    <td className="text-right tabular-nums whitespace-nowrap">{r.dated}<P p={r.datedPct} /></td>
                    <td className="text-[12.5px] text-ink-2 min-w-[260px]">{r.examples.join("; ")}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={10 + NICHES.length} className="text-center text-muted py-10">Под эти фильтры доменов нет</td></tr>}
              </tbody>
            </table>
          </div>
          {!all && rows.length > PER_PAGE && <div className="mt-3 text-[13px]"><a href={`?${new URLSearchParams([...qs, ["all", "1"]])}`} className="btn-ghost btn-sm">Показать все {fmt(rows.length)}</a></div>}
        </Card>
      )}
    </>
  );
}
