import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ShowMoreRows } from "@/components/ui/ShowMore";
import { CompNav } from "@/components/competitors/CompNav";
import { canSee, countryOptions, loadState, parseFilter } from "@/lib/competitors/sites";
import { themeRows } from "@/lib/competitors/themes";
import { BASE_PATH } from "@/lib/competitors/types";

export const dynamic = "force-dynamic";

const num = (v: number) => v.toLocaleString("ru-RU");

export default async function CompetitorsThemes({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Анализ конкурентов» открыт команде WexOra." />;
  const q = await searchParams;
  const { settings } = await loadState();
  const filter = parseFilter((k) => sp(q, k), settings);
  const [{ rows, sites, pending }, countries] = await Promise.all([themeRows(filter), countryOptions()]);
  const query = new URLSearchParams({ country: filter.country, days: String(filter.days), deals: String(filter.deals) });
  const repeated = rows.filter((r) => r.sites >= 2).length;

  return (
    <>
      <CompNav />
      <PageHeader
        title="Темы"
        subtitle="Что повторяется у новых площадок: кластеры разных сайтов сведены к общим темам. Чем больше площадок получают трафик на теме, тем надёжнее она работает."
        actions={<a href={`/api/competitors/export?${query.toString()}`} className="btn-brand">Скачать Excel</a>}
      />
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Страна</span>
            <select name="country" defaultValue={filter.country} className="input !w-auto">
              <option value="all">Все страны</option>
              {countries.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Добавлены за</span>
            <select name="days" defaultValue={String(filter.days)} className="input !w-auto">
              <option value="7">7 дней</option>
              <option value="15">15 дней</option>
              <option value="31">месяц</option>
              <option value="61">2 месяца</option>
              <option value="92">3 месяца</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Сделок от</span>
            <select name="deals" defaultValue={String(filter.deals)} className="input !w-auto">
              {[0, 1, 2, 5, 10, 20].map((n) => <option key={n} value={n}>{n === 0 ? "любое число" : n}</option>)}
            </select>
          </label>
          <button type="submit" className="btn-primary">Показать</button>
        </form>
        <p className="help mt-3">Разобранных площадок под фильтр: <b>{sites}</b>, тем: <b>{rows.length}</b>, из них встречаются у двух и более площадок: <b>{repeated}</b>.</p>
      </Card>

      {pending > 0 && <div className="mt-4"><Alert>Ещё не отнесены к темам кластеров: {pending}. Разметка идёт сама, когда очередь разбора пуста, — обычно в течение пары минут.</Alert></div>}

      <div className="mt-4">
        {rows.length === 0 ? (
          <Empty title="Тем пока нет" hint={sites ? "Кластеры ещё размечаются — обновите страницу через пару минут." : "Под этот фильтр нет разобранных площадок."} />
        ) : (
          <Card title="Темы по числу площадок" description="Трафик — оценка DataForSEO по разобранным запросам (до 300 самых трафиковых на площадку), а не клики GSC. «Типичная площадка» — медиана: половина площадок темы получает на ней не меньше.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Тема</th>
                    <th>Площадок</th>
                    <th className="col-sm">Трафик всего</th>
                    <th className="col-sm">Типичная площадка</th>
                    <th className="col-sm">Запросов</th>
                    <th className="col-md">Площадки (трафик на теме)</th>
                    <th className="col-md">Примеры запросов</th>
                  </tr>
                </thead>
                <tbody>
                  <ShowMoreRows
                    colSpan={7}
                    initial={40}
                    step={100}
                    noun="тем"
                    rows={rows.map((r) => (
                      <tr key={r.theme}>
                        <td className="!whitespace-normal font-medium">{r.theme}</td>
                        <td className="whitespace-nowrap">{r.sites}</td>
                        <td className="col-sm whitespace-nowrap">{num(r.etv)}</td>
                        <td className="col-sm whitespace-nowrap">{num(r.medianEtv)}</td>
                        <td className="col-sm whitespace-nowrap">{num(r.keywords)}</td>
                        <td className="col-md !whitespace-normal text-[13px]">
                          {r.topSites.map((s, i) => (
                            <span key={s.id}>
                              {i > 0 && ", "}
                              <Link href={`${BASE_PATH}/sites/${s.id}`} className="hover:underline">{s.domain}</Link> <span className="help">{num(s.etv)}</span>
                            </span>
                          ))}
                          {r.sites > r.topSites.length && <span className="help"> и ещё {r.sites - r.topSites.length}</span>}
                        </td>
                        <td className="col-md !whitespace-normal text-[13px]">{r.examples.join(", ")}</td>
                      </tr>
                    ))}
                  />
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
