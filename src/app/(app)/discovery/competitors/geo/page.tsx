import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert, Card, Empty, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ShowMoreRows } from "@/components/ui/ShowMore";
import { CompNav } from "@/components/competitors/CompNav";
import { canSee, loadGeo } from "@/lib/competitors/sites";
import { sortRows, type GeoBlock, type GeoRow, type GeoSort } from "@/lib/competitors/geo";
import { BASE_PATH } from "@/lib/competitors/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("ru-RU"));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const avg = (r: { deals: number; sites: number }) => (r.sites ? (r.deals / r.sites).toFixed(1).replace(".", ",") : "—");

const SCOPES = [
  { key: "31", label: "Новые за месяц" },
  { key: "61", label: "Новые за 2 месяца" },
  { key: "92", label: "Новые за 3 месяца" },
  { key: "all", label: "Весь каталог" },
];
const SORTS: Array<{ key: GeoSort; label: string }> = [
  { key: "deals", label: "по числу заказов" },
  { key: "avg", label: "по заказам на площадку" },
  { key: "share", label: "по доле площадок с заказами" },
  { key: "strong", label: "по числу площадок с 5+ заказами" },
  { key: "sites", label: "по числу площадок" },
];

function GeoTable({ rows, first, innerLabel, currency }: { rows: GeoRow[]; first: string; innerLabel: string; currency: string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{first}</th>
            <th>Заказов, не меньше</th>
            <th>Площадок</th>
            <th className="col-sm">С заказами</th>
            <th className="col-sm">Заказов на площадку</th>
            <th className="col-sm">С 5+ / 20+</th>
            <th className="col-sm">Цена статьи</th>
            <th className="col-md">{innerLabel}</th>
            <th className="col-md">Ниши по заказам</th>
            <th className="col-md">Площадки с заказами</th>
          </tr>
        </thead>
        <tbody>
          <ShowMoreRows
            colSpan={10}
            initial={20}
            step={60}
            noun="строк"
            rows={rows.map((r) => (
              <tr key={r.name}>
                <td className="font-medium">{r.name}</td>
                <td className="whitespace-nowrap font-medium">{num(r.deals)}</td>
                <td className="whitespace-nowrap">{num(r.sites)}</td>
                <td className="col-sm whitespace-nowrap">{num(r.withDeals)} <span className="help">{pct(r.withDeals, r.sites)}</span></td>
                <td className="col-sm whitespace-nowrap">{avg(r)}</td>
                <td className="col-sm whitespace-nowrap">{r.d5} / {r.d20}</td>
                <td className="col-sm whitespace-nowrap">{r.medPrice != null ? `${num(r.medPrice)} ${currency}` : "—"}</td>
                <td className="col-md !whitespace-normal text-[13px]">{r.inner.filter((i) => i.deals > 0).map((i) => `${i.name} ${num(i.deals)}`).join(", ") || "—"}</td>
                <td className="col-md !whitespace-normal text-[13px]">{r.cats.filter((i) => i.deals > 0).map((i) => `${i.name} ${num(i.deals)}`).join(", ") || "—"}</td>
                <td className="col-md !whitespace-normal text-[13px]">
                  {r.top.slice(0, 5).map((s, i) => (
                    <span key={`${s.domain}${i}`}>
                      {i > 0 && ", "}
                      {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.domain}</a> : s.domain} <span className="help">{s.deals >= 5 ? `${s.deals}+` : s.deals}</span>
                    </span>
                  ))}
                  {r.top.length === 0 && "—"}
                </td>
              </tr>
            ))}
          />
        </tbody>
      </table>
    </div>
  );
}

export default async function CompetitorsGeo({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Анализ конкурентов» открыт команде WexOra." />;
  const q = await searchParams;
  const geo = await loadGeo();
  const scope = SCOPES.some((s) => s.key === sp(q, "scope")) ? (sp(q, "scope") as string) : "92";
  const sort = (SORTS.find((s) => s.key === sp(q, "sort"))?.key ?? "deals") as GeoSort;
  const block: GeoBlock | undefined = scope === "all" ? geo?.all : geo?.windows?.[scope];
  const href = (s: string) => `${BASE_PATH}/geo?scope=${s}&sort=${sort}`;

  return (
    <>
      <CompNav />
      <PageHeader
        title="Гео"
        subtitle="Где у площадок Collaborator больше всего заказов — по языкам и странам. Площадки на украинском и русском сюда не входят: они вынесены одной строкой для сравнения."
        actions={block ? <a href={`/api/competitors/geo-export?scope=${scope}&sort=${sort}`} className="btn-brand">Скачать Excel</a> : undefined}
      />
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {SCOPES.map((s) => <Link key={s.key} href={href(s.key)} className={`tab ${scope === s.key ? "active" : ""}`}>{s.label}</Link>)}
        <form method="get" className="ml-auto flex items-center gap-2">
          <input type="hidden" name="scope" value={scope} />
          <select name="sort" defaultValue={sort} className="input !w-auto">
            {SORTS.map((s) => <option key={s.key} value={s.key}>Сортировка: {s.label}</option>)}
          </select>
          <button type="submit" className="btn-primary btn-sm">Показать</button>
        </form>
      </div>

      {!block ? (
        <Empty title="Данных пока нет" hint={scope === "all" ? "Срез по всему каталогу считается раз в неделю и занимает 5–6 минут. Первый расчёт запускается сам после сбора каталога." : "Срезы по новым площадкам появятся после ближайшего сбора каталога (раз в сутки после 06:00 по Киеву или кнопкой «Обновить каталог сейчас» на вкладке «Площадки»)."} />
      ) : (
        <>
          <Alert>
            {scope === "all" ? "Во всём каталоге" : `Среди площадок, добавленных за ${scope === "31" ? "месяц" : scope === "61" ? "2 месяца" : "3 месяца"},`} не на украинском и не на русском: <b>{num(block.sites)}</b> площадок, из них с заказами <b>{num(block.withDeals)}</b> ({pct(block.withDeals, block.sites)}), заказов не меньше <b>{num(block.deals)}</b>.{" "}
            {block.home && <>Для сравнения, {block.home.name.toLowerCase()}: {num(block.home.sites)} площадок, с заказами {num(block.home.withDeals)} ({pct(block.home.withDeals, block.home.sites)}), заказов не меньше {num(block.home.deals)}, на площадку {avg(block.home)}.{" "}</>}
            Обновлено {fmtDate(scope === "all" ? geo?.allAt : geo?.at)}.
          </Alert>
          <p className="help mt-3">
            Как читать. Collaborator отдаёт число заказов нижней границей: точное до 4, дальше 5, 10, 20 или 50 — поэтому «не меньше»; у площадки с 50+ их может быть в разы больше. У площадки бывает несколько языков и стран — она считается в каждой строке.
            {scope !== "all" && " Новая площадка в каталоге — не обязательно новый сайт: часть из них старые сайты, которые только что подключились."} Заказы на площадку и доля с заказами при сортировке учитываются только для строк, где площадок 10 и больше.
          </p>
          <div className="mt-4">
            <Card title={`Языки (${block.languages.length})`} description="На каком языке делать сайт. «Страны» — где внутри языка заказы.">
              <GeoTable rows={sortRows(block.languages, sort)} first="Язык" innerLabel="Страны по заказам" currency={block.currency} />
            </Card>
          </div>
          <div className="mt-4">
            <Card title={`Страны (${block.countries.length})`} description="Под какую страну делать сайт. «Языки» — на каких языках площадки этой страны получают заказы.">
              <GeoTable rows={sortRows(block.countries, sort)} first="Страна" innerLabel="Языки по заказам" currency={block.currency} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
