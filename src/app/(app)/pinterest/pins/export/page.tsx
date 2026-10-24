import Link from "next/link";
import { prisma } from "@/lib/db";
import { pinSiteWhere } from "@/lib/sites/access";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { exportOverview, futureReadyBySite } from "@/lib/pins/export/service";
import { addDays, todayKey, formatRu } from "@/lib/pins/schedule/math";
import { TZ } from "@/lib/pins/runs/stats";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ExportPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const p = await searchParams;
  const today = todayKey(new Date(), TZ);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp(p, "from") ?? "") ? (sp(p, "from") as string) : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp(p, "to") ?? "") ? (sp(p, "to") as string) : from;
  const sites = await prisma.pinSite.findMany({ where: { ...(await pinSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const selected = (p.site ? (Array.isArray(p.site) ? p.site : [p.site]) : sites.map((s) => s.id)).filter((id) => sites.some((s) => s.id === id));
  const days: string[] = [];
  for (let d = from, i = 0; d <= to && i < 31; d = addDays(d, 1), i++) days.push(d);
  const files = await exportOverview(me, selected, days);
  const todayFiles = from === today && to === today && selected.length === sites.length ? files : await exportOverview(me, sites.map((s) => s.id), [today]);
  const todayPins = todayFiles.reduce((n, f) => n + f.count, 0);
  const ready = await futureReadyBySite(sites.map((s) => s.id));
  const readySites = sites.filter((s) => ready.has(s.id));
  const quick = (f: string, t: string, label: string) => <Link href={`/pinterest/pins/export?from=${f}&to=${t}`} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${from === f && to === t ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{label}</Link>;

  return (
    <>
      <PageHeader title="Выгрузка" subtitle="Файл CSV для Pinterest на каждый день и сайт. Сегодняшний файл пересчитывает пропущенные слоты на оставшееся время дня." />
      <div className="space-y-4">
        <section id="today" className="card p-4 sm:p-5 border-brand/50">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="h2">Файлы на сегодня, {formatRu(today)}</h2>
              <p className="help">{todayFiles.length ? `Сайтов: ${todayFiles.length}, пинов: ${todayPins}. Один файл на сайт: в нём пины всех прогонов сайта на этот день.` : "На сегодня готовых пинов нет ни у одного сайта."}</p>
            </div>
            {todayFiles.length > 0 && <a href="/api/pins/export/today" className="btn-brand">Скачать все файлы на сегодня</a>}
          </div>
          {todayFiles.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {todayFiles.map((f) => <a key={f.siteId} href={`/api/pins/export?site=${f.siteId}&day=${today}`} className="btn-ghost btn-sm" title={f.fileName}>{f.siteName} <span className="help">· {f.count}{f.downloadedAt ? " · скачан" : ""}</span></a>)}
            </div>
          )}
        </section>
        <Card>
          <div className="flex flex-wrap gap-2 mb-3">
            {quick(today, today, "Сегодня")}
            {quick(addDays(today, 1), addDays(today, 1), "Завтра")}
            {quick(today, addDays(today, 1), "Сегодня + завтра")}
            {quick(today, addDays(today, 6), "7 дней")}
          </div>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="С"><input type="date" name="from" className="input" defaultValue={from} /></Field>
            <Field label="По"><input type="date" name="to" className="input" defaultValue={to} /></Field>
            <div className="min-w-[220px]"><span className="label">Сайты</span>
              <div className="flex flex-wrap gap-x-4 gap-y-1 max-h-32 overflow-auto">
                {sites.map((s) => <label key={s.id} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" name="site" value={s.id} defaultChecked={selected.includes(s.id)} /> {s.name}</label>)}
              </div>
            </div>
            <button className="btn-primary">Показать</button>
          </form>
        </Card>
        <Card title="Выгрузить все сформированные пины сайта" description="Один архив на сайт: по CSV на каждый день с сегодняшнего до последней даты. В конце имени каждого файла — сколько пинов в этом дне.">
          {readySites.length === 0 ? <p className="help">Готовых пинов с датами на сегодня и позже пока нет.</p> : (
            <div className="flex flex-wrap gap-2">
              {readySites.map((s) => { const r = ready.get(s.id)!; return (
                <a key={s.id} href={`/api/pins/export/all?site=${s.id}`} className="btn-ghost !whitespace-normal text-left max-w-full" title={`до ${formatRu(r.lastDay)}`}>Выгрузить все для {s.name} <span className="help">· {r.pins} пинов, {r.days} дн.</span></a>
              ); })}
            </div>
          )}
        </Card>
        {files.length === 0 ? (
          <Empty title="На выбранные дни готовых пинов нет" hint="Готовые пины: одобрены, с текстом, загружены в WordPress и получили дату." />
        ) : (
          <Card title={`Файлы: ${files.length}`}>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>День</th><th>Сайт</th><th className="col-sm">Файл</th><th>Пинов</th><th className="col-sm">Правки</th><th className="col-sm">Скачан</th><th></th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={`${f.siteId}-${f.day}`}>
                    <td>{formatRu(f.day)}{f.day === today && <Badge tone="brand">сегодня</Badge>}</td>
                    <td>{f.siteName}</td>
                    <td className="col-sm font-mono text-[12px]">{f.fileName}</td>
                    <td>{f.count}{f.issues ? <span className="text-danger"> · проблем {f.issues}</span> : null}</td>
                    <td className="col-sm text-muted text-[12px]">{f.retimed ? `перенесено ${f.retimed}` : ""}{f.linksReplaced ? ` · ссылок ${f.linksReplaced}` : ""}</td>
                    <td className="col-sm text-muted text-[12px]">{f.downloadedAt ? fmtDate(f.downloadedAt) : "—"}</td>
                    <td className="text-right"><a href={`/api/pins/export?site=${f.siteId}&day=${f.day}`} className="btn-brand btn-sm">Скачать CSV</a></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </Card>
        )}
      </div>
    </>
  );
}
