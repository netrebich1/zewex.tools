import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { approvePostAction, deletePostAction, excludeSlotPhoto, requeuePostAction, retryPostAction, reworkPostAction, saveBlogSectionHtml, savePostMeta, savePostParts, saveSlotQuery, setPostVideo, stopPostAction, swapSlotPhoto } from "@/actions/blog";
import type { BlogVideoState } from "@/lib/blog/video";
import { canAccessBlogPost } from "@/lib/blog/access";
import { STATUS_LABELS } from "@/lib/blog/labels";
import { BLOG_STAGES, stageLabel } from "@/lib/blog/stages";
import { PUBLISH_MODES, REVIEW_MODES, type BlogBrief, type BlogOutline, type BlogRecipeSnapshot } from "@/lib/blog/types";
import { blockOf } from "@/lib/blog/blocks";
import { publicUrl } from "@/lib/blog/storage";
import { postUsage } from "@/lib/blog/queries";
import { StatusBadge } from "@/components/blog/StatusBadge";
import { PostTimeline } from "@/components/blog/PostTimeline";
import { AutoRefresh } from "@/components/blog/AutoRefresh";
import { ClipReveal } from "@/components/blog/ClipReveal";
import { More } from "@/components/ui/Fold";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["plan", "План"], ["photos", "Фото"], ["text", "Текст"], ["preview", "Предпросмотр"], ["publish", "Публикация"], ["log", "Журнал"]] as const;
type Tab = (typeof TABS)[number][0];

/** Карточка инфо-статьи: шапка, действия, таймлайн и вкладки План / Фото / Текст / Предпросмотр / Публикация / Журнал. */
export default async function BlogPostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  if (!(await canAccessBlogPost(me, id))) notFound();
  const a = await prisma.blogPost.findUnique({ where: { id }, include: { site: { select: { id: true, name: true, wpCategories: true, settings: true } }, run: { select: { id: true, name: true } }, recipeRef: { select: { id: true, name: true } }, stageLogs: { orderBy: { startedAt: "asc" } } } });
  if (!a) notFound();
  const defaultTab: Tab = a.html ? "preview" : a.outline ? (a.stage === "write" || a.stage === "wrap" || a.stage === "meta" ? "text" : "photos") : "plan";
  const tab = (TABS.some(([k]) => k === sp(q, "tab")) ? sp(q, "tab") : defaultTab) as Tab;
  const snapshot = a.recipe as unknown as BlogRecipeSnapshot;
  const st = STATUS_LABELS[a.status];
  const running = a.status === "RUNNING";
  const retryDefault = a.errorStage && (BLOG_STAGES as readonly string[]).includes(a.errorStage) ? a.errorStage : a.stage === "done" ? "publish" : a.stage;
  const back = a.runId ? `/pinterest/blog/runs/${a.runId}` : `/pinterest/blog/sites/${a.siteId}?tab=queue`;
  const waiting = a.status === "REVIEW_PENDING" || a.status === "NEEDS_REWORK";

  return (
    <>
      <AutoRefresh enabled={running || a.status === "PENDING" || a.status === "PUBLISHING"} everyMs={12_000} />
      <PageHeader back={{ href: back, label: a.run?.name || a.site.name }} title={a.keyword}
        subtitle={<><Link href={`/pinterest/blog/sites/${a.site.id}`} className="underline">{a.site.name}</Link> · {a.recipeRef?.name ?? snapshot?.name ?? "сценарий"}{a.topic ? <> · тема «{a.topic}»</> : null}{a.sheetRow ? <> · <span title={a.sheetSyncError ?? undefined}>таблица: строка {a.sheetRow}{a.sheetTab ? ` «${a.sheetTab}»` : ""}{a.sheetSyncState === "error" ? " — отчёт не записан" : ""}</span></> : null}{snapshot?.scenario ? <> · <span title={snapshot.scenario.reason}>тип «{snapshot.scenario.label}»{snapshot.scenario.n ? `, ${snapshot.scenario.n} пунктов` : ""}</span></> : null} · {REVIEW_MODES.find((m) => m.value === snapshot?.run?.review)?.label ?? ""} · {PUBLISH_MODES.find((m) => m.value === snapshot?.run?.publishMode)?.label ?? ""} · расход ${a.costUsd.toFixed(3)}</>}
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
          {waiting && <div className="mt-3"><Alert tone="warn">Статья ждёт проверки. Посмотрите предпросмотр, при необходимости замените фото или поправьте текст, затем «Одобрить и опубликовать» или «В доработку» — кнопки ниже.</Alert></div>}
        </Card>

        <Card title="Действия">
          <More short="«Повторить этап» — заново с выбранного этапа." className="-mt-2 mb-3">Статья встаёт в очередь с выбранного этапа, сделанное раньше сохраняется. Пока статья выполняется, сначала нажмите «Остановить».</More>
          <div className="flex flex-wrap items-end gap-2">
            {(waiting || a.status === "FAILED" || a.status === "PUBLISH_ERROR" || a.status === "STOPPED") && a.html && (
              <ActionForm action={approvePostAction} hidden={{ id }} className="inline"><SubmitButton className="btn-brand" pendingText="…">Одобрить и опубликовать</SubmitButton></ActionForm>
            )}
            <ActionForm action={retryPostAction} hidden={{ id }} className="flex flex-wrap items-end gap-2">
              <Field label="С какого этапа"><select name="stage" className="input py-2" defaultValue={retryDefault} disabled={running}>{BLOG_STAGES.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}</select></Field>
              <SubmitButton className="btn-primary" pendingText="…">Повторить этап</SubmitButton>
            </ActionForm>
            <ActionForm action={stopPostAction} hidden={{ id }} className="inline"><SubmitButton className="btn-ghost" pendingText="…">Остановить</SubmitButton></ActionForm>
            <ActionForm action={requeuePostAction} hidden={{ id }} className="inline"><SubmitButton className="btn-ghost" pendingText="…">В очередь</SubmitButton></ActionForm>
            <details className="ml-auto">
              <summary className="btn-danger cursor-pointer list-none">Удалить</summary>
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-danger-soft p-3 text-[13.5px] text-danger">Удалить статью вместе с фото, текстами и журналом? Пост на сайте (если есть) останется.<ActionForm action={deletePostAction} hidden={{ id, back }} className="inline"><SubmitButton className="btn-danger btn-sm" pendingText="…">Да, удалить</SubmitButton></ActionForm></div>
            </details>
          </div>
          {!running && a.outline && (
            <ActionForm action={reworkPostAction} hidden={{ id }} className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line p-3">
              <Field label="В доработку" hint="Текст заново — те же план и фото; план заново — всё с нуля (фото тоже).">
                <select name="what" className="input py-2"><option value="write">переписать текст</option><option value="outline">новый план, фото и текст</option></select>
              </Field>
              <Field label="Замечание (попадёт в заметку статьи)"><input name="note" className="input py-2" placeholder="например: слишком общо, нужны конкретные шаги" /></Field>
              <SubmitButton className="btn-ghost" pendingText="…">Отправить в доработку</SubmitButton>
            </ActionForm>
          )}
        </Card>

        <Card title="Этапы" description="Что уже сделано, сколько заняло и стоило."><PostTimeline logs={a.stageLogs} /></Card>

        <div className="flex flex-wrap gap-2">{TABS.map(([k, l]) => <Link key={k} href={`/pinterest/blog/posts/${id}?tab=${k}`} className={`badge px-3 py-1 max-sm:!py-1.5 max-sm:min-h-8 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}</div>

        {tab === "plan" && <PlanTab brief={(a.brief as BlogBrief | null) ?? null} outline={(a.outline as BlogOutline | null) ?? null} />}
        {tab === "photos" && <VideoCard postId={id} video={(a.video ?? null) as BlogVideoState | null} running={running} />}
        {tab === "photos" && <PhotosTab postId={id} running={running} />}
        {tab === "text" && <TextTab a={{ id, h1: a.h1, metaTitle: a.metaTitle, metaDescription: a.metaDescription, slug: a.slug, introHtml: a.introHtml, takeawaysHtml: a.takeawaysHtml, conclusionHtml: a.conclusionHtml, disclaimerHtml: a.disclaimerHtml, faq: a.faq, running }} />}
        {tab === "preview" && (
          <Card title="Предпросмотр" description="Так статья уходит в WordPress (стили темы сайта не учитываются).">
            {a.html ? <ClipReveal label="Показать статью целиком"><article className="zx-preview prose max-w-none text-[15px] leading-relaxed [&_h2]:mt-7 [&_h2]:text-[1.35em] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_img]:my-3 [&_img]:max-w-full sm:[&_img]:max-w-[480px] [&_img]:h-auto [&_figure]:max-w-full [&_img]:rounded-xl [&_table]:my-4 [&_table]:block [&_table]:overflow-x-auto [&_script]:hidden" dangerouslySetInnerHTML={{ __html: previewHtml(a.html) }} /></ClipReveal> : <p className="help">HTML ещё не собран: появится после этапа «Сборка HTML».</p>}
            {a.html && <details className="mt-4"><summary className="help cursor-pointer">Показать HTML ({Math.round(a.html.length / 1024)} КБ)</summary><pre className="mono mt-2 max-h-[480px] overflow-auto rounded-lg bg-surface-2 p-3 text-[11.5px] whitespace-pre-wrap break-words">{a.html}</pre></details>}
          </Card>
        )}
        {tab === "publish" && (
          <Card title="Публикация">
            <dl className="grid gap-x-6 gap-y-1.5 text-[14px] sm:grid-cols-2">
              <div className="flex justify-between gap-3"><dt className="text-muted">Категория</dt><dd>{categoryName(a.site.wpCategories, a.wpCategoryId)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Пост WordPress</dt><dd>{a.wpPostId ? `#${a.wpPostId}${a.wpStatus ? ` · ${a.wpStatus === "publish" ? "опубликован" : a.wpStatus === "draft" ? "черновик" : a.wpStatus}` : ""}` : "ещё не создан"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Ссылка</dt><dd className="truncate max-w-[320px]">{a.wpUrl ? <a href={a.wpUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">{a.wpUrl}</a> : "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Попыток публикации</dt><dd>{a.publishAttempts}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Адрес (slug)</dt><dd className="mono min-w-0 text-right [overflow-wrap:anywhere]">{a.slug || "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Слов в статье</dt><dd>{a.wordCount || "—"}</dd></div>
            </dl>
            {(a.status === "PUBLISH_ERROR" || a.errorStage === "publish") && a.error && <div className="mt-3"><Alert tone="danger">{a.error}</Alert></div>}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ActionForm action={retryPostAction} hidden={{ id, stage: "publish" }} className="inline"><SubmitButton className="btn-primary" pendingText="…">Опубликовать повторно</SubmitButton></ActionForm>
              <span className="help">Если пост уже создан, он будет обновлён, а не продублирован.</span>
            </div>
          </Card>
        )}
        {tab === "log" && <LogTab postId={id} />}
      </div>
    </>
  );
}

function categoryName(cats: unknown, id: number | null): string {
  if (!id) return "не выбрана";
  const list = Array.isArray(cats) ? (cats as Array<{ id: number; name: string }>) : [];
  return list.find((c) => c.id === id)?.name ?? `#${id}`;
}

function PlanTab({ brief, outline }: { brief: BlogBrief | null; outline: BlogOutline | null }) {
  return (
    <div className="space-y-4">
      <Card title="Исследование" description="Бриф знаний, по которому пишется статья: интент, аудитория, факты, безопасность, вопросы.">
        {!brief ? <p className="help">Исследование ещё не выполнено.</p> : (
          <div className="space-y-2 text-[14px]">
            <div className="flex flex-wrap gap-1.5"><Badge>{brief.intent}</Badge><Badge>{brief.topicDomain}</Badge>{brief.ymyl && <Badge tone="warn">YMYL: осторожные формулировки</Badge>}</div>
            <p className="text-ink-2">{brief.audience}</p>
            <p>{brief.summary}</p>
            <details><summary className="help cursor-pointer">Факты ({brief.facts.length}), правила, ошибки, вопросы</summary>
              <ul className="mt-2 list-disc pl-5 text-[13.5px]">{brief.facts.map((f, i) => <li key={i}>{f.text} <span className="text-muted">[{f.confidence}]</span></li>)}</ul>
              {brief.dos.length > 0 && <p className="mt-2"><b>Делать:</b> {brief.dos.join("; ")}</p>}
              {brief.donts.length > 0 && <p><b>Не делать:</b> {brief.donts.join("; ")}</p>}
              {brief.mistakes.length > 0 && <p><b>Ошибки:</b> {brief.mistakes.join("; ")}</p>}
              {brief.safety.length > 0 && <p><b>Безопасность:</b> {brief.safety.join("; ")}</p>}
              {brief.questions.length > 0 && <p><b>Вопросы читателей:</b> {brief.questions.join(" · ")}</p>}
              {brief.serp?.questions?.length ? <p><b>People Also Ask:</b> {brief.serp.questions.join(" · ")}</p> : null}
            </details>
          </div>
        )}
      </Card>
      <Card title="План" description="Структура из блоков, выбранная по теме; слоты картинок с поисковыми запросами.">
        {!outline ? <p className="help">План ещё не составлен.</p> : (
          <div className="space-y-2 text-[14px]">
            <p><b>H1:</b> {outline.h1} <span className="help">· ~{outline.targetWords} слов{outline.takeaways ? " · выводы" : ""}{outline.faq.enabled ? ` · FAQ ${outline.faq.count}` : ""}{outline.disclaimer ? " · дисклеймер" : ""}</span></p>
            <p className="help">Главное фото: «{outline.hero.query}»{outline.closingImage ? ` · последнее фото: «${outline.closingImage.query}»` : ""}</p>
            <ol className="space-y-1.5 list-decimal pl-5">{outline.sections.map((s) => (
              <li key={s.position}><b>{s.heading}</b> <Badge>{blockOf(s.kind).label}</Badge> <span className="help">~{s.targetWords} слов{s.image ? ` · фото: «${s.image.query}»` : ""}</span>
                {s.keyPoints.length > 0 && <ul className="list-disc pl-5 text-[13px] text-ink-2">{s.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>}
              </li>
            ))}</ol>
            {outline.faq.enabled && outline.faq.questions.length > 0 && <p className="help">FAQ: {outline.faq.questions.slice(0, outline.faq.count).join(" · ")}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Только для предпросмотра: WordPress разворачивает [caption]…[/caption] сам, в портале показываем как figure. */
function previewHtml(html: string): string {
  return html.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, (_m, inner: string) => {
    const img = inner.match(/<img[^>]*>/)?.[0] ?? "";
    const rest = inner.replace(img, "").trim();
    return `<figure style="margin:16px auto;text-align:center">${img}${rest ? `<figcaption style="font-size:12px;color:#888;margin-top:4px">${rest}</figcaption>` : ""}</figure>`;
  });
}

const thumb = (p: { thumbPath: string; path: string; wpUrl?: string | null; thumbUrl?: string }) => (p.thumbPath ? publicUrl(p.thumbPath) : p.path ? publicUrl(p.path) : p.wpUrl || p.thumbUrl || "");

function VideoCard({ postId, video, running }: { postId: string; video: BlogVideoState | null; running: boolean }) {
  if (!video) return null;
  const c = video.chosen;
  return (
    <Card title="Видео YouTube" description={`${video.videoFirst ? "Статья по видео" : "Вставка видео"} · проверено по субтитрам · $${video.costUsd}${video.note ? ` · ${video.note}` : ""}`} className="mb-4">
      {c ? (
        <div className="grid gap-3 sm:grid-cols-[240px_1fr]">
          <a href={`https://www.youtube.com/watch?v=${c.id}&t=${c.judge?.startAt ?? 0}s`} target="_blank" rel="noreferrer"><img src={c.thumbnail} alt="" className="w-full rounded-lg" /></a>
          <div className="text-[13.5px] space-y-1">
            <div><b>{c.title}</b> · {c.channel}</div>
            <div className="text-muted">{Math.round(c.sec / 60)} мин · {c.views.toLocaleString("ru-RU")} просмотров · старт {c.judge?.startAt ?? 0} с · релевантность {c.judge?.relevance}/10 · качество {c.judge?.quality}/10</div>
            <div>{c.judge?.why}</div>
            {!running && <ActionForm action={setPostVideo} hidden={{ postId, videoId: "" }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">Убрать видео</SubmitButton></ActionForm>}
          </div>
        </div>
      ) : <p className="help">Видео в статье нет.</p>}
      {video.candidates.length > 0 && (
        <details className="mt-3"><summary className="help cursor-pointer">Кандидаты ({video.candidates.length})</summary>
          <ul className="mt-2 space-y-1 text-[13px]">
            {video.candidates.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <a className="underline" href={`https://www.youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer">{v.title}</a>
                <span className="text-muted">{v.channel} · {v.decision === "embed" ? "подходит" : `нет: ${v.reason ?? "—"}`}{v.judge?.redFlags?.length ? ` · флаги: ${v.judge.redFlags.join(", ")}` : ""}</span>
                {!running && v.decision === "embed" && v.id !== c?.id && <ActionForm action={setPostVideo} hidden={{ postId, videoId: v.id }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">Поставить</SubmitButton></ActionForm>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

async function PhotosTab({ postId, running }: { postId: string; running: boolean }) {
  const [slots, photos, reserve] = await Promise.all([
    prisma.blogImageSlot.findMany({ where: { postId }, orderBy: { createdAt: "asc" } }),
    prisma.blogPhoto.findMany({ where: { postId }, orderBy: { position: "asc" } }),
    prisma.blogPhotoCandidate.findMany({ where: { postId, status: { in: ["reserve", "keep"] } }, orderBy: [{ aiScore: "desc" }], take: 120 }),
  ]);
  if (!slots.length) return <Card title="Фото"><p className="help">Слоты картинок появятся после этапа «План».</p></Card>;
  const photoBySlot = new Map(photos.filter((p) => !p.excluded).map((p) => [p.slotKey, p]));
  const aiPhotos = photos.filter((p) => p.aiGenerated && !p.excluded);
  return (
    <div className="space-y-4">
      {aiPhotos.length > 0 && (
        <Card title="ИИ-картинки шагов" description="gpt-image-2, номера шагов нарисованы поверх; стоят в конце своей секции.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {aiPhotos.map((p) => (
              <figure key={p.id} className="rounded-xl border border-line p-1.5">
                <a href={publicUrl(p.overlayPath || p.path)} target="_blank" rel="noreferrer"><img src={publicUrl(p.path)} alt={p.altText} loading="lazy" className="w-full rounded-lg" /></a>
                <figcaption className="mt-1 text-[11.5px] leading-tight text-muted">Секция {p.slotKey.replace(/^ai/, "")}{p.overlayPath ? " · с плашкой" : ""}</figcaption>
                {!running && <ActionForm action={excludeSlotPhoto} hidden={{ photoId: p.id }} className="mt-1"><SubmitButton className="btn-ghost btn-sm" pendingText="…">Убрать из статьи</SubmitButton></ActionForm>}
              </figure>
            ))}
          </div>
        </Card>
      )}
      {slots.map((s) => {
        const p = photoBySlot.get(s.key);
        const res = reserve.filter((c) => c.slotId === s.id).slice(0, 12);
        return (
          <Card key={s.id} title={`${s.key === "hero" ? "Главное фото" : s.key === "closing" ? "Последнее фото" : `Секция ${s.sectionPosition}`} · ${s.key}`} description={`Запрос: «${s.query}»${s.mustShow ? ` · должно быть видно: ${s.mustShow}` : ""} · поисков ${s.searches} · ${s.status}`}>
            <div className="grid gap-4 md:grid-cols-[200px_1fr]">
              <div className="max-w-[180px] md:max-w-none">
                {p && thumb(p) ? (
                  <figure className="rounded-xl border border-line p-1.5"><a href={p.path ? publicUrl(p.path) : p.wpUrl || p.sourceUrl} target="_blank" rel="noreferrer"><img src={thumb(p)} alt={p.altText} loading="lazy" className="w-full rounded-lg object-cover aspect-[3/4]" /></a>
                    <figcaption className="mt-1 text-[11.5px] leading-tight"><div className="flex items-center justify-between"><b>#{p.position}</b>{p.aiScore != null && <span>★ {p.aiScore.toFixed(1)}</span>}</div><div className="truncate text-muted" title={p.sourcePageUrl}>{p.sourceDomain || "—"}</div>{p.width && p.height && <div className="text-muted">{p.width}×{p.height}{p.wpMediaId ? " · в WP" : ""}</div>}</figcaption>
                  </figure>
                ) : <div className="aspect-[3/4] w-full rounded-lg bg-ink/5 flex items-center justify-center help">нет фото</div>}
                {p?.overlayPath && (
                  <figure className="mt-2 rounded-xl border border-line p-1.5"><a href={publicUrl(p.overlayPath)} target="_blank" rel="noreferrer"><img src={publicUrl(p.overlayPath)} alt="" loading="lazy" className="w-full rounded-lg" /></a>
                    <figcaption className="mt-1 text-[11.5px] leading-tight text-muted">С текстом: «{String((p.overlayText as { title?: string } | null)?.title ?? "")}»{p.overlayWpMediaId ? " · в WP" : ""}</figcaption>
                  </figure>
                )}
                {p && s.key !== "hero" && !running && <ActionForm action={excludeSlotPhoto} hidden={{ photoId: p.id }} className="mt-2"><SubmitButton className="btn-ghost btn-sm" pendingText="…">Убрать из статьи</SubmitButton></ActionForm>}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-[12.5px] font-semibold text-muted mb-1">Резерв — нажмите, чтобы поставить вместо текущего</div>
                  {res.length === 0 ? <p className="help">Резерва нет. Измените запрос ниже и повторите этап «Поиск фото».</p> : (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {res.map((c) => (
                        <ActionForm key={c.id} action={swapSlotPhoto} hidden={{ candidateId: c.id }} className="rounded-lg border border-line p-1">
                          {thumb(c) ? <img src={thumb(c)} alt="" loading="lazy" className="aspect-[3/4] w-full rounded-md object-cover" /> : <div className="aspect-[3/4] rounded-md bg-ink/5" />}
                          <div className="help truncate" title={`${c.aiDescription ?? ""} · ${c.pageUrl ?? ""}`}>{c.aiScore != null ? `★ ${c.aiScore.toFixed(1)} · ` : ""}{c.domain || "—"}</div>
                          <SubmitButton className="btn-ghost btn-sm w-full mt-1 max-sm:!px-1 max-sm:!text-[12px]" pendingText="…">Поставить</SubmitButton>
                        </ActionForm>
                      ))}
                    </div>
                  )}
                </div>
                <details><summary className="help cursor-pointer">Изменить запрос слота</summary>
                  <ActionForm action={saveSlotQuery} hidden={{ slotId: s.id }} className="mt-2 grid gap-2 sm:grid-cols-2">
                    <fieldset disabled={running} className="contents">
                      <Field label="Запрос Google Images"><input name="query" className="input py-1.5" defaultValue={s.query} /></Field>
                      <Field label="Запасной запрос"><input name="altQuery" className="input py-1.5" defaultValue={s.altQuery ?? ""} /></Field>
                      <Field label="Должно быть видно"><input name="mustShow" className="input py-1.5" defaultValue={s.mustShow ?? ""} /></Field>
                      <Field label="Чего не должно быть"><input name="avoid" className="input py-1.5" defaultValue={s.avoid ?? ""} /></Field>
                      <div className="sm:col-span-2"><SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить и сбросить поиск</SubmitButton></div>
                    </fieldset>
                  </ActionForm>
                </details>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

type PartsProps = { id: string; h1: string; metaTitle: string; metaDescription: string; slug: string; introHtml: string | null; takeawaysHtml: string | null; conclusionHtml: string | null; disclaimerHtml: string | null; faq: unknown; running: boolean };

async function TextTab({ a }: { a: PartsProps }) {
  const sections = await prisma.blogSection.findMany({ where: { postId: a.id }, orderBy: { position: "asc" } });
  const words = sections.reduce((n, s) => n + s.wordCount, 0);
  const faq = Array.isArray(a.faq) ? (a.faq as Array<{ question: string; answer: string }>) : [];
  const secStatus = (s: string) => (s === "written" ? { label: "написана", tone: "ok" as const } : s === "failed" ? { label: "ошибка", tone: "danger" as const } : { label: "в плане", tone: "neutral" as const });
  return (
    <div className="space-y-4">
      <Card title="Мета" description="H1, title, description и адрес. Правки сохраняются в статью; чтобы они попали в HTML — пересоберите (Повторить этап → Сборка HTML).">
        <ActionForm action={savePostMeta} hidden={{ id: a.id }} className="space-y-3">
          <fieldset disabled={a.running} className="space-y-3 disabled:opacity-60">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`H1 · ${a.h1.length} симв.`}><input name="h1" className="input" defaultValue={a.h1} /></Field>
              <Field label={`Title · ${a.metaTitle.length} симв.`} hint="Лучше до 60 символов."><input name="metaTitle" className="input" defaultValue={a.metaTitle} /></Field>
            </div>
            <Field label={`Description · ${a.metaDescription.length} симв.`} hint="Лучше 140–160 символов."><textarea name="metaDescription" className="input" rows={2} defaultValue={a.metaDescription} /></Field>
            <Field label="Адрес (slug)"><input name="slug" className="input mono" defaultValue={a.slug} /></Field>
            <SubmitButton pendingText="Сохраняю…">Сохранить мету</SubmitButton>
          </fieldset>
        </ActionForm>
      </Card>
      <Card title="Вступление, выводы, заключение, дисклеймер" description="HTML (абзацы <p>, списки <ul>). Пусто — блока в статье не будет.">
        <ActionForm action={savePostParts} hidden={{ id: a.id }} className="space-y-3">
          <fieldset disabled={a.running} className="space-y-3 disabled:opacity-60">
            <Field label="Вступление"><textarea name="introHtml" className="input mono" rows={4} defaultValue={a.introHtml ?? ""} /></Field>
            <Field label="Ключевые выводы (<ul>)"><textarea name="takeawaysHtml" className="input mono" rows={3} defaultValue={a.takeawaysHtml ?? ""} /></Field>
            <Field label="Заключение"><textarea name="conclusionHtml" className="input mono" rows={4} defaultValue={a.conclusionHtml ?? ""} /></Field>
            <Field label="Дисклеймер"><textarea name="disclaimerHtml" className="input mono" rows={2} defaultValue={a.disclaimerHtml ?? ""} /></Field>
            <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
          </fieldset>
        </ActionForm>
        {faq.length > 0 && <div className="mt-3"><div className="text-[12.5px] font-semibold text-muted mb-1">FAQ ({faq.length})</div><ul className="space-y-1 text-[14px]">{faq.map((f, i) => <li key={i}><b>{f.question}</b><div className="text-ink-2 [&_p]:inline" dangerouslySetInnerHTML={{ __html: f.answer }} /></li>)}</ul></div>}
      </Card>
      <Card title={`Секции · ${sections.length}`} description={`Слов в секциях: ${words}. Раскройте секцию, чтобы поправить заголовок или HTML.`}>
        {sections.length === 0 ? <p className="help">Секций ещё нет: появятся после этапа «План».</p> : (
          <ol className="space-y-2">{sections.map((s) => { const ss = secStatus(s.status); return (
            <li key={s.id} className="rounded-xl border border-line"><details>
              <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 list-none"><div className="min-w-0 flex-1"><div className="truncate font-medium">{s.position}. {s.heading || <span className="text-muted">без заголовка</span>} <Badge>{blockOf(s.kind).label}</Badge></div><div className="help">{s.wordCount} слов{s.slotKey ? " · с фото" : ""}{s.error ? ` · ${s.error}` : ""}</div></div><Badge tone={ss.tone}>{ss.label}</Badge></summary>
              <div className="border-t border-line p-3 space-y-3">
                {s.html && <div className="text-[14px] leading-relaxed [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:my-2 [&_th]:text-left [&_th]:pr-3 [&_td]:pr-3" dangerouslySetInnerHTML={{ __html: s.html }} />}
                <ActionForm action={saveBlogSectionHtml} hidden={{ sectionId: s.id }} className="space-y-2">
                  <fieldset disabled={a.running} className="space-y-2 disabled:opacity-60">
                    <Field label="Заголовок H2"><input name="heading" className="input" defaultValue={s.heading} /></Field>
                    <Field label="HTML секции"><textarea name="html" className="input mono" rows={8} defaultValue={s.html ?? ""} /></Field>
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить секцию</SubmitButton>
                  </fieldset>
                </ActionForm>
              </div>
            </details></li>
          ); })}</ol>
        )}
      </Card>
    </div>
  );
}

async function LogTab({ postId }: { postId: string }) {
  const [usage, errors] = await Promise.all([postUsage(postId), prisma.blogError.findMany({ where: { postId }, orderBy: { createdAt: "desc" }, take: 100 })]);
  const total = usage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
  return (
    <div className="space-y-4">
      <Card title={`Вызовы ИИ · ${usage.length}`} description={`Расход по журналу портала: $${total.toFixed(4)}.`}>
        {usage.length === 0 ? <p className="help">Вызовов ещё не было.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Когда</th><th>Слот</th><th className="hidden md:table-cell">Провайдер · модель</th><th className="hidden sm:table-cell text-right">Токены</th><th className="text-right">Стоимость</th><th className="hidden sm:table-cell text-right">Время</th><th>Итог</th></tr></thead>
            <tbody>{usage.map((u) => (
              <tr key={u.id}><td className="text-muted whitespace-nowrap">{fmtDate(u.createdAt)}</td><td>{u.slot?.name ?? u.slot?.key ?? "—"}</td><td className="hidden md:table-cell text-muted">{u.provider.name}{u.model ? ` · ${u.model.name || u.model.modelId}` : ""}</td><td className="hidden sm:table-cell text-right tabular-nums text-muted">{u.inputTokens || u.outputTokens ? `${u.inputTokens} / ${u.outputTokens}` : "—"}</td><td className="text-right tabular-nums">{u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : "—"}</td><td className="hidden sm:table-cell text-right tabular-nums text-muted">{u.durationMs ? `${(u.durationMs / 1000).toFixed(1)} с` : "—"}</td><td>{u.ok ? <Badge tone="ok">ок</Badge> : <span title={u.error ?? ""}><Badge tone="danger">ошибка</Badge></span>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={`Ошибки · ${errors.length}`}>
        {errors.length === 0 ? <p className="help">Ошибок не записано.</p> : <ul className="space-y-2">{errors.map((e) => <li key={e.id} className="rounded-lg border border-line p-2.5 text-[13.5px]"><div className="flex flex-wrap items-center gap-2"><b>{stageLabel(e.stage)}</b><span className="help">{fmtDate(e.createdAt)}</span></div><div className="mt-1 text-danger break-words">{e.message}</div></li>)}</ul>}
      </Card>
    </div>
  );
}
