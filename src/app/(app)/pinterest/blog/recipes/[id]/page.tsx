import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { RecipePromptEditor } from "@/components/blog/RecipePromptEditor";
import { copyBlogRecipe, deleteBlogRecipe, restoreBlogVersion, saveBlogPhotoSearch, saveBlogRecipeMain } from "@/actions/blogRecipes";
import { POPULAR_MODELS, recipeReadiness, recipeShape, userSlots } from "@/lib/blog/recipes";
import { hasPrompt } from "@/lib/blog/prompts";
import { STAGE_VARS, VAR_HINTS, promptSteps } from "@/lib/blog/stages";
import { BLOCKS } from "@/lib/blog/blocks";
import { ACTIVE_STATUSES, PUBLISH_MODES, TRI_OPTIONS, VOICES } from "@/lib/blog/types";
import { RATE_SYSTEM } from "@/lib/blog/photo/ratePrompt";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["main", "Основное"], ["prompts", "Промты"], ["search", "Поиск фото"], ["history", "История"]] as const;
const SEARCH_OPTIONS = {
  source: [["dataforseo", "DataForSEO"], ["serpapi", "SerpAPI"]],
  freshness: [["any", "Любая"], ["y", "За год"], ["m", "За месяц"], ["w", "За неделю"]],
  imageType: [["photo", "Только фото"], ["any", "Любые изображения"]],
  orientation: [["tall", "Вертикальные"], ["square", "Квадратные"], ["wide", "Горизонтальные"]],
  uniqueMode: [["soft", "Мягко (сначала свежие)"], ["strict", "Строго (не брать повторы)"], ["off", "Не учитывать"]],
  captionMode: [["domain_link", "Домен со ссылкой"], ["domain", "Только домен"], ["none", "Без подписи"]],
} as const;

export default async function BlogRecipePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = TABS.find(([k]) => k === sp(q, "tab"))?.[0] ?? "main";
  const r = await prisma.blogRecipe.findUnique({ where: { id } });
  if (!r) notFound();
  const shape = recipeShape(r);
  const [active, have] = await Promise.all([prisma.blogPost.count({ where: { recipeId: id, status: { in: ACTIVE_STATUSES } } }), userSlots(me)]);
  const ready = recipeReadiness(shape, have);
  const steps = promptSteps();
  const href = (t: string, extra = "") => `/pinterest/blog/recipes/${id}?tab=${t}${extra}`;
  const stageKey = steps.find((s) => s.key === sp(q, "stage"))?.key ?? steps[0]?.key ?? "";
  const step = steps.find((s) => s.key === stageKey);
  const history = tab === "history" ? await prisma.blogRecipeVersion.findMany({ where: { recipeId: id }, orderBy: { version: "desc" }, take: 100 }) : [];
  const authors = history.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(history.map((h) => h.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }) : [];
  const p = shape.params;
  const ps = shape.photoSearch;

  return (
    <>
      <PageHeader back={{ href: "/pinterest/blog/recipes", label: "Рецепты" }} title={`${r.number != null ? `№${r.number} · ` : ""}${r.name}`}
        subtitle={<span className="inline-flex flex-wrap items-center gap-1.5">{r.isDefault && <Badge tone="brand">по умолчанию</Badge>}{!r.isActive && <Badge>выключен</Badge>}{ready.ok ? <Badge tone="ok">готов</Badge> : <Badge tone="danger">не готов: {[...ready.missingPrompts, ...ready.missingSlots].join(", ")}</Badge>}{active > 0 && <Badge tone="brand">статей в работе: {active}</Badge>}</span>}
        actions={<><ActionForm action={copyBlogRecipe} hidden={{ id }} className="inline"><SubmitButton className="btn-ghost" pendingText="Копирую…">Копировать</SubmitButton></ActionForm>{me.role === "ADMIN" && <ActionForm action={deleteBlogRecipe} hidden={{ id }} className="inline"><SubmitButton className="btn-danger" pendingText="Удаляю…" confirm={`Удалить рецепт «${r.name}»?`}>Удалить</SubmitButton></ActionForm>}</>} />
      <div className="mb-4 flex flex-wrap gap-2">{TABS.map(([k, l]) => <Link key={k} href={href(k)} className={`tab ${tab === k ? "active" : ""}`}>{l}</Link>)}</div>

      {tab === "main" && (
        <ActionForm action={saveBlogRecipeMain} hidden={{ id }} className="space-y-4">
          <Card title="Основное">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Название"><input name="name" className="input" defaultValue={r.name} required /></Field>
              <Field label="Описание"><input name="description" className="input" defaultValue={r.description ?? ""} /></Field>
              <div className="flex flex-col gap-2 sm:col-span-2">
                <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="isDefault" defaultChecked={r.isDefault} /> рецепт по умолчанию</label>
                <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="isActive" defaultChecked={r.isActive} /> доступен для запуска</label>
              </div>
            </div>
          </Card>
          <Card title="Структура статьи" description="Границы, внутри которых план выбирает структуру по теме. Каталог блоков — ниже.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Объём, слов: от"><input name="lengthMin" type="number" min={300} max={6000} className="input" defaultValue={p.length.min} /></Field>
              <Field label="до"><input name="lengthMax" type="number" min={300} max={6000} className="input" defaultValue={p.length.max} /></Field>
              <Field label="Картинок: от" hint="Главное фото всегда считается."><input name="imagesMin" type="number" min={1} max={12} className="input" defaultValue={p.images.min} /></Field>
              <Field label="до"><input name="imagesMax" type="number" min={1} max={12} className="input" defaultValue={p.images.max} /></Field>
              <Field label="Ориентация главного фото"><select name="heroOrientation" className="input" defaultValue={p.images.heroOrientation}><option value="tall">Вертикальная (Pinterest)</option><option value="square">Квадратная</option><option value="any">Любая</option></select></Field>
              <Field label="Голос автора"><select name="voice" className="input" defaultValue={p.voice}>{VOICES.map((v) => <option key={v.value} value={v.value} title={v.help}>{v.label}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="Персона автора" hint="Кто пишет: роль и характер, для голоса от первого лица."><input name="persona" className="input" defaultValue={p.persona} /></Field></div>
              <Field label="Ключевые выводы после вступления"><select name="blockTakeaways" className="input" defaultValue={p.blocks.takeaways}>{TRI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
              <Field label="FAQ"><select name="blockFaq" className="input" defaultValue={p.blocks.faq}>{TRI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
              <Field label="Дисклеймер (health/money)"><select name="blockDisclaimer" className="input" defaultValue={p.blocks.disclaimer}>{TRI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
              <Field label="Последняя картинка"><select name="blockClosing" className="input" defaultValue={p.blocks.closingImage}>{TRI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
              <Field label="Текст на фото (как Canvas-пин)" hint="Плашка сверху или снизу, фото не обрезается."><select name="overlayMode" className="input" defaultValue={p.overlay.mode}><option value="article">В статье и в пине</option><option value="pin_only">Только в пине при сохранении</option><option value="off">Не делать</option></select></Field>
              <Field label="На каких фото"><select name="overlayPhotos" className="input" defaultValue={p.overlay.photos}><option value="all">На всех</option><option value="hero">Только на главном</option></select></Field>
              <Field label="ИИ-картинка шагов" hint="gpt-image-2 в секциях-инструкциях (≥3 шагов), реальные фото остаются."><select name="aiImagesMode" className="input" defaultValue={p.aiImages.mode}><option value="off">Не делать</option><option value="steps">Где есть пошаговая инструкция</option></select></Field>
              <Field label="ИИ-картинок на статью, до"><input name="aiImagesMax" type="number" min={1} max={4} className="input" defaultValue={p.aiImages.max} /></Field>
              <Field label="Качество ИИ-картинки"><select name="aiImagesQuality" className="input" defaultValue={p.aiImages.quality}><option value="low">low (~$0.02)</option><option value="medium">medium (~$0.06)</option><option value="high">high (~$0.25)</option></select></Field>
              <Field label="Вопросов FAQ: от"><input name="faqMin" type="number" min={2} max={10} className="input" defaultValue={p.faqCount.min} /></Field>
              <Field label="до"><input name="faqMax" type="number" min={2} max={10} className="input" defaultValue={p.faqCount.max} /></Field>
              <Field label="Язык"><input name="language" className="input mono" defaultValue={p.language} maxLength={5} /></Field>
              <Field label="Страна аудитории"><input name="country" className="input mono" defaultValue={p.country} maxLength={2} /></Field>
              <Field label="Внешние ссылки"><select name="linksMode" className="input" defaultValue={p.links.mode}><option value="none">Не ставить</option><option value="allowlist">Только на домены из списка (nofollow)</option></select></Field>
              <div className="sm:col-span-3"><Field label="Разрешённые домены источников" hint="Через запятую или с новой строки: mayoclinic.org, aad.org…"><textarea name="linksAllow" className="input mono" rows={2} defaultValue={p.links.allow.join("\n")} /></Field></div>
              <label className="inline-flex items-center gap-2 text-[14px] sm:col-span-2"><input type="checkbox" name="researchSerp" defaultChecked={p.research.serp} /> брать People Also Ask и заголовки топа из SerpAPI (слот «Выдача Google»)</label>
            </div>
            <details className="mt-4"><summary className="help cursor-pointer">Каталог блоков, из которых план собирает структуру</summary>
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 text-[13px]">{BLOCKS.map((b) => <li key={b.kind} className="rounded-lg border border-line p-2"><b>{b.label}</b> <span className="mono text-muted">{b.kind}</span><div className="help">{b.describe}</div></li>)}</ul>
            </details>
          </Card>
          <Card title="Публикация" description="Режим по умолчанию для запусков с этим рецептом; сайт и запуск могут переопределить.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Режим публикации"><select name="publishMode" className="input" defaultValue={shape.publish.mode}>{PUBLISH_MODES.map((m) => <option key={m.value} value={m.value} title={m.help}>{m.label}</option>)}</select></Field>
              <Field label="Доля статей с годом в URL, %"><input name="seoYearUrlPercent" type="number" min={0} max={100} step={5} className="input" defaultValue={shape.publish.seoYearUrlPercent} /></Field>
              <Field label="JSON-LD (Article, FAQ, HowTo)" hint="Вставляется в текст записи; если тема WordPress вырезает script — выключите."><select name="schema" className="input" defaultValue={shape.publish.schema}><option value="inline">Вставлять</option><option value="off">Не вставлять</option></select></Field>
            </div>
          </Card>
          <div className="flex flex-wrap items-end gap-3"><Field label="Что изменили (в историю версий)"><input name="changeSummary" className="input" placeholder="например: объём 1200–2000" /></Field><SubmitButton pendingText="Сохраняю…">Сохранить рецепт</SubmitButton></div>
        </ActionForm>
      )}

      {tab === "prompts" && (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card className="lg:sticky lg:top-4 self-start">
            <h3 className="h2 mb-2">Шаги</h3>
            <ul className="space-y-0.5">{steps.map((s) => {
              const ok = hasPrompt(shape.prompts[s.key]);
              return (
                <li key={s.key}><Link href={href("prompts", `&stage=${encodeURIComponent(s.key)}`)} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] ${stageKey === s.key ? "bg-ink text-bg" : "hover:bg-ink/5"}`}>
                  <span className={`mt-1 inline-block h-2.5 w-2.5 rounded-full shrink-0 ${ok ? "bg-ok" : s.required ? "bg-danger" : "bg-line-2"}`} />
                  <span className="min-w-0"><span className="block truncate font-medium">{s.label}</span><span className={`block truncate text-[11.5px] ${stageKey === s.key ? "text-bg/70" : "text-muted"}`}>{s.stageLabel}{shape.models[s.key] ? ` · ${shape.models[s.key].split(":").pop()}` : ""}</span></span>
                </Link></li>
              );
            })}</ul>
          </Card>
          <Card>
            {step ? <RecipePromptEditor key={stageKey} recipeId={id} stageKey={stageKey} label={step.label} required={step.required} system={shape.prompts[stageKey]?.system ?? ""} text={shape.prompts[stageKey]?.text ?? ""} model={shape.models[stageKey] ?? ""} vars={STAGE_VARS[stageKey] ?? []} hints={VAR_HINTS} popularModels={POPULAR_MODELS} builtIn={stageKey === "photo_rate" ? RATE_SYSTEM : undefined} /> : <p className="help">Нет шагов.</p>}
          </Card>
        </div>
      )}

      {tab === "search" && (
        <ActionForm action={saveBlogPhotoSearch} hidden={{ id }} className="space-y-4">
          <Card title="Источник и фильтры" description="Как ищутся реальные фото в Google Images под каждый слот статьи.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Источник" hint="Второй сервис — запасной."><select name="source" className="input" defaultValue={ps.source}>{SEARCH_OPTIONS.source.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Кандидатов на слот" hint="20–200; больше — дороже оценка."><input name="perSlot" type="number" min={20} max={200} className="input" defaultValue={ps.perSlot} /></Field>
              <Field label="Мин. сторона кадра, px"><input name="minSide" type="number" min={300} max={4000} className="input" defaultValue={ps.minSide} /></Field>
              <Field label="Ориентация (для секций; главное фото — из параметров)"><span className="flex flex-wrap gap-3 pt-2">{SEARCH_OPTIONS.orientation.map(([v, l]) => <label key={v} className="inline-flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="orientation" value={v} defaultChecked={(ps.orientation as readonly string[]).includes(v)} /> {l}</label>)}</span></Field>
              <Field label="Тип изображения"><select name="imageType" className="input" defaultValue={ps.imageType}>{SEARCH_OPTIONS.imageType.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Свежесть"><select name="freshness" className="input" defaultValue={ps.freshness}>{SEARCH_OPTIONS.freshness.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Страна выдачи"><input name="country" className="input mono" defaultValue={ps.country} maxLength={2} /></Field>
              <Field label="Язык"><input name="language" className="input mono" defaultValue={ps.language} maxLength={5} /></Field>
              <div className="sm:col-span-2 lg:col-span-3"><Field label="Исключить сайты" hint="Каталоги магазинов и стоки отсеиваются и так; здесь — свои."><textarea name="excludeDomains" className="input mono" rows={3} defaultValue={ps.excludeDomains.join("\n")} /></Field></div>
            </div>
          </Card>
          <Card title="Оценка, уникальность и подписи">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Порог оценки (1–10)" hint="Балл = 0,6·релевантность + 0,4·качество."><input name="minScore" type="number" min={1} max={10} className="input" defaultValue={ps.minScore} /></Field>
              <Field label="Уникальность между статьями"><select name="uniqueMode" className="input" defaultValue={ps.uniqueMode}>{SEARCH_OPTIONS.uniqueMode.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Подпись под фото"><select name="captionMode" className="input" defaultValue={ps.captionMode}>{SEARCH_OPTIONS.captionMode.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <Field label="Шаблон подписи" hint="{credit} — «Photo credit:», {domain} — домен источника."><input name="captionTemplate" className="input mono" defaultValue={ps.captionTemplate} /></Field>
            </div>
          </Card>
          <SubmitButton pendingText="Сохраняю…">Сохранить настройки поиска</SubmitButton>
        </ActionForm>
      )}

      {tab === "history" && (
        <Card title="История версий" description="Каждое сохранение промта или параметров — новая версия. Можно вернуть любую.">
          {history.length === 0 ? <p className="help">Версий пока нет.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Когда</th><th>Версия</th><th>Кто</th><th>Что изменили</th><th></th></tr></thead>
              <tbody>{history.map((h) => (
                <tr key={h.id}><td className="whitespace-nowrap">{fmtDate(h.createdAt)}</td><td>v{h.version}</td><td>{authors.find((a) => a.id === h.createdById)?.name ?? "—"}</td><td className="max-w-md">{h.changeSummary ?? <span className="text-muted">—</span>}</td>
                  <td className="text-right"><ActionForm action={restoreBlogVersion} hidden={{ recipeId: id, versionId: h.id }} className="inline"><SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm={`Вернуть промты и параметры версии ${h.version}?`}>Вернуть</SubmitButton></ActionForm></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </>
  );
}
