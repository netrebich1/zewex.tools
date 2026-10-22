import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createBlogRecipe } from "@/actions/blogRecipes";
import { recipeReadiness, recipeShape, userSlots } from "@/lib/blog/recipes";
import { ACTIVE_STATUSES, VOICES } from "@/lib/blog/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function BlogRecipesPage() {
  const me = await requireUser();
  const [recipes, have] = await Promise.all([prisma.blogRecipe.findMany({ orderBy: [{ isDefault: "desc" }, { number: "asc" }] }), userSlots(me)]);
  const active = await prisma.blogPost.groupBy({ by: ["recipeId"], where: { status: { in: ACTIVE_STATUSES } }, _count: { _all: true } });
  const activeOf = (id: string) => active.find((a) => a.recipeId === id)?._count._all ?? 0;
  return (
    <>
      <PageHeader title="Сценарии" subtitle="Сценарий = промты всех этапов + модели + параметры структуры (объём, картинки, голос, блоки, FAQ) + настройки поиска фото и публикации. Запуск делает снимок сценария." />
      <div className="space-y-4">
        <Card>
          {recipes.length === 0 ? <p className="help">Сценариев нет — создайте первый ниже.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>№</th><th>Сценарий</th><th className="hidden md:table-cell">Параметры</th><th>Готовность</th><th className="hidden lg:table-cell">Обновлён</th></tr></thead>
              <tbody>{recipes.map((r) => {
                const shape = recipeShape(r);
                const rd = recipeReadiness(shape, have);
                const n = activeOf(r.id);
                return (
                  <tr key={r.id} className={r.isActive ? "" : "opacity-60"}>
                    <td className="text-muted tabular-nums">{r.number ?? "—"}</td>
                    <td><Link href={`/pinterest/blog/scenarios/${r.id}`} className="font-medium hover:underline">{r.name}</Link> {r.isDefault && <Badge tone="brand">по умолчанию</Badge>}{!r.isActive && <Badge>выключен</Badge>}{n > 0 && <Badge tone="brand">в работе: {n}</Badge>}<div className="help">{r.description}</div></td>
                    <td className="hidden md:table-cell text-muted text-[13px]">{shape.params.length.min}–{shape.params.length.max} слов · {shape.params.images.min}–{shape.params.images.max} фото · {VOICES.find((v) => v.value === shape.params.voice)?.label}</td>
                    <td>{rd.ok ? <Badge tone="ok">готов</Badge> : <span className="text-[12.5px]">{rd.missingPrompts.length > 0 && <div className="text-danger">нет промтов: {rd.missingPrompts.join(", ")}</div>}{rd.missingSlots.length > 0 && <div className="text-warn">нет ключей: {rd.missingSlots.join(", ")}</div>}</span>}</td>
                    <td className="hidden lg:table-cell text-muted whitespace-nowrap">{fmtDate(r.updatedAt)}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Новый сценарий" description="Создаётся как копия сценария по умолчанию (промты, модели, параметры) — дальше правьте под задачу.">
          <ActionForm action={createBlogRecipe} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Название"><input name="name" className="input" required placeholder="Инфо-статья · дом и уборка" /></Field>
            <Field label="Описание"><input name="description" className="input" /></Field>
            <SubmitButton pendingText="Создаю…">Создать</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
