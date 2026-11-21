import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ShowMoreRows } from "@/components/ui/ShowMore";
import { CompNav } from "@/components/competitors/CompNav";
import { analyzeCompSites, syncCompNow } from "@/actions/competitors";
import { canManage, canSee, countryOptions, listSites, loadState, parseFilter } from "@/lib/competitors/sites";
import { BASE_PATH, STATUS_LABELS, STATUS_TONE } from "@/lib/competitors/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("ru-RU"));
const day = (d: Date | null) => (d ? d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }) : "—");

export default async function CompetitorsHome({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) {
    return <Empty title="Нет доступа" hint="«Анализ конкурентов» открыт команде WexOra." />;
  }
  const q = await searchParams;
  const state = await loadState();
  const filter = parseFilter((k) => sp(q, k), state.settings);
  const [{ rows, total, done }, countries, manage] = await Promise.all([listSites(filter), countryOptions(), canManage(me)]);
  const query = new URLSearchParams({ country: filter.country, days: String(filter.days), deals: String(filter.deals), status: filter.status, sort: filter.sort, ...(filter.q ? { q: filter.q } : {}) });
  const hidden = Object.fromEntries(query.entries());
  const todo = rows.filter((r) => r.status === "none" || r.status === "error").length;
  const busy = rows.filter((r) => r.status === "queued" || r.status === "processing").length;
  const syncing = !!state.syncAsked && (!state.lastSyncAt || state.syncAsked > state.lastSyncAt);

  return (
    <>
      <CompNav />
      <PageHeader
        title="Анализ конкурентов"
        subtitle="Новые площадки каталога Collaborator.pro, у которых уже есть клики из поиска и заказы. По каждой — запросы в топе Google, тематические кластеры и вывод, что у неё работает."
        actions={<a href={`/api/competitors/export?${query.toString()}`} className="btn-brand">Скачать Excel</a>}
      />

      {state.lastSync?.error && <div className="mb-4"><Alert tone="danger">Последний сбор не удался: {state.lastSync.error}</Alert></div>}

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
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Разбор</span>
            <select name="status" defaultValue={filter.status} className="input !w-auto">
              <option value="all">все</option>
              <option value="done">разобранные</option>
              <option value="todo">не разобранные</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Сортировка</span>
            <select name="sort" defaultValue={filter.sort} className="input !w-auto">
              <option value="clicks">по кликам GSC</option>
              <option value="growth">по росту кликов</option>
              <option value="added">сначала новые</option>
              <option value="deals">по сделкам</option>
              <option value="kw">по числу запросов</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Поиск</span>
            <input name="q" defaultValue={filter.q} placeholder="домен, кластер, категория" className="input sm:!w-[220px]" />
          </label>
          <button type="submit" className="btn-primary">Показать</button>
        </form>
        <p className="help mt-3">
          Найдено площадок: <b>{num(total)}</b>, разобрано: <b>{num(done)}</b>
          {busy > 0 && <> , в очереди на разбор: <b>{busy}</b></>}.{" "}
          {state.lastSyncAt ? <>Каталог обновлён {fmtDate(state.lastSyncAt)}{state.lastSync?.fresh != null && <> (новых площадок: {state.lastSync.fresh})</>}.</> : <>Каталог ещё не собирался.</>}
          {syncing && <> Идёт сбор…</>}
        </p>
        {manage && (
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <ActionForm action={syncCompNow} className="">
              <SubmitButton className="btn-ghost btn-sm" pendingText="Запускаю…">Обновить каталог сейчас</SubmitButton>
            </ActionForm>
            {todo > 0 && (
              <ActionForm action={analyzeCompSites} hidden={hidden} className="">
                <SubmitButton className="btn-ghost btn-sm" pendingText="Ставлю…" confirm={`Разобрать неразобранные площадки из этого списка (до 100 за раз)? Расход — около $0.06 за площадку.`}>Разобрать неразобранные ({todo})</SubmitButton>
              </ActionForm>
            )}
          </div>
        )}
      </Card>

      <div className="mt-4">
        {rows.length === 0 ? (
          <Empty title="Площадок под фильтр нет" hint={state.lastSyncAt ? "Расширьте период, снимите порог сделок или выберите другую страну." : "Каталог собирается раз в сутки. Первый сбор запустится сам в течение пары минут."} />
        ) : (
          <Card title={`Площадки${total > rows.length ? ` (показаны первые ${rows.length} из ${total})` : ""}`} description="Клики и показы — данные Google Search Console за прошлый месяц, которыми площадка поделилась с Collaborator. Запросы и кластеры — по базе DataForSEO.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Площадка</th>
                    <th className="col-sm">Добавлена</th>
                    <th>Сделок</th>
                    <th>Клики GSC</th>
                    <th className="col-sm">Рост</th>
                    <th className="col-sm">Запросов в топ-30</th>
                    <th className="col-md">Главные кластеры</th>
                    <th>Разбор</th>
                  </tr>
                </thead>
                <tbody>
                  <ShowMoreRows
                    colSpan={8}
                    initial={50}
                    step={100}
                    noun="площадок"
                    rows={rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link href={`${BASE_PATH}/sites/${r.id}`} className="font-medium hover:underline">{r.domain}</Link>
                          <div className="help line-clamp-1">{r.categories.split("|").filter(Boolean).slice(0, 3).join(", ")}</div>
                        </td>
                        <td className="col-sm help whitespace-nowrap">{day(r.addedAt)}</td>
                        <td className="whitespace-nowrap">{r.deals >= 5 ? `${r.deals}+` : r.deals}</td>
                        <td className="whitespace-nowrap">{num(r.gscClicks)}<div className="help">{num(r.gscImpr)} показов</div></td>
                        <td className="col-sm whitespace-nowrap">{r.gscGrowth == null ? "—" : <span className={r.gscGrowth > 0 ? "text-ok" : r.gscGrowth < 0 ? "text-danger" : ""}>{r.gscGrowth > 0 ? "+" : ""}{r.gscGrowth}%</span>}</td>
                        <td className="col-sm whitespace-nowrap">{num(r.kwTotal)}{r.kwTop10 != null && <div className="help">в топ-10: {num(r.kwTop10)}</div>}</td>
                        <td className="col-md"><div className="line-clamp-3 !whitespace-normal text-[13px]">{r.mainClusters || <span className="help">{r.status === "error" ? r.error : "—"}</span>}</div></td>
                        <td>
                          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                          {(r.status === "none" || r.status === "error") && (
                            <ActionForm action={analyzeCompSites} hidden={{ site: r.id }} className="mt-1">
                              <SubmitButton className="btn-ghost btn-sm" pendingText="…">Разобрать</SubmitButton>
                            </ActionForm>
                          )}
                        </td>
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
