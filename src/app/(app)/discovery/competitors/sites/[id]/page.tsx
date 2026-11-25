import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ShowMoreRows } from "@/components/ui/ShowMore";
import { CompNav } from "@/components/competitors/CompNav";
import { analyzeCompSites } from "@/actions/competitors";
import { canSee } from "@/lib/competitors/sites";
import { BASE_PATH, splitList, STATUS_LABELS, STATUS_TONE, type ClusterTop, type SiteData } from "@/lib/competitors/types";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("ru-RU"));
const path = (u: string | null) => {
  if (!u) return "";
  try {
    const x = new URL(u);
    return decodeURI(x.pathname + x.search) || "/";
  } catch {
    return u;
  }
};

export default async function CompetitorSite({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Анализ конкурентов» открыт команде WexOra." />;
  const { id } = await params;
  const site = await prisma.compSite.findUnique({ where: { id }, include: { clusters: { orderBy: { position: "asc" } }, keywords: { orderBy: { etv: "desc" } } } });
  if (!site) notFound();
  const data = (site.data ?? {}) as SiteData;
  const clicks = data.gsc?.clicks ?? [];
  const impressions = new Map((data.gsc?.impressions ?? []).map((m) => [m.month, m.value]));
  const canRun = site.status !== "queued" && site.status !== "processing";

  return (
    <>
      <CompNav />
      <PageHeader
        title={site.domain}
        back={{ href: BASE_PATH, label: "Площадки" }}
        subtitle={<>{splitList(site.countries).join(", ") || "страна не указана"} · {splitList(site.categories).join(", ") || "без категорий"} · в Collaborator с {site.addedAt ? site.addedAt.toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "—"}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={`https://${site.domain}`} target="_blank" rel="noreferrer" className="btn-ghost">Открыть сайт</a>
            {site.collabUrl && <a href={site.collabUrl} target="_blank" rel="noreferrer" className="btn-ghost">В Collaborator</a>}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <div className="kpi"><div className="kpi-value">{num(site.gscClicks)}</div><div className="help">кликов GSC за месяц</div></div>
        <div className="kpi"><div className="kpi-value">{num(site.gscImpr)}</div><div className="help">показов GSC за месяц</div></div>
        <div className="kpi"><div className="kpi-value">{site.deals >= 5 ? `${site.deals}+` : site.deals}</div><div className="help">сделок в Collaborator</div></div>
        <div className="kpi"><div className="kpi-value">{num(site.kwTotal)}</div><div className="help">запросов в топ-30{site.kwTop10 != null ? `, в топ-10: ${num(site.kwTop10)}` : ""}</div></div>
        <div className="kpi"><div className="kpi-value">{site.price != null ? num(Math.round(site.price)) : "—"}</div><div className="help">цена статьи{site.currency ? `, ${site.currency}` : ""}</div></div>
      </div>

      <div className="mt-4">
        <Card
          title="Вывод"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[site.status] ?? "neutral"}>{STATUS_LABELS[site.status] ?? site.status}</Badge>
              {canRun && (
                <ActionForm action={analyzeCompSites} hidden={{ site: site.id }} className="">
                  <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm={site.status === "done" ? "Снять семантику заново? Расход — около $0.06." : undefined}>{site.status === "done" ? "Разобрать заново" : "Разобрать"}</SubmitButton>
                </ActionForm>
              )}
            </div>
          }
        >
          {site.status === "error" && <Alert tone="danger">Разбор не удался: {site.error}</Alert>}
          {site.status === "empty" && <Alert tone="warn">В базе DataForSEO по этой площадке меньше 20 запросов ({num(site.kwTotal)}) — кластеры не строились.</Alert>}
          {(site.status === "queued" || site.status === "processing") && <Alert>Площадка в очереди на разбор, обычно это около минуты. Обновите страницу.</Alert>}
          {site.status === "none" && <p className="help">Площадка ещё не разбиралась. Нажмите «Разобрать» — запросы и кластеры появятся примерно через минуту.</p>}
          {site.summary && <p className="text-[14.5px]">{site.summary}</p>}
          {site.takeaway && <p className="mt-2 text-[14.5px]"><b>Что работает и что повторить.</b> {site.takeaway}</p>}
          {data.description && <p className="help mt-3">Описание владельца: {data.description}</p>}
          {site.analyzedAt && <p className="help mt-3">Разобрано {fmtDate(site.analyzedAt)} по базе «{site.kwCountry}», расход {fmtMoney(site.costUsd)}. Трафик по кластерам — оценка DataForSEO, а не клики GSC.</p>}
        </Card>
      </div>

      {site.clusters.length > 0 && (
        <div className="mt-4">
          <Card title={`Кластеры (${site.clusters.length})`} description={`Построены по ${site.keywords.length} самым трафиковым запросам из топ-30. Доля — от оценки трафика этих запросов.`}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Кластер</th>
                    <th>Доля</th>
                    <th className="col-sm">Запросов</th>
                    <th className="col-sm">Трафик в мес</th>
                    <th className="col-md">Примеры запросов</th>
                    <th className="col-md">Страницы</th>
                  </tr>
                </thead>
                <tbody>
                  {site.clusters.map((c) => (
                    <tr key={c.id}>
                      <td className="!whitespace-normal">
                        <div className="font-medium">{c.name}</div>
                        {c.type && <div className="help">{c.type}</div>}
                        {c.what && <div className="mt-1 text-[13px] text-muted">{c.what}</div>}
                      </td>
                      <td className="whitespace-nowrap font-medium">{c.share}%</td>
                      <td className="col-sm">{num(c.count)}</td>
                      <td className="col-sm">{num(c.etv)}</td>
                      <td className="col-md !whitespace-normal text-[13px]">{((c.top as ClusterTop[] | null) ?? []).slice(0, 6).map((t) => `${t.kw} (${num(t.vol)})`).join(", ")}</td>
                      <td className="col-md !whitespace-normal text-[13px]">
                        {((c.pages as string[] | null) ?? []).map((u) => (
                          <a key={u} href={u} target="_blank" rel="noreferrer" className="block break-all hover:underline">{path(u)}</a>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {site.keywords.length > 0 && (
        <div className="mt-4">
          <Card title={`Запросы (${site.keywords.length})`} description="По убыванию оценки трафика. Полный список со всеми площадками — в выгрузке Excel.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Запрос</th>
                    <th>Частота</th>
                    <th>Позиция</th>
                    <th className="col-sm">Трафик</th>
                    <th className="col-md">Кластер</th>
                    <th className="col-md">Страница</th>
                  </tr>
                </thead>
                <tbody>
                  <ShowMoreRows
                    colSpan={6}
                    initial={30}
                    step={100}
                    noun="запросов"
                    rows={site.keywords.map((k) => (
                      <tr key={k.id}>
                        <td className="!whitespace-normal">{k.kw}</td>
                        <td>{num(k.volume)}</td>
                        <td>{k.pos ?? "—"}</td>
                        <td className="col-sm">{num(Math.round(k.etv))}</td>
                        <td className="col-md !whitespace-normal text-[13px]">{k.cluster}</td>
                        <td className="col-md !whitespace-normal text-[13px]">{k.url && <a href={k.url} target="_blank" rel="noreferrer" className="break-all hover:underline">{path(k.url)}</a>}</td>
                      </tr>
                    ))}
                  />
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {clicks.length > 0 && (
        <div className="mt-4">
          <Card title="Search Console по месяцам" description="Данные, которыми площадка поделилась с Collaborator.">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Месяц</th><th>Клики</th><th>Показы</th></tr></thead>
                <tbody>
                  {clicks.map((m) => (
                    <tr key={m.month}><td>{m.month}</td><td>{num(m.value)}</td><td>{num(impressions.get(m.month))}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
