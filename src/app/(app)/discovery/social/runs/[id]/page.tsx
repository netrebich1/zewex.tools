import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Field, PageHeader } from "@/components/ui";
import { Fold } from "@/components/ui/Fold";
import { SocialNav } from "@/components/social/SocialNav";
import { RunLive } from "@/components/social/RunLive";
import { PostEditor } from "@/components/social/PostEditor";
import { deleteSocialRun, retrySocialItems, saveSocialSchedule } from "@/actions/social";
import { metricoolHeader, requireRun } from "@/lib/social/runs";
import { slotFor } from "@/lib/social/metricool";
import { ITEM_STATUS_LABELS, networkOf, parseSettings, RUN_STATUS_LABELS, RUN_TONE, type SocialPosts } from "@/lib/social/types";
import { fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SocialRunPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const run = await requireRun(me, id).catch(() => null);
  if (!run) notFound();
  const s = parseSettings(run.settings);
  const items = await prisma.socialItem.findMany({ where: { runId: id }, orderBy: { position: "asc" } });
  const tpl = await metricoolHeader();
  const done = items.filter((i) => i.status === "done");
  const failed = items.filter((i) => i.status === "error");
  const postCount = (net: string) => done.filter((i) => { const p = ((i.posts ?? {}) as SocialPosts)[net as keyof SocialPosts]; return p && !p.skipped && p.text; }).length;
  const totalPosts = s.networks.reduce((a, n) => a + postCount(n), 0);
  const lastDay = items.length ? slotFor(items[items.length - 1].id, items.length - 1, s.networks[0], s).date : s.schedule.startDate;

  return (
    <>
      <SocialNav />
      <PageHeader
        title={run.name}
        back={{ href: "/discovery/social", label: "Прогоны" }}
        subtitle={<><Badge tone={RUN_TONE[run.status] ?? "neutral"}>{RUN_STATUS_LABELS[run.status] ?? run.status}</Badge> <span className="ml-2">статей {done.length}/{run.total} · постов {totalPosts} · расход {fmtMoney(run.costUsd)} · публикации {s.schedule.startDate} — {lastDay}</span></>}
      />
      <RunLive runId={run.id} />

      {failed.length > 0 && (
        <div className="mb-4">
          <Alert tone="warn">
            <div className="mb-2">Не получилось {failed.length} статей: {failed.slice(0, 3).map((f) => f.error).filter(Boolean).join("; ").slice(0, 300)}</div>
            <ActionForm action={retrySocialItems} hidden={{ runId: run.id }} className="">
              <SubmitButton className="btn-primary btn-sm" pendingText="Ставлю в очередь…">Повторить статьи с ошибкой</SubmitButton>
            </ActionForm>
          </Alert>
        </div>
      )}

      <Card title="Файлы для Metricool" description="В Metricool: Планировщик → Импорт CSV. Формат даты при импорте выберите YYYY-MM-DD, время 24 часа. В одном файле не больше 50 постов — так советует Metricool.">
        {!tpl.custom && (
          <div className="mb-3">
            <Alert tone="warn">Шаблон Metricool из вашего аккаунта ещё не загружен — колонки взяты из справки Metricool и могут отличаться порядком. Перед первым импортом <Link href="/discovery/social/settings" className="underline">загрузите шаблон</Link>.</Alert>
          </div>
        )}
        {totalPosts === 0 ? (
          <p className="help">Готовых постов пока нет.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <a href={`/api/social/export?run=${run.id}`} className="btn-brand">Скачать всё ({totalPosts})</a>
            {s.networks.map((n) => postCount(n) > 0 && (
              <a key={n} href={`/api/social/export?run=${run.id}&net=${n}`} className="btn-ghost">{networkOf(n)?.label} · {postCount(n)}</a>
            ))}
          </div>
        )}
      </Card>

      <div className="my-4">
        <Fold title="Расписание и бренд" summary={`с ${s.schedule.startDate}, ${s.schedule.perDay} статей в день, ${s.schedule.fromHour}:00–${s.schedule.toHour}:00${s.brand ? ` · бренд «${s.brand}»` : ""}${s.draft ? " · черновики" : ""}`}>
          <ActionForm action={saveSocialSchedule} hidden={{ runId: run.id }} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Первый день"><input name="startDate" type="date" defaultValue={s.schedule.startDate} className="input w-full" /></Field>
              <Field label="Статей в день"><input name="perDay" type="number" min={1} max={50} defaultValue={s.schedule.perDay} className="input w-full" /></Field>
              <Field label="С, час"><input name="fromHour" type="number" min={0} max={22} defaultValue={s.schedule.fromHour} className="input w-full" /></Field>
              <Field label="до, час"><input name="toHour" type="number" min={1} max={23} defaultValue={s.schedule.toHour} className="input w-full" /></Field>
              <div className="sm:col-span-2"><Field label="Бренд в Metricool"><input name="brand" defaultValue={s.brand} className="input w-full" maxLength={120} /></Field></div>
              <label className="flex items-center gap-2 sm:col-span-2 sm:mt-6"><input type="checkbox" name="draft" defaultChecked={s.draft} /> Импортировать черновиками</label>
            </div>
            <SubmitButton className="btn-primary btn-sm">Сохранить расписание</SubmitButton>
          </ActionForm>
        </Fold>
      </div>

      <div className="space-y-4">
        {items.map((it) => {
          const posts = (it.posts ?? {}) as SocialPosts;
          const first = slotFor(it.id, it.position, s.networks[0], s);
          return (
            <Card key={it.id} title={<span>{it.position + 1}. {it.title || it.url}</span>} description={<><a href={it.url} target="_blank" rel="noreferrer" className="underline break-all">{it.url}</a>{it.status === "done" ? ` · ${first.date} · фото в статье: ${it.imageCount}` : ""}</>} actions={it.status !== "done" ? <Badge tone={it.status === "error" ? "danger" : "neutral"}>{ITEM_STATUS_LABELS[it.status] ?? it.status}</Badge> : undefined}>
              {it.status === "error" && <Alert tone="danger">{it.error}</Alert>}
              {it.status === "done" && (
                <div className="grid gap-4 lg:grid-cols-2">
                  {s.networks.map((n) => {
                    const spec = networkOf(n)!;
                    const p = posts[n];
                    const slot = slotFor(it.id, it.position, n, s);
                    return (
                      <div key={n} className="rounded-xl border border-line p-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="font-semibold text-[14px]">{spec.label}</span>
                          {p && !p.skipped && <span className="text-muted">{slot.time.slice(0, 5)} · {p.video ? `видео ${p.durationSec ?? "?"} с` : `фото ${p.images.length}`}</span>}
                          {p?.trimmed && <Badge tone="warn">обрезан по лимиту</Badge>}
                          {p?.edited && <Badge tone="neutral">правка</Badge>}
                        </div>
                        {!p ? <p className="help">Модель не вернула пост для этой сети — повторите статью.</p> : p.skipped ? <p className="help">Пропущено: {p.skipped}.</p> : (
                          <>
                            <PostEditor runId={run.id} itemId={it.id} net={n} label={spec.label} text={p.text} maxChars={spec.maxChars} isX={n === "x"} />
                            {p.video && (
                              <div className="mt-2 flex flex-wrap items-start gap-3">
                                <video src={p.images[0]} poster={p.poster} controls preload="none" className="h-64 rounded-lg bg-black" />
                                <div className="min-w-0 flex-1 text-[13px]">
                                  {n === "yt_short" && p.title && <div className="mb-1"><span className="text-muted">Заголовок:</span> {p.title}</div>}
                                  {p.script && <ol className="list-decimal space-y-0.5 pl-4 text-muted">{p.script.map((sc, i) => <li key={i} title={`Голос: ${sc.voice}`}>{sc.text}</li>)}</ol>}
                                  <a href={p.images[0]} download className="mt-1 inline-block underline">Скачать mp4</a>
                                </div>
                              </div>
                            )}
                            {!p.video && p.images.length > 0 && (
                              <div className="mt-2 flex gap-1.5 overflow-x-auto">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {p.images.map((u) => <img key={u} src={u} alt="" loading="lazy" className="h-14 w-14 shrink-0 rounded-md object-cover" />)}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {(it.status === "done" || it.status === "error") && (
                <ActionForm action={retrySocialItems} hidden={{ runId: run.id, item: it.id }} className="mt-3">
                  <SubmitButton className="btn-ghost btn-sm" pendingText="В очередь…" confirm={it.status === "done" ? "Написать посты этой статьи заново? Текущие тексты и правки будут заменены." : undefined}>Написать заново</SubmitButton>
                </ActionForm>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-6">
        <ActionForm action={deleteSocialRun} hidden={{ id: run.id }} className="">
          <SubmitButton className="btn-danger btn-sm" confirm="Удалить прогон со всеми постами? Вернуть будет нельзя.">Удалить прогон</SubmitButton>
        </ActionForm>
      </div>
    </>
  );
}
