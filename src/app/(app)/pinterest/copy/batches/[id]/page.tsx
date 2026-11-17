import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { setCopyBatchStatus } from "@/actions/copyBatch";
import { batchData } from "@/lib/copy/batchQueries";
import { VOL_LABEL, clusterOf, fmtVolume, nicheLabel } from "@/lib/copy/keys";
import { stageLabel } from "@/lib/articles/stages";
import { statusLabel } from "@/lib/articles/labels";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Страница партии: ход сборки и написания, список тем с частотностью и состоянием каждой статьи. */
export default async function CopyBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const d = await batchData(me, id);
  if (!d) notFound();
  const b = d.batch;
  const admin = me.role === "ADMIN";
  const quotas = b.quotas as Record<string, Record<string, number>>;
  const clusters = new Map<string, number>();
  for (const it of d.items) { const k = `${nicheLabel(it.niche)} · ${clusterOf(it.core)}`; clusters.set(k, (clusters.get(k) ?? 0) + 1); }
  const clusterRows = [...clusters.entries()].sort((a, b) => b[1] - a[1]);
  const pill = (label: string, v: number | string, tone = "bg-ink/5") => <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${tone}`}>{label}: <b className="tabular-nums">{v}</b></span>;

  return (
    <>
      <PageHeader
        title={b.name}
        subtitle={`${d.author} · ${fmtDate(b.createdAt)} · сайтов ${d.sites.length} · фото в статье ${b.photosMax ? `${b.photos}–${b.photosMax}` : b.photos}${b.word ? ` · темы со словом «${b.word}»` : ""}${b.review ? " · с проверкой перед публикацией" : ""}${b.noSeason ? " · без сезонных" : ""}${b.year ? ` · год ${b.year}` : ""}`}
        back={{ href: "/pinterest/copy/batches", label: "Партии" }}
        actions={admin && b.status !== "done" ? (
          <ActionForm action={setCopyBatchStatus} className="flex items-center gap-2" hidden={{ id: b.id, op: b.status === "running" ? "pause" : "resume" }}>
            <SubmitButton className="btn-ghost btn-sm" pendingText="…">{b.status === "running" ? "Пауза" : "Продолжить"}</SubmitButton>
          </ActionForm>
        ) : undefined}
      />
      <div className="space-y-5">
        <Card title="Ход партии">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={b.status === "running" ? "brand" : b.status === "paused" ? "warn" : "ok"}>{b.status === "running" ? "Собирается" : b.status === "paused" ? "Пауза" : "Собрана"}</Badge>
            {pill("Запланировано", b.planned)}
            {pill("Собрано", b.built, b.built ? "bg-ok-soft text-ok" : "bg-ink/5")}
            {pill("Ждут сборки", d.pending)}
            {pill("Не вышло", b.failed, b.failed ? "bg-brand-soft text-warn" : "bg-ink/5")}
            {pill("Опубликовано", d.published, d.published ? "bg-ok-soft text-ok" : "bg-ink/5")}
            {d.waiting ? pill("Ждут проверки", d.waiting, "bg-brand-soft text-warn") : null}
            {d.errors ? pill("Ошибки конвейера", d.errors, "bg-danger-soft text-danger") : null}
            {pill("Расход", fmtMoney(d.cost))}
            {admin && b.status !== "done" && (
              <ActionForm action={setCopyBatchStatus} className="inline" hidden={{ id: b.id, op: "cancel" }}>
                <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…">Отменить остаток</SubmitButton>
              </ActionForm>
            )}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 text-[13px]">
            <div>
              <div className="label">Квоты</div>
              <div className="text-muted">{Object.entries(quotas).map(([n, q]) => `${nicheLabel(n)}: ${Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${VOL_LABEL[k]} ${v}`).join(", ")}`).join(" · ") || "—"}</div>
            </div>
            <div>
              <div className="label">Сайты</div>
              <div className="text-muted">{d.sites.map((s) => `${s.name} (${s.items})`).join(", ")}</div>
            </div>
          </div>
          {b.note && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-brand-soft px-3 py-2 text-[12.5px] text-warn">{b.note}</pre>}
          <div className="mt-3 text-[13px]">
            <div className="label">Кластеры тем ({clusterRows.length}) · не больше {b.maxPerWord} тем с одним словом</div>
            <div className="flex flex-wrap gap-1.5">{clusterRows.map(([k, v]) => <span key={k} className="rounded-full bg-ink/5 px-2.5 py-1 text-[12.5px]">{k} <b className="tabular-nums">{v}</b></span>)}</div>
          </div>
          <p className="help mt-2">Собранные статьи дальше идут обычной очередью «Статей»: план → текст → публикация. Состояние каждой — в таблице ниже, обновляйте страницу.</p>
        </Card>

        <Card title="Темы партии" description="Порядок — порядок сборки. Частотность — Ads Manager (США) по ключам «Подбора ключей»; «—» — данных нет.">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Тема</th><th className="hidden md:table-cell">Ниша</th><th className="text-right">Частотность</th><th>Класс</th><th>Сайт</th><th>Состояние</th><th className="text-right">Расход</th></tr></thead>
              <tbody>
                {d.items.map((it) => (
                  <tr key={it.id}>
                    <td className="tabular-nums text-muted">{it.position}</td>
                    <td className="min-w-[200px]">
                      {it.articleId ? <Link href={`/pinterest/articles/articles/${it.articleId}`} className="font-medium hover:underline">{it.keyword ?? it.core}</Link> : <span className="font-medium">{it.core}</span>}
                      {it.keyword && <div className="help">{it.core}</div>}
                      {it.reason && <div className="help text-danger">{it.reason}</div>}
                    </td>
                    <td className="hidden md:table-cell text-muted">{nicheLabel(it.niche)}</td>
                    <td className="text-right tabular-nums">{fmtVolume(it.volume)}</td>
                    <td className="text-muted">{it.volClass ? VOL_LABEL[it.volClass] : "—"}</td>
                    <td>{it.site}</td>
                    <td className="text-[13px]">
                      {it.status === "pending" ? <span className="text-muted">ждёт сборки</span>
                        : it.status === "failed" ? <span className="text-danger">не собралась</span>
                        : !it.art ? <span className="text-muted">статья удалена</span>
                        : it.art.wpUrl && it.art.status === "COMPLETED" ? <a href={it.art.wpUrl} target="_blank" rel="noreferrer" className="text-ok hover:underline">Опубликована</a>
                        : <span title={it.art.error ?? undefined}>{statusLabel(it.art.status)}{it.art.status === "PENDING" || it.art.status === "RUNNING" ? ` · ${stageLabel(it.art.stage)}` : ""}</span>}
                    </td>
                    <td className="text-right tabular-nums text-muted">{it.art ? fmtMoney(it.art.costUsd) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
