import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteArticleAction, requeueArticleAction, retryArticleAction, saveArticleMeta, saveSectionHtml, stopArticleAction } from "@/actions/articles";
import { canAccessArticle } from "@/lib/articles/access";
import { STATUS_LABELS } from "@/lib/articles/labels";
import { stageLabel, stagesFor } from "@/lib/articles/stages";
import { PUBLISH_MODES, type ArticleFacts, type ArticleRecipeSnapshot } from "@/lib/articles/types";
import { publicUrl } from "@/lib/articles/storage";
import { articleUsage } from "@/lib/articles/queries";
import { StatusBadge } from "@/components/articles/StatusBadge";
import { ArticleTimeline } from "@/components/articles/ArticleTimeline";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["photos", "Фото"], ["text", "Текст"], ["publish", "Публикация"], ["log", "Журнал"]] as const;
type Tab = (typeof TABS)[number][0];

/** Карточка статьи: шапка, действия, таймлайн этапов и вкладки Фото / Текст / Публикация / Журнал. */
export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = (TABS.some(([k]) => k === sp(q, "tab")) ? sp(q, "tab") : "photos") as Tab;
  if (!(await canAccessArticle(me, id))) notFound();
  const a = await prisma.article.findUnique({
    where: { id },
    include: { site: { select: { id: true, name: true, wpCategories: true, accessId: true } }, run: { select: { id: true, name: true } }, recipeRef: { select: { id: true, name: true } }, stageLogs: { orderBy: { startedAt: "asc" } } },
  });
  if (!a) notFound();
  const facts = (a.facts as ArticleFacts | null) ?? {};
  const snapshot = a.recipe as unknown as ArticleRecipeSnapshot;
  const keywordRu = a.keywordRu || facts.keywordRu || "";
  const st = STATUS_LABELS[a.status];
  const stages = stagesFor(a.format);
  const retryDefault = a.errorStage && stages.includes(a.errorStage as (typeof stages)[number]) ? a.errorStage : a.stage === "done" ? "publish" : a.stage;
  const running = a.status === "RUNNING";
  const modeLabel = PUBLISH_MODES.find((m) => m.value === a.publishMode)?.label ?? a.publishMode;
  const back = a.runId ? `/pinterest/articles/runs/${a.runId}` : `/pinterest/articles/sites/${a.siteId}?tab=queue`;

  return (
    <>
      <PageHeader back={{ href: back, label: a.run?.name || a.site.name }} title={a.keyword}
        subtitle={<>{keywordRu && <span className="text-ink-2">{keywordRu} · </span>}<Link href={`/pinterest/articles/sites/${a.site.id}`} className="underline">{a.site.name}</Link> · {a.recipeRef?.name ?? snapshot?.name ?? "сценарий"} · {a.photoCount} фото · {a.photoReview ? "модерация фото до текста" : "без модерации фото"} · {modeLabel} · расход ${a.costUsd.toFixed(2)}</>}
        actions={a.wpUrl ? <a href={a.wpUrl} target="_blank" rel="noreferrer" className="btn-ghost">Открыть на сайте ↗</a> : undefined} />

      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={a.status} />
            <span className="text-[14px]">{a.stage === "done" ? "Конвейер пройден" : <>Этап: <b>{stageLabel(a.stage)}</b>{a.status === "PENDING" ? " (ждёт воркера)" : running ? " (выполняется)" : ""}</>}</span>
            {a.attempts > 1 && <Badge tone="warn">попытка {a.attempts}</Badge>}
            {a.stopRequested && <Badge tone="warn">запрошена остановка</Badge>}
            <span className="ml-auto help">создана {fmtDate(a.createdAt)}{a.publishedAt ? ` · опубликована ${fmtDate(a.publishedAt)}` : ""}</span>
          </div>
          <p className="help mt-1.5">{st.help}</p>
          {a.note && <p className="mt-2 text-[13.5px] text-ink-2">{a.note}</p>}
          {a.error && <div className="mt-3"><Alert tone="danger"><b>{a.errorStage ? `${stageLabel(a.errorStage)}: ` : ""}</b>{a.error}</Alert></div>}
          {a.status === "PHOTO_REVIEW" && <div className="mt-3"><Alert tone="warn">Статья ждёт модерации фото. <Link href={`/pinterest/articles/moderation/articles?article=${a.id}`} className="underline">Открыть в модерации фото →</Link></Alert></div>}
          {(a.status === "REVIEW_PENDING" || a.status === "NEEDS_REWORK") && <div className="mt-3"><Alert tone="warn">Статья ждёт модерации перед публикацией. <Link href={`/pinterest/articles/moderation/articles?article=${a.id}`} className="underline">Открыть в модерации статей →</Link></Alert></div>}
          {a.status === "INSUFFICIENT_PHOTOS" && a.insufficientReason && <div className="mt-3"><Alert tone="danger">Мало фото: {a.insufficientReason}</Alert></div>}
        </Card>

        <Card title="Действия" description="«Повторить этап» ставит статью в очередь с выбранного этапа (сделанное раньше сохраняется). «В очередь» — продолжить с текущего этапа. Пока статья выполняется, сначала нажмите «Остановить».">
          <div className="flex flex-wrap items-end gap-2">
            <ActionForm action={retryArticleAction} hidden={{ id }} className="flex flex-wrap items-end gap-2">
              <Field label="С какого этапа">
                <select name="stage" className="input py-2" defaultValue={retryDefault} disabled={running}>
                  {stages.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
                </select>
              </Field>
              <SubmitButton className="btn-primary" pendingText="…">Повторить этап</SubmitButton>
            </ActionForm>
            <ActionForm action={stopArticleAction} hidden={{ id }} className="inline"><SubmitButton className="btn-ghost" pendingText="…">Остановить</SubmitButton></ActionForm>
            <ActionForm action={requeueArticleAction} hidden={{ id }} className="inline"><SubmitButton className="btn-ghost" pendingText="…">В очередь</SubmitButton></ActionForm>
            <details className="ml-auto">
              <summary className="btn-danger cursor-pointer list-none">Удалить</summary>
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-danger-soft p-3 text-[13.5px] text-danger">
                Удалить статью вместе с фото, текстами и журналом? Пост на сайте (если есть) останется.
                <ActionForm action={deleteArticleAction} hidden={{ id, back }} className="inline"><SubmitButton className="btn-danger btn-sm" pendingText="…">Да, удалить</SubmitButton></ActionForm>
              </div>
            </details>
          </div>
        </Card>

        <Card title="Этапы" description="Что уже сделано, сколько заняло и стоило. Ошибки — красным; подробности каждого этапа раскрываются.">
          <ArticleTimeline logs={a.stageLogs} />
        </Card>

        <div className="flex flex-wrap gap-2">
          {TABS.map(([k, l]) => <Link key={k} href={`/pinterest/articles/articles/${id}?tab=${k}`} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}
        </div>

        {tab === "photos" && <PhotosTab articleId={id} />}
        {tab === "text" && <TextTab a={{ id, h1: a.h1, metaTitle: a.metaTitle, metaDescription: a.metaDescription, slug: a.slug, introHtml: a.introHtml, outroHtml: a.outroHtml, html: a.html, running }} />}
        {tab === "publish" && (
          <Card title="Публикация">
            <dl className="grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2">
              <div className="flex justify-between gap-3"><dt className="text-muted">Режим</dt><dd>{modeLabel}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Категория</dt><dd>{categoryName(a.site.wpCategories, a.wpCategoryId)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Пост WordPress</dt><dd>{a.wpPostId ? `#${a.wpPostId}${a.wpStatus ? ` · ${a.wpStatus === "publish" ? "опубликован" : a.wpStatus === "draft" ? "черновик" : a.wpStatus}` : ""}` : "ещё не создан"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Ссылка</dt><dd className="truncate max-w-[320px]">{a.wpUrl ? <a href={a.wpUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">{a.wpUrl}</a> : "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Попыток публикации</dt><dd>{a.publishAttempts}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Опубликована</dt><dd>{a.publishedAt ? fmtDate(a.publishedAt) : "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Адрес (slug)</dt><dd className="mono min-w-0 text-right [overflow-wrap:anywhere]">{a.slug || "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Файлы на сервере</dt><dd>{a.purgedAt ? `хранятся, отклонённые кандидаты удалены ${fmtDate(a.purgedAt)}` : "хранятся"}</dd></div>
              {a.sheetRow != null && (
                <div className="flex justify-between gap-3"><dt className="text-muted">Google Таблица</dt>
                  <dd className={`min-w-0 text-right [overflow-wrap:anywhere] ${a.sheetSyncState === "error" ? "text-danger" : ""}`} title={a.sheetSyncError ?? undefined}>
                    строка {a.sheetRow}{a.sheetTab ? ` · ${a.sheetTab}` : ""} · {a.sheetSyncState === "ok" ? "отчёт записан" : a.sheetSyncState === "error" ? `отчёт не записан: ${a.sheetSyncError ?? "ошибка"}` : "отчёт запишется после публикации"}
                  </dd>
                </div>
              )}
            </dl>
            {(a.status === "PUBLISH_ERROR" || a.errorStage === "publish") && a.error && <div className="mt-3"><Alert tone="danger">{a.error}</Alert></div>}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ActionForm action={retryArticleAction} hidden={{ id, stage: "publish" }} className="inline">
                <SubmitButton className="btn-primary" pendingText="…">Опубликовать повторно</SubmitButton>
              </ActionForm>
              <span className="help">Статья встанет в очередь на этап «Публикация». Если пост уже создан, он будет обновлён, а не продублирован.</span>
            </div>
          </Card>
        )}
        {tab === "log" && <LogTab articleId={id} />}
      </div>
    </>
  );
}

function categoryName(cats: unknown, id: number | null): string {
  if (!id) return "не выбрана";
  const list = Array.isArray(cats) ? (cats as Array<{ id: number; name: string }>) : [];
  return list.find((c) => c.id === id)?.name ?? `#${id}`;
}

const thumb = (p: { thumbPath: string; path: string; wpUrl?: string | null; thumbUrl?: string }) => (p.thumbPath ? publicUrl(p.thumbPath) : p.path ? publicUrl(p.path) : p.wpUrl || p.thumbUrl || "");

async function PhotosTab({ articleId }: { articleId: string }) {
  const [photos, reserve] = await Promise.all([
    prisma.artPhoto.findMany({ where: { articleId }, orderBy: { position: "asc" } }),
    prisma.artPhotoCandidate.findMany({ where: { articleId, status: { in: ["reserve", "keep"] } }, orderBy: [{ aiScore: "desc" }], take: 60 }),
  ]);
  const active = photos.filter((p) => !p.excluded);
  const excluded = photos.filter((p) => p.excluded);
  return (
    <div className="space-y-4">
      <Card title={`В статье · ${active.length}`} description="По позициям: одна позиция — одна секция. Балл — оценка vision-модели 1–10, источник — домен страницы, где кадр найден.">
        {active.length === 0 ? <p className="help">Фото ещё не отобраны.</p> : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {active.map((p) => (
              <figure key={p.id} className="rounded-xl border border-line p-1.5">
                {thumb(p) ? <a href={p.path ? publicUrl(p.path) : p.wpUrl || p.sourceUrl} target="_blank" rel="noreferrer"><img src={thumb(p)} alt={p.altText} loading="lazy" className="aspect-[3/4] w-full rounded-lg object-cover" /></a> : <div className="aspect-[3/4] w-full rounded-lg bg-ink/5" />}
                <figcaption className="mt-1 text-[11.5px] leading-tight">
                  <div className="flex items-center justify-between"><b>#{p.position}</b>{p.aiScore != null && <span title="Балл vision-оценки">★ {p.aiScore.toFixed(1)}</span>}</div>
                  <div className="truncate text-muted" title={p.sourcePageUrl}>{p.sourceDomain || "—"}</div>
                  {p.width && p.height && <div className="text-muted">{p.width}×{p.height}{p.wpMediaId ? " · в WP" : ""}</div>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
      {excluded.length > 0 && (
        <Card title={`Исключены модератором · ${excluded.length}`}>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-10 opacity-70">
            {excluded.map((p) => <figure key={p.id}>{thumb(p) ? <img src={thumb(p)} alt="" loading="lazy" className="aspect-[3/4] w-full rounded-lg object-cover" /> : <div className="aspect-[3/4] rounded-lg bg-ink/5" />}<figcaption className="help truncate">#{p.position}{p.excludedByAi ? " · ИИ" : ""}</figcaption></figure>)}
          </div>
        </Card>
      )}
      <Card title={`Резерв · ${reserve.length}`} description="Кандидаты, прошедшие оценку, но не вошедшие в статью. В модерации фото их можно добавить вместо слабых кадров.">
        {reserve.length === 0 ? <p className="help">Резерва нет.</p> : (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-10">
            {reserve.map((c) => (
              <figure key={c.id} className="rounded-lg border border-line p-1">
                {thumb(c) ? <img src={thumb(c)} alt="" loading="lazy" className="aspect-[3/4] w-full rounded-md object-cover" /> : <div className="aspect-[3/4] rounded-md bg-ink/5" />}
                <figcaption className="help truncate" title={c.pageUrl}>{c.aiScore != null ? `★ ${c.aiScore.toFixed(1)} · ` : ""}{c.domain || "—"}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

async function TextTab({ a }: { a: { id: string; h1: string; metaTitle: string; metaDescription: string; slug: string; introHtml: string | null; outroHtml: string | null; html: string | null; running: boolean } }) {
  const [sections, photos] = await Promise.all([
    prisma.artSection.findMany({ where: { articleId: a.id }, orderBy: { position: "asc" } }),
    prisma.artPhoto.findMany({ where: { articleId: a.id }, select: { id: true, thumbPath: true, path: true, position: true } }),
  ]);
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const words = sections.reduce((n, s) => n + s.wordCount, 0);
  const secStatus = (s: string) => (s === "written" ? { label: "написана", tone: "ok" as const } : s === "failed" ? { label: "ошибка", tone: "danger" as const } : { label: "в плане", tone: "neutral" as const });
  return (
    <div className="space-y-4">
      <Card title="Мета" description="H1, title, description и адрес. Правки сохраняются в статью; если статья уже собрана, пересоберите HTML (Повторить этап → Сборка HTML) или опубликуйте повторно.">
        <ActionForm action={saveArticleMeta} hidden={{ id: a.id }} className="space-y-3">
          <fieldset disabled={a.running} className="space-y-3 disabled:opacity-60">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`H1 · ${a.h1.length} симв.`}><input name="h1" className="input" defaultValue={a.h1} /></Field>
              <Field label={`Title · ${a.metaTitle.length} симв.`} hint="Лучше до 60 символов."><input name="metaTitle" className="input" defaultValue={a.metaTitle} /></Field>
            </div>
            <Field label={`Description · ${a.metaDescription.length} симв.`} hint="Лучше 120–160 символов."><textarea name="metaDescription" className="input" rows={2} defaultValue={a.metaDescription} /></Field>
            <Field label="Адрес (slug)" hint="Латиница, цифры и дефисы."><input name="slug" className="input mono" defaultValue={a.slug} /></Field>
            <SubmitButton pendingText="Сохраняю…">Сохранить мету</SubmitButton>
          </fieldset>
        </ActionForm>
      </Card>

      <Card title={`Секции · ${sections.length}`} description={`Слов в секциях: ${words}. Каждая секция привязана к фото; раскройте секцию, чтобы поправить заголовок или HTML.`}>
        {a.introHtml && <section className="mb-3 rounded-xl border border-line p-3"><div className="text-[12.5px] font-semibold text-muted mb-1">Вступление</div><div className="prose-sm max-w-none text-[14px] leading-relaxed [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: a.introHtml }} /></section>}
        {sections.length === 0 ? <p className="help">Секций ещё нет: план появится после этапа «План по фото».</p> : (
          <ol className="space-y-2">
            {sections.map((s) => {
              const p = s.photoId ? photoById.get(s.photoId) : null;
              const ss = secStatus(s.status);
              return (
                <li key={s.id} className="rounded-xl border border-line">
                  <details>
                    <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 list-none">
                      {p && thumb(p) ? <img src={thumb(p)} alt="" className="h-12 w-9 rounded object-cover" loading="lazy" /> : <div className="h-12 w-9 rounded bg-ink/5" />}
                      <div className="min-w-0 flex-1"><div className="truncate font-medium">{s.position === 0 ? "Вступление" : s.position >= 9990 ? "Заключение" : `${s.position}. `}{s.heading || <span className="text-muted">без заголовка</span>}</div><div className="help">{s.wordCount} слов{s.error ? ` · ${s.error}` : ""}</div></div>
                      <Badge tone={ss.tone}>{ss.label}</Badge>
                    </summary>
                    <div className="border-t border-line p-3 space-y-3">
                      {s.html && <div className="text-[14px] leading-relaxed [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: s.html }} />}
                      <ActionForm action={saveSectionHtml} hidden={{ sectionId: s.id }} className="space-y-2">
                        <fieldset disabled={a.running} className="space-y-2 disabled:opacity-60">
                          <Field label="Заголовок H2"><input name="heading" className="input" defaultValue={s.heading} /></Field>
                          <Field label="HTML секции"><textarea name="html" className="input mono" rows={6} defaultValue={s.html ?? ""} /></Field>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить секцию</SubmitButton>
                        </fieldset>
                      </ActionForm>
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        )}
        {a.outroHtml && <section className="mt-3 rounded-xl border border-line p-3"><div className="text-[12.5px] font-semibold text-muted mb-1">Заключение</div><div className="text-[14px] leading-relaxed [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: a.outroHtml }} /></section>}
      </Card>

      {a.html && (
        <Card title="Собранный HTML" description="Так статья уходит в WordPress.">
          <details><summary className="help cursor-pointer">Показать HTML ({Math.round(a.html.length / 1024)} КБ)</summary><pre className="mono mt-2 max-h-[480px] overflow-auto rounded-lg bg-surface-2 p-3 text-[11.5px] whitespace-pre-wrap break-words">{a.html}</pre></details>
        </Card>
      )}
    </div>
  );
}

async function LogTab({ articleId }: { articleId: string }) {
  const [usage, errors] = await Promise.all([articleUsage(articleId), prisma.artError.findMany({ where: { articleId }, orderBy: { createdAt: "desc" }, take: 100 })]);
  const total = usage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
  return (
    <div className="space-y-4">
      <Card title={`Вызовы ИИ · ${usage.length}`} description={`Расход по журналу портала: $${total.toFixed(3)}. Ключ выбирается правилами портала для автора запуска.`}>
        {usage.length === 0 ? <p className="help">Вызовов ещё не было.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Когда</th><th>Слот</th><th className="hidden md:table-cell">Провайдер · модель</th><th className="hidden sm:table-cell text-right">Токены</th><th className="text-right">Стоимость</th><th className="hidden sm:table-cell text-right">Время</th><th>Итог</th></tr></thead>
            <tbody>{usage.map((u) => (
              <tr key={u.id}>
                <td className="text-muted whitespace-nowrap">{fmtDate(u.createdAt)}</td>
                <td>{u.slot?.name ?? u.slot?.key ?? "—"}</td>
                <td className="hidden md:table-cell text-muted">{u.provider.name}{u.model ? ` · ${u.model.name || u.model.modelId}` : ""}</td>
                <td className="hidden sm:table-cell text-right tabular-nums text-muted">{u.inputTokens || u.outputTokens ? `${u.inputTokens} / ${u.outputTokens}` : "—"}</td>
                <td className="text-right tabular-nums">{u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : "—"}</td>
                <td className="hidden sm:table-cell text-right tabular-nums text-muted">{u.durationMs ? `${(u.durationMs / 1000).toFixed(1)} с` : "—"}</td>
                <td>
                  {u.ok ? (
                    <Badge tone="ok">ок</Badge>
                  ) : u.error ? (
                    // текст ошибки по нажатию: title на телефоне не виден
                    <details title={u.error}>
                      <summary className="cursor-pointer list-none"><Badge tone="danger">ошибка</Badge></summary>
                      <div className="help mt-1 max-w-xs [overflow-wrap:anywhere]">{u.error}</div>
                    </details>
                  ) : (
                    <Badge tone="danger">ошибка</Badge>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={`Ошибки · ${errors.length}`}>
        {errors.length === 0 ? <p className="help">Ошибок не записано.</p> : (
          <ul className="space-y-2">{errors.map((e) => <li key={e.id} className="rounded-lg border border-line p-2.5 text-[13.5px]"><div className="flex flex-wrap items-center gap-2"><b>{stageLabel(e.stage)}</b><span className="help">{fmtDate(e.createdAt)}</span>{e.resolvedAt && <Badge tone="ok">устранено</Badge>}</div><div className="mt-1 text-danger break-words">{e.message}</div></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
