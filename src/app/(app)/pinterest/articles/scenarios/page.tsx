import Link from "next/link";
import type { ArtFormat } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, Empty, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createRecipe } from "@/actions/articlesRecipes";
import { FORMAT_LABELS, recipeReadiness } from "@/lib/articles/recipes";
import { ACTIVE_STATUSES } from "@/lib/articles/labels";

export const dynamic = "force-dynamic";

/** Список сценариев по формату и нише с готовностью (есть ли промт для каждого шага формата). */
export default async function RecipesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();
  const params = await searchParams;
  const format: ArtFormat = sp(params, "format") === "GENERATED_PHOTO" ? "GENERATED_PHOTO" : "REAL_PHOTO";

  const [recipes, niches, sets, active, total] = await Promise.all([
    prisma.artRecipe.findMany({ where: { format }, orderBy: [{ nicheCode: "asc" }, { isDefault: "desc" }, { number: "asc" }], include: { promptSet: { select: { id: true, name: true, prompts: { select: { id: true, stageKey: true, isActive: true } } } } } }),
    prisma.artNiche.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.artPromptSet.findMany({ orderBy: [{ nicheCode: "asc" }, { name: "asc" }], select: { id: true, name: true, nicheCode: true, subnicheCode: true, format: true, isActive: true } }),
    prisma.article.groupBy({ by: ["recipeId"], where: { status: { in: ACTIVE_STATUSES } }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["recipeId"], _count: { _all: true } }),
  ]);
  const nicheName = (code: string | null) => (code ? niches.find((n) => n.code === code) : null);
  const activeOf = (id: string) => active.find((a) => a.recipeId === id)?._count._all ?? 0;
  const totalOf = (id: string) => total.find((a) => a.recipeId === id)?._count._all ?? 0;
  const groups = new Map<string, typeof recipes>();
  for (const r of recipes) groups.set(r.nicheCode, [...(groups.get(r.nicheCode) ?? []), r]);
  const parents = niches.filter((n) => !n.parentCode);

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="Сценарии"
        subtitle="Сценарий = ниша + формат + набор промтов + модели шагов + настройки текста, поиска фото и публикации. Запуск берёт снимок сценария; правка сценария на уже идущие статьи не влияет."
      />
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FORMAT_LABELS) as ArtFormat[]).map((f) => (
              <Link key={f} href={`/pinterest/articles/scenarios${f === "REAL_PHOTO" ? "" : `?format=${f}`}`} className={`tab ${format === f ? "active" : ""}`}>
                {FORMAT_LABELS[f]}
              </Link>
            ))}
            {format === "GENERATED_PHOTO" && <span className="help self-center">Формат «ИИ-фото» — волна 3: сценарии можно править, но конвейер пока не запускает их этапы.</span>}
          </div>
        </Card>

        {recipes.length === 0 ? (
          <Empty title="Сценариев этого формата нет" hint="Создайте первый в форме ниже." />
        ) : (
          [...groups.entries()].map(([code, list]) => {
            const n = nicheName(code);
            return (
              <Card key={code} title={`${n?.emoji ?? "📄"} ${n?.name ?? code}`}>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {list.map((r) => {
                    const ready = recipeReadiness(r, r.promptSet?.prompts ?? []);
                    const sub = nicheName(r.subnicheCode);
                    return (
                      <Link key={r.id} href={`/pinterest/articles/scenarios/${r.id}`} className="card card-hover p-4 block">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold truncate">
                              {r.number != null && <span className="text-muted mr-1">№{r.number}</span>}
                              {r.name}
                            </div>
                            <div className="help mt-0.5 truncate">
                              {sub ? `${sub.name} · ` : ""}
                              {r.promptSet ? `набор: ${r.promptSet.name}` : "набор не выбран"}
                            </div>
                          </div>
                          {r.isDefault && <Badge tone="brand">по умолчанию</Badge>}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {!r.isActive && <Badge>выключен</Badge>}
                          {ready.ready ? <Badge tone="ok">готов · промты {ready.filled}/{ready.total}</Badge> : <Badge tone="danger">не хватает промтов: {ready.missing.map((m) => m.label).join(", ")}</Badge>}
                          {activeOf(r.id) > 0 && <Badge tone="brand">в работе {activeOf(r.id)}</Badge>}
                          {totalOf(r.id) > 0 && <Badge>статей {totalOf(r.id)}</Badge>}
                        </div>
                        {r.description && <p className="help mt-2 line-clamp-2">{r.description}</p>}
                      </Link>
                    );
                  })}
                </div>
              </Card>
            );
          })
        )}

        <Card title="Новый сценарий" description="Название, ниша, формат и набор промтов. Остальные настройки — в карточке сценария.">
          <ActionForm action={createRecipe} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
            <input type="hidden" name="format" value={format} />
            <Field label="Название"><input name="name" className="input" required placeholder="например: Ногти — реальные фото (тест)" /></Field>
            <Field label="Ниша">
              <select name="nicheCode" className="input" required defaultValue="">
                <option value="" disabled>— выберите —</option>
                {parents.map((n) => <option key={n.code} value={n.code}>{n.emoji} {n.name}</option>)}
              </select>
            </Field>
            <Field label="Подниша (необязательно)">
              <select name="subnicheCode" className="input" defaultValue="">
                <option value="">— нет —</option>
                {niches.filter((n) => n.parentCode).map((n) => <option key={n.code} value={n.code}>{n.name} ({n.parentCode})</option>)}
              </select>
            </Field>
            <Field label={`Набор промтов (${FORMAT_LABELS[format]})`} hint="Пусто — активный набор ниши подберётся автоматически.">
              <select name="promptSetId" className="input" defaultValue="">
                <option value="">— активный набор ниши —</option>
                {sets.filter((s) => s.format === format).map((s) => <option key={s.id} value={s.id}>{s.name}{s.isActive ? "" : " (неакт.)"}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <SubmitButton pendingText="Создаю…">Создать сценарий</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
