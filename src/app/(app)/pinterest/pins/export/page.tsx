import Link from "next/link";
import { prisma } from "@/lib/db";
import { pinSiteWhere } from "@/lib/sites/access";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { exportOverview } from "@/lib/pins/export/service";
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
  const quick = (f: string, t: string, label: string) => <Link href={`/pinterest/pins/export?from=${f}&to=${t}`} className={`badge px-3 py-1 ${from === f && to === t ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{label}</Link>;

  return (
    <>
      <PageHeader title="Выгрузка" subtitle="Файл CSV для Pinterest на каждый день и сайт. Сегодняшний файл пересчитывает пропущенные слоты на оставшееся время дня." />
      <div className="space-y-4">
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
        {files.length === 0 ? (
          <Empty title="На выбранные дни готовых пинов нет" hint="Готовые пины: одобрены, с текстом, загружены в WordPress и получили дату." />
        ) : (
          <Card title={`Файлы: ${files.length}`}>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>День</th><th>Сайт</th><th>Файл</th><th>Пинов</th><th>Правки</th><th>Скачан</th><th></th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={`${f.siteId}-${f.day}`}>
                    <td>{formatRu(f.day)}{f.day === today && <Badge tone="brand">сегодня</Badge>}</td>
                    <td>{f.siteName}</td>
                    <td className="font-mono text-[12px]">{f.fileName}</td>
                    <td>{f.count}{f.issues ? <span className="text-danger"> · проблем {f.issues}</span> : null}</td>
                    <td className="text-muted text-[12px]">{f.retimed ? `перенесено ${f.retimed}` : ""}{f.linksReplaced ? ` · ссылок ${f.linksReplaced}` : ""}</td>
                    <td className="text-muted text-[12px]">{f.downloadedAt ? fmtDate(f.downloadedAt) : "—"}</td>
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
