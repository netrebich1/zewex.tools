import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { PromptEditor } from "@/components/articles/PromptEditor";
import { copyRecipe, deleteRecipe, savePhotoSearch, saveRecipeMain } from "@/actions/articlesRecipes";
import { FORMAT_LABELS, POPULAR_MODELS, promptSteps, recipeReadiness, recipeShape, SEARCH_OPTIONS, STAGE_VARS, VAR_HINTS } from "@/lib/articles/recipes";
import { ACTIVE_STATUSES } from "@/lib/articles/labels";
import { PERSONALITIES, PUBLISH_MODES, WORD_COUNTS } from "@/lib/articles/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [["main", "Основное"], ["prompts", "Промты"], ["search", "Поиск фото"], ["history", "История"]] as const;
const PERSONALITY_LABELS: Record<string, string> = { wry: "С иронией", warm: "Тёплый", curious: "Любознательный", confident: "Уверенный", "self-deprecating": "Самоироничный" };

export default async function RecipePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = TABS.find(([k]) => k === sp(q, "tab"))?.[0] ?? "main";

  const r = await prisma.artRecipe.findUnique({ where: { id }, include: { promptSet: { include: { prompts: { orderBy: { createdAt: "asc" }, include: { _count: { select: { versions: true } } } } } } } });
  if (!r) notFound();
  const shape = recipeShape(r);
  const [niches, sets, active] = await Promise.all([
    prisma.artNiche.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.artPromptSet.findMany({ where: { format: r.format }, orderBy: [{ nicheCode: "asc" }, { name: "asc" }], select: { id: true, name: true, nicheCode: true, isActive: true } }),
    prisma.article.count({ where: { recipeId: id, status: { in: ACTIVE_STATUSES } } }),
  ]);
  const prompts = r.promptSet?.prompts ?? [];
  const ready = recipeReadiness(r, prompts);
  const steps = promptSteps(r.format);
  const href = (t: string, extra = "") => `/pinterest/articles/scenarios/${id}?tab=${t}${extra}`;

  // Вкладка «Промты»: выбранный шаг и вариант
  const stageKey = steps.find((s) => s.key === sp(q, "stage"))?.key ?? steps[0]?.key ?? "";
  const step = steps.find((s) => s.key === stageKey);
  const variants = prompts.filter((p) => p.stageKey === stageKey);
  const chosenId = shape.stagePromptIds[stageKey] ?? "";
  const promptId = variants.find((v) => v.id === sp(q, "prompt"))?.id ?? variants.find((v) => v.id === chosenId)?.id ?? variants[0]?.id ?? null;
  const prompt = variants.find((v) => v.id === promptId) ?? null;

  const history = tab === "history" && r.promptSetId
    ? await prisma.artPromptVersion.findMany({ where: { prompt: { setId: r.promptSetId } }, orderBy: { createdAt: "desc" }, take: 150, include: { prompt: { select: { name: true, stageKey: true } } } })
    : [];
  const authorIds = [...new Set(history.map((h) => h.createdById).filter((x): x is string => !!x))];
  const authors = authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }) : [];

  const niche = niches.find((n) => n.code === r.nicheCode);
  const ps = shape.photoSearch;

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles/scenarios", label: "Сценарии" }}
        title={`${r.number != null ? `№${r.number} · ` : ""}${r.name}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge>{FORMAT_LABELS[r.format]}</Badge>
            <Badge>{niche ? `${niche.emoji} ${niche.name}` : r.nicheCode}</Badge>
            {r.isDefault && <Badge tone="brand">по умолчанию</Badge>}
            {!r.isActive && <Badge>выключен</Badge>}
            {ready.ready ? <Badge tone="ok">промты готовы {ready.filled}/{ready.total}</Badge> : <Badge tone="danger">не хватает промтов: {ready.missing.map((m) => m.label).join(", ")}</Badge>}
            {active > 0 && <Badge tone="brand">статей в работе: {active}</Badge>}
          </span>
        }
        actions={
          <>
            <a href={`/api/articles/recipes/${id}/export`} className="btn-ghost">Экспорт JSON</a>
            <ActionForm action={copyRecipe} hidden={{ id }} className="inline">
              <SubmitButton className="btn-ghost" pendingText="Копирую…">Копировать сценарий</SubmitButton>
            </ActionForm>
            {me.role === "ADMIN" && (
              <ActionForm action={deleteRecipe} hidden={{ id }} className="inline">
                <SubmitButton className="btn-danger" pendingText="Удаляю…" confirm={`Удалить сценарий «${r.name}»? Набор промтов останется.`}>Удалить</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map(([k, l]) => (
          <Link key={k} href={href(k)} className={`tab ${tab === k ? "active" : ""}`}>{l}</Link>
        ))}
      </div>

      {tab === "main" && (
        <ActionForm action={saveRecipeMain} hidden={{ id }} className="space-y-4">
          <Card title="Основное" description="Формат задаётся при создании и не меняется. Смена набора промтов сбрасывает выбранные варианты шагов.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Название"><input name="name" className="input" defaultValue={r.name} required /></Field>
              <Field label="Формат"><input className="input" value={FORMAT_LABELS[r.format]} disabled readOnly /></Field>
              <div className="sm:col-span-2"><Field label="Описание"><textarea name="description" className="input" rows={2} defaultValue={r.description ?? ""} /></Field></div>
              <Field label="Ниша">
                <select name="nicheCode" className="input" defaultValue={r.nicheCode}>
                  {niches.filter((n) => !n.parentCode).map((n) => <option key={n.code} value={n.code}>{n.emoji} {n.name}</option>)}
                </select>
              </Field>
              <Field label="Подниша">
                <select name="subnicheCode" className="input" defaultValue={r.subnicheCode ?? ""}>
                  <option value="">— нет —</option>
                  {niches.filter((n) => n.parentCode).map((n) => <option key={n.code} value={n.code}>{n.name} ({n.parentCode})</option>)}
                </select>
              </Field>
              <Field label="Набор промтов" hint="Пусто — активный набор ниши/формата подбирается автоматически при запуске.">
                <select name="promptSetId" className="input" defaultValue={r.promptSetId ?? ""}>
                  <option value="">— активный набор ниши —</option>
                  {sets.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.nicheCode}{s.isActive ? "" : " (неакт.)"}</option>)}
                </select>
              </Field>
              <div className="flex flex-col gap-2 pt-6">
                <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="isDefault" defaultChecked={r.isDefault} /> сценарий по умолчанию для ниши и формата</label>
                <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" name="isActive" defaultChecked={r.isActive} /> доступен для запуска</label>
              </div>
            </div>
          </Card>
          <Card title="Текст" description="Объём и характер — в переменных промтов автора; секций за запрос — размер пачки писателя.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Объём статьи">
                <select name="wordCount" className="input" defaultValue={shape.text.wordCount}>{WORD_COUNTS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select>
              </Field>
              <Field label="Характер текста">
                <select name="personality" className="input" defaultValue={shape.text.personality ?? ""}>
                  <option value="">Авто</option>
                  {PERSONALITIES.map((p) => <option key={p} value={p}>{PERSONALITY_LABELS[p] ?? p}</option>)}
                </select>
              </Field>
              <Field label="Секций за один запрос" hint="1–10; меньше — надёжнее, больше — дешевле."><input name="batchSize" type="number" min={1} max={10} className="input" defaultValue={shape.text.batchSize} /></Field>
              <label className="inline-flex items-center gap-2 text-[14px] pt-7"><input type="checkbox" name="schemaEnabled" defaultChecked={shape.text.schemaEnabled} /> Schema.org в HTML</label>
            </div>
          </Card>
          <Card title="Публикация" description="Режим по умолчанию для запусков с этим сценарием; сайт и запуск могут переопределить.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Режим публикации">
                <select name="publishMode" className="input" defaultValue={shape.publish.mode}>{PUBLISH_MODES.map((m) => <option key={m.value} value={m.value} title={m.help}>{m.label}</option>)}</select>
              </Field>
              <Field label="Доля статей с годом в URL, %" hint="0 — никогда, 100 — всегда."><input name="seoYearUrlPercent" type="number" min={0} max={100} step={5} className="input" defaultValue={shape.publish.seoYearUrlPercent} /></Field>
            </div>
          </Card>
          <SubmitButton pendingText="Сохраняю…">Сохранить сценарий</SubmitButton>
        </ActionForm>
      )}

      {tab === "prompts" && (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card className="lg:sticky lg:top-4 self-start">
            <h3 className="h2 mb-2">Шаги формата</h3>
            <ul className="space-y-0.5">
              {steps.map((s) => {
                const n = prompts.filter((p) => p.stageKey === s.key && p.isActive).length;
                const ok = n > 0;
                return (
                  <li key={s.key}>
                    <Link href={href("prompts", `&stage=${encodeURIComponent(s.key)}`)} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] ${stageKey === s.key ? "bg-ink text-bg" : "hover:bg-ink/5"}`}>
                      <span className={`mt-1 inline-block h-2.5 w-2.5 rounded-full shrink-0 ${ok ? "bg-ok" : s.required ? "bg-danger" : "bg-line-2"}`} title={ok ? `${n} вариантов` : s.required ? "обязательный шаг без промта" : "необязательный шаг"} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.label}</span>
                        <span className={`block truncate text-[11.5px] ${stageKey === s.key ? "text-bg/70" : "text-muted"}`}>
                          {s.stageLabel}
                          {shape.stageModels[s.key] ? ` · ${shape.stageModels[s.key].split(":").pop()}` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {r.promptSet && <p className="help mt-3">Набор: {r.promptSet.name}</p>}
          </Card>
          <Card>
            {step ? (
              <PromptEditor
                key={`${stageKey}:${prompt?.id ?? "none"}`}
                recipeId={id}
                setId={r.promptSetId}
                stageKey={stageKey}
                label={step.label}
                required={step.required}
                variants={variants.map((v) => ({ id: v.id, name: v.name, isActive: v.isActive, updatedAt: v.updatedAt.toISOString(), versions: v._count.versions }))}
                prompt={prompt ? { id: prompt.id, name: prompt.name, system: prompt.system ?? "", text: prompt.text, isActive: prompt.isActive } : null}
                chosenId={chosenId}
                model={shape.stageModels[stageKey] ?? ""}
                vars={STAGE_VARS[stageKey] ?? []}
                hints={VAR_HINTS}
                popularModels={POPULAR_MODELS}
              />
            ) : (
              <p className="help">У этого формата нет шагов с промтами.</p>
            )}
          </Card>
        </div>
      )}

      {tab === "search" && (
        <ActionForm action={savePhotoSearch} hidden={{ id }} className="space-y-4">
          <Card title="Источник и фильтры" description="Как ищутся реальные фото в Google Images. Модель оценки задаётся на вкладке «Промты» у шага «Оценка фото».">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Источник" hint="Второй сервис используется как запасной.">
                <select name="source" className="input" defaultValue={ps.source}>{SEARCH_OPTIONS.source.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Кандидатов запрашивать" hint="Сколько кадров собрать до фильтров (20–1000).">
                <input name="candidatesTotal" type="number" min={20} max={1000} className="input" defaultValue={ps.candidatesTotal} />
              </Field>
              <Field label="Мин. сторона кадра, px" hint="Одно число для ширины и высоты (оригинал: 550).">
                <input name="minSide" type="number" min={200} max={4000} className="input" defaultValue={ps.minWidth} />
              </Field>
              <Field label="Ориентация (до двух)">
                <span className="flex flex-wrap gap-3 pt-2">
                  {SEARCH_OPTIONS.orientation.map(([v, l]) => (
                    <label key={v} className="inline-flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="orientation" value={v} defaultChecked={ps.orientation.includes(v)} /> {l}</label>
                  ))}
                </span>
              </Field>
              <Field label="Тип изображения">
                <select name="imageType" className="input" defaultValue={ps.imageType}>{SEARCH_OPTIONS.imageType.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Лицензия">
                <select name="license" className="input" defaultValue={ps.license}>{SEARCH_OPTIONS.license.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Страна (гео выдачи)">
                <select name="country" className="input" defaultValue={ps.country}>{SEARCH_OPTIONS.country.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Язык" hint="Код языка выдачи: en, de, pl…"><input name="language" className="input mono" defaultValue={ps.language} maxLength={5} /></Field>
              <Field label="Свежесть">
                <select name="freshness" className="input" defaultValue={ps.freshness}>{SEARCH_OPTIONS.freshness.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <div className="sm:col-span-2 lg:col-span-3 grid gap-3 sm:grid-cols-2">
                <Field label="Искать только на сайтах" hint="Домены через запятую или с новой строки; пусто — везде."><textarea name="includeDomains" className="input mono" rows={3} defaultValue={ps.includeDomains.join("\n")} /></Field>
                <Field label="Исключить сайты" hint="Каталоги магазинов, стоки и т.п."><textarea name="excludeDomains" className="input mono" rows={3} defaultValue={ps.excludeDomains.join("\n")} /></Field>
              </div>
              <Field label="Добавка к запросу" hint="Дописывается к каждому поисковому запросу, напр. «street style»."><input name="querySuffix" className="input" defaultValue={ps.querySuffix} /></Field>
            </div>
          </Card>
          <Card title="Оценка и отбор" description="Порог vision-оценки и размер пачки; уникальность между сайтами команды.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Порог отбора (1–10)" hint="Кадры ниже порога идут в резерв; при нехватке порог снижается на 1."><input name="minScore" type="number" min={1} max={10} className="input" defaultValue={ps.minScore} /></Field>
              <Field label="Фото в одной пачке оценки (2–12)" hint="Сколько кадров модель видит за один запрос."><input name="ratingBatchSize" type="number" min={2} max={12} className="input" defaultValue={ps.ratingBatchSize} /></Field>
              <Field label="Уникальность между сайтами">
                <select name="uniqueMode" className="input" defaultValue={ps.uniqueMode}>{SEARCH_OPTIONS.uniqueMode.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
            </div>
          </Card>
          <Card title="Текст по фото и подписи" description="Как автор видит кадр и что пишется под фото в статье.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Как писать текст секций">
                <select name="writerMode" className="input" defaultValue={ps.writerMode}>{SEARCH_OPTIONS.writerMode.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Подпись под фото">
                <select name="captionMode" className="input" defaultValue={ps.captionMode}>{SEARCH_OPTIONS.captionMode.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Шаблон подписи" hint="{credit} — слово «Photo:», {domain} — домен источника."><input name="captionTemplate" className="input mono" defaultValue={ps.captionTemplate} /></Field>
            </div>
          </Card>
          <SubmitButton pendingText="Сохраняю…">Сохранить настройки поиска</SubmitButton>
        </ActionForm>
      )}

      {tab === "history" && (
        <Card title="История версий промтов набора" description={r.promptSet ? `Набор «${r.promptSet.name}»: каждое сохранение промта — новая версия.` : "У сценария нет набора промтов."}>
          {history.length === 0 ? (
            <p className="help">Версий пока нет — они появятся после первого сохранения промта в редакторе.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Шаг · вариант</th>
                    <th>Версия</th>
                    <th>Кто</th>
                    <th>Что изменили</th>
                    <th>Размер</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="whitespace-nowrap">{fmtDate(h.createdAt)}</td>
                      <td>
                        <Link href={href("prompts", `&stage=${encodeURIComponent(h.prompt.stageKey)}&prompt=${h.promptId}`)} className="hover:underline">{h.prompt.name}</Link>
                        <div className="help mono">{h.prompt.stageKey}</div>
                      </td>
                      <td>v{h.version}</td>
                      <td>{authors.find((a) => a.id === h.createdById)?.name ?? "—"}</td>
                      <td className="max-w-md">{h.changeSummary ?? <span className="text-muted">—</span>}</td>
                      <td className="whitespace-nowrap help">{h.text.length.toLocaleString("ru-RU")}{h.system ? ` + ${h.system.length.toLocaleString("ru-RU")}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
