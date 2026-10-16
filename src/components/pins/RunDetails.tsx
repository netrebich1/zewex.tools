import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty } from "@/components/ui";
import { publicUrl } from "@/lib/pins/storage";
import { ENGINE_LABELS, STAGE_LABELS } from "@/components/pins/labels";
import { fmtDate } from "@/lib/utils";
import type { PinStage } from "@/lib/pins/types";

const PAGE_SIZE = 20;

const itemTone = (status: string, moderation: string) =>
  status === "ERROR" ? "danger" : moderation === "REJECTED" ? "warn" : status === "READY" ? "ok" : "neutral";
const itemLabel = (status: string, moderation: string) =>
  status === "ERROR" ? "ошибка" : status === "REMOVED" ? "убран" : status === "POOL" ? "резерв" : moderation === "REJECTED" ? "отклонён" : moderation === "APPROVED" ? "одобрен" : status === "READY" ? "готов" : "в работе";

/** Вкладка «Страницы и пины»: статьи прогона и все их пины — картинка, тип, состояние, тексты, доска, дата. */
export async function RunPins({ runId, page }: { runId: string; page: number }) {
  const total = await prisma.pinRunPage.count({ where: { runId } });
  const pages = await prisma.pinRunPage.findMany({
    where: { runId }, orderBy: { sortOrder: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE,
    include: { items: { where: { kind: "pin", status: { not: "REMOVED" } }, orderBy: { sortOrder: "asc" } } },
  });
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const nav = total > PAGE_SIZE && (
    <div className="flex items-center gap-2 text-[13px]">
      {page > 1 && <Link href={`?tab=pins&page=${page - 1}`} className="btn-ghost btn-sm">← Назад</Link>}
      <span className="help">страницы {(page - 1) * PAGE_SIZE + 1}–{Math.min(total, page * PAGE_SIZE)} из {total}</span>
      {page < last && <Link href={`?tab=pins&page=${page + 1}`} className="btn-ghost btn-sm">Дальше →</Link>}
    </div>
  );
  if (!total) return <Empty title="Страниц в прогоне нет" />;
  return (
    <div className="space-y-4">
      {nav}
      {pages.map((p) => (
        <Card key={p.id} title={<a href={p.url} target="_blank" rel="noreferrer" className="hover:underline">{p.pageTitle || p.url}</a>} description={`${p.keyword ? `ключ: ${p.keyword} · ` : ""}${p.topic ? `тема: ${p.topic} · ` : ""}${p.niche ? `ниша: ${p.niche} · ` : ""}фото: ${p.imageCount} (в разделах ${p.sectionImageCount}) · доски: ${((p.boards as string[]) ?? []).join(", ") || "—"}${p.status === "error" ? ` · ОШИБКА: ${p.error ?? ""}` : ""}`}>
          {p.items.length === 0 ? <p className="help">Пинов для этой статьи ещё нет.</p> : (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
              {p.items.map((it) => {
                const img = it.thumbPath || it.imagePath ? publicUrl(it.thumbPath || it.imagePath) : it.engine === "PHOTO" ? it.sourceImageUrl : "";
                return (
                  <div key={it.id} className={`rounded-xl border p-2 space-y-1.5 text-[12px] ${it.status === "ERROR" ? "border-danger/40" : it.moderation === "REJECTED" ? "border-warn/50 opacity-70" : "border-line"}`}>
                    {img ? <img src={img} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-lg bg-ink/5" /> : <div className="w-full aspect-[2/3] rounded-lg bg-ink/5 flex items-center justify-center text-muted">нет картинки</div>}
                    <div className="flex items-center gap-1 flex-wrap"><Badge>{ENGINE_LABELS[it.engine] ?? it.engine}</Badge><Badge tone={itemTone(it.status, it.moderation)}>{itemLabel(it.status, it.moderation)}</Badge></div>
                    {it.title && <div className="font-medium leading-snug line-clamp-2" title={it.title}>{it.title}</div>}
                    {it.description && <div className="text-muted leading-snug line-clamp-3" title={it.description}>{it.description}</div>}
                    <div className="text-muted">{it.boardName && <span>доска: {it.boardName} · </span>}{it.scheduledAt ? fmtDate(it.scheduledAt) : "без даты"}</div>
                    {it.wpMediaUrl && <a href={it.wpMediaUrl} target="_blank" rel="noreferrer" className="underline text-muted">в медиатеке WP</a>}
                    {it.error && <div className="text-danger leading-snug line-clamp-3" title={it.error}>{it.errorStage ? `${it.errorStage}: ` : ""}{it.error}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ))}
      {nav}
    </div>
  );
}

/** Вкладка «Расписание»: пины по дням с временем, доской и заголовком. */
export async function RunSchedule({ runId }: { runId: string }) {
  const items = await prisma.pinRunItem.findMany({
    where: { runId, kind: "pin", scheduledAt: { not: null }, status: { not: "REMOVED" }, moderation: { not: "REJECTED" } },
    orderBy: { scheduledAt: "asc" }, select: { id: true, scheduledAt: true, boardName: true, title: true, engine: true, targetLink: true, page: { select: { keyword: true } } },
  });
  if (!items.length) return <Empty title="Расписания ещё нет" hint="Даты появятся после этапа «расписание»." />;
  const byDay = new Map<string, typeof items>();
  for (const it of items) { const k = it.scheduledAt!.toISOString().slice(0, 10); byDay.set(k, [...(byDay.get(k) ?? []), it]); }
  return (
    <Card title="Пины по дням" description={`Всего запланировано ${items.length} пинов на ${byDay.size} дней: с ${[...byDay.keys()][0]} по ${[...byDay.keys()].at(-1)}.`}>
      <div className="space-y-2">
        {[...byDay.entries()].map(([day, list]) => (
          <details key={day} className="rounded-xl border border-line px-3 py-2">
            <summary className="cursor-pointer flex items-center gap-3 text-[14px]"><b>{day}</b><span className="help">{list.length} пинов</span></summary>
            <table className="table mt-2"><tbody>
              {list.map((it) => <tr key={it.id}><td className="text-muted whitespace-nowrap">{it.scheduledAt!.toISOString().slice(11, 16)}</td><td>{ENGINE_LABELS[it.engine] ?? it.engine}</td><td className="truncate max-w-[360px]">{it.title || it.page.keyword}</td><td className="text-muted">{it.boardName}</td></tr>)}
            </tbody></table>
          </details>
        ))}
      </div>
    </Card>
  );
}

/** Вкладка «Журнал»: все задачи воркера по этапам — когда начались, сколько сделали, чем закончились. */
export async function RunLog({ runId }: { runId: string }) {
  const jobs = await prisma.pinJob.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
  if (!jobs.length) return <Empty title="Задач ещё не было" />;
  const dur = (a: Date | null, b: Date | null) => (a && b ? `${Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000))} с` : "");
  return (
    <Card title="Журнал этапов" description="Каждая строка — задача воркера. Ошибка задачи означает остановку прогона на этом этапе.">
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Этап</th><th>Состояние</th><th>Сделано</th><th>Начало</th><th>Длительность</th><th>Попытки</th><th>Ошибка</th></tr></thead>
        <tbody>{jobs.map((j) => (
          <tr key={j.id}>
            <td className="font-medium">{STAGE_LABELS[j.stage as PinStage] ?? j.stage}</td>
            <td><Badge tone={j.status === "DONE" ? "ok" : j.status === "ERROR" ? "danger" : j.status === "RUNNING" ? "brand" : "neutral"}>{j.status.toLowerCase()}</Badge></td>
            <td className="text-muted">{j.total ? `${j.done}/${j.total}` : j.done || ""} {j.label && <span className="help">{j.label}</span>}</td>
            <td className="text-muted whitespace-nowrap">{fmtDate(j.startedAt ?? j.createdAt)}</td>
            <td className="text-muted">{dur(j.startedAt, j.finishedAt)}</td>
            <td className="text-muted">{j.attempts}</td>
            <td className="text-danger max-w-[420px] truncate" title={j.error ?? ""}>{j.error ?? ""}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}
