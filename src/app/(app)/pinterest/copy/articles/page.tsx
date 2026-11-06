import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { articlesData } from "@/lib/copy/queries";
import { modifierLabel, nicheLabel } from "@/lib/copy/keys";
import { stageLabel } from "@/lib/articles/stages";
import { statusLabel } from "@/lib/articles/labels";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Статьи, собранные автосборкой Article Copy, и где каждая сейчас в конвейере сервиса «Статьи». */
export default async function CopyArticlesPage() {
  const me = await requireUser();
  const d = await articlesData(me);
  const st = d.settings;

  return (
    <>
      <PageHeader title="Собранные статьи" subtitle="Статьи, которые Article Copy собрал из готовых фото. Текст и публикацию делает очередь сервиса «Статьи»." back={{ href: "/pinterest/copy", label: "Запас" }} />
      <div className="space-y-5">
        <Card title="Автосборка">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${st.autoEnabled ? "bg-ok-soft text-ok" : "bg-brand-soft text-warn"}`}>{st.autoEnabled ? "Включена" : "Выключена"}</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5">На сайт в сутки: <b className="tabular-nums">{st.dailyPerSite}</b></span>
            <span className="inline-flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5">Собрано сегодня: <b className="tabular-nums">{d.today}</b></span>
            <span className="inline-flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5">Всего: <b className="tabular-nums">{d.total}</b></span>
            <Link href="/pinterest/copy/settings" className="btn-ghost btn-sm">Настроить</Link>
          </div>
          {!st.autoEnabled && <p className="help mt-2">Включается на вкладке «Сайты и правила». После включения система сама собирает, пишет и публикует статьи по привязанным сайтам.</p>}
          {st.autoNote && <div className="mt-3"><div className="label">Последний проход{st.autoAt ? ` · ${fmtDate(st.autoAt)}` : ""}</div><pre className="whitespace-pre-wrap rounded-lg bg-ink/5 px-3 py-2 text-[12.5px]">{st.autoNote}</pre></div>}
        </Card>

        <Card title="Статьи" description="Последние 300. «Не скачалось» — кадры резерва, у которых перестала работать ссылка источника: они заменены другими.">
          {d.rows.length === 0 ? (
            <Empty title="Пока ничего не собрано" hint="Привяжите сайты и включите автосборку на вкладке «Сайты и правила»." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Ключ</th><th>Сайт</th><th className="hidden md:table-cell">Ниша</th><th className="text-right">Фото</th><th className="text-right">Из резерва</th><th className="text-right">Статей-доноров</th><th className="text-right">Не скачалось</th><th>Состояние</th><th className="text-right">Расход, $</th><th>Собрана</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="min-w-[200px]"><Link href={`/pinterest/articles/articles/${r.articleId}`} className="font-medium hover:underline">{r.keyword}</Link><div className="help">{r.core} · {modifierLabel(r.modifier)}</div></td>
                      <td>{r.site}</td>
                      <td className="hidden md:table-cell text-muted">{nicheLabel(r.niche)}</td>
                      <td className="text-right tabular-nums">{r.photos}</td>
                      <td className="text-right tabular-nums">{r.fromReserve}</td>
                      <td className="text-right tabular-nums">{r.donors}</td>
                      <td className="text-right tabular-nums text-muted">{r.lost}</td>
                      <td className="text-[13px]">
                        {!r.art ? <span className="text-muted">удалена</span> : r.art.wpUrl && r.art.status === "COMPLETED" ? <a href={r.art.wpUrl} target="_blank" rel="noreferrer" className="text-ok hover:underline">Опубликована</a> : <span title={r.art.error ?? undefined}>{statusLabel(r.art.status)}{r.art.status === "PENDING" || r.art.status === "RUNNING" ? ` · ${stageLabel(r.art.stage)}` : ""}</span>}
                      </td>
                      <td className="text-right tabular-nums text-muted">{r.art ? r.art.costUsd.toFixed(2) : "—"}</td>
                      <td className="whitespace-nowrap text-muted">{fmtDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
