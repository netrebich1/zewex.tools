import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { markUploaded, markUploadedThrough, unmarkUploaded } from "@/actions/projects";
import { formatRu, todayKey } from "@/lib/pins/schedule/math";
import { TZ } from "@/lib/pins/runs/stats";

/** Вкладка «Выгрузки»: каждый день, за который скачивали файл экспорта, и отметка «залито в Pinterest». */
export async function UploadsTab({ accessId, userName }: { accessId: string; userName: (id: string | null) => string | null }) {
  const pinSites = await prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true, name: true } });
  if (!pinSites.length) return <Card title="Выгрузки"><p className="help">Pinterest Pins для этого сайта не подключён — выгрузок нет.</p></Card>;
  const today = todayKey(new Date(), TZ);
  const blocks = await Promise.all(pinSites.map(async (site) => {
    const [days, uploads, lastLogs] = await Promise.all([
      prisma.pinExportLog.groupBy({ by: ["day"], where: { siteId: site.id }, _count: { _all: true }, _max: { createdAt: true, rows: true } }),
      prisma.prjUpload.findMany({ where: { pinSiteId: site.id } }),
      prisma.pinExportLog.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" }, distinct: ["day"], select: { day: true, userId: true, fileName: true } }),
    ]);
    const up = new Map(uploads.map((u) => [u.day, u]));
    const who = new Map(lastLogs.map((l) => [l.day, l]));
    const rows = days.map((d) => ({ day: d.day, downloads: d._count._all, rows: d._max.rows ?? 0, lastAt: d._max.createdAt, by: who.get(d.day)?.userId ?? null, fileName: who.get(d.day)?.fileName ?? "", upload: up.get(d.day) ?? null })).sort((a, b) => b.day.localeCompare(a.day));
    return { site, rows, pending: rows.filter((r) => !r.upload).length };
  }));

  return (
    <div className="space-y-4">
      {blocks.map(({ site, rows, pending }) => (
        <Card key={site.id} title={pinSites.length > 1 ? `Выгрузки · ${site.name}` : "Выгрузки и заливка в Pinterest"}
          description="Строка — день, за который скачивали CSV в «Выгрузке» Pinterest Pins. Залили файл в Pinterest — поставьте галочку. Когда заливка станет автоматической, отметки будут появляться сами."
          actions={<Link href="/pinterest/pins/export" className="btn-ghost btn-sm">Открыть выгрузку</Link>}>
          {rows.length === 0 ? <p className="help">Файлы ещё не скачивали.</p> : (
            <>
              {pending > 0 && (
                <ActionForm action={markUploadedThrough} hidden={{ accessId, pinSiteId: site.id }} className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px]">Без отметки: <b>{pending}</b> дн. Отметить залитым всё по</span>
                  <input type="date" name="day" className="input py-1.5 w-[160px]" defaultValue={today} />
                  <SubmitButton className="btn-primary btn-sm" pendingText="…">Отметить</SubmitButton>
                </ActionForm>
              )}
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>День</th><th>Пинов в файле</th><th>Скачан</th><th>Залито в Pinterest</th></tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.day} className={r.upload ? "" : r.day < today ? "bg-warn-soft/40" : ""}>
                      <td className="font-medium whitespace-nowrap">{formatRu(r.day)}{r.day === today && <span className="ml-1.5 text-[12px] text-muted">сегодня</span>}</td>
                      <td className="tabular-nums">{r.rows}<span className="help ml-1 inline">{r.downloads > 1 ? `· скачивали ${r.downloads} раз` : ""}</span></td>
                      <td className="text-muted whitespace-nowrap">{r.lastAt ? r.lastAt.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"}{r.by ? ` · ${userName(r.by) ?? ""}` : ""}</td>
                      <td>
                        {r.upload ? (
                          <div className="flex items-center gap-2">
                            <span className="badge bg-ok-soft text-ok">✓ залито {r.upload.uploadedAt.toLocaleDateString("ru-RU")}{r.upload.source === "auto" ? " · авто" : r.upload.uploadedById ? ` · ${userName(r.upload.uploadedById) ?? ""}` : ""}</span>
                            <ActionForm action={unmarkUploaded} hidden={{ accessId, pinSiteId: site.id, day: r.day }} className="inline"><SubmitButton className="text-[12px] text-muted hover:text-danger" pendingText="…">снять</SubmitButton></ActionForm>
                          </div>
                        ) : (
                          <ActionForm action={markUploaded} hidden={{ accessId, pinSiteId: site.id, day: r.day }} className="inline"><SubmitButton className="btn-ghost btn-sm" pendingText="…">Залито</SubmitButton></ActionForm>
                        )}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
