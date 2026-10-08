import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { launchRun } from "@/actions/pins";
import { mergeRecipe } from "@/lib/pins/types";

export const dynamic = "force-dynamic";

export default async function NewRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const preset = sp(params, "site");
  const sites = await prisma.pinSite.findMany({ where: { ...(me.role === "ADMIN" ? {} : { teamId: { in: me.teamIds } }), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, recipe: true, _count: { select: { boards: true } } } });

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins", label: "Сегодня" }} title="Новый прогон" subtitle="Вставьте ссылки на статьи, выберите сайт и нажмите «Запустить». Дальше всё идёт само и останавливается только на модерации." />
      <Card>
        <ActionForm action={launchRun}>
          <Field label="Сайт">
            <select name="siteId" className="input" defaultValue={preset ?? sites[0]?.id ?? ""} required>
              {sites.map((s) => {
                const r = mergeRecipe(s.recipe);
                const per = r.mix.ai + r.mix.photos + r.mix.canvas + r.mix.pinora;
                return <option key={s.id} value={s.id}>{s.name} — ≈{per} пинов на ссылку, {r.schedule.pinsPerDay}/день, досок: {s._count.boards}</option>;
              })}
            </select>
          </Field>
          <Field label="Ссылки на статьи" hint="По одной в строке. Дубли убираются автоматически.">
            <textarea name="urls" className="input font-mono text-[13px]" rows={10} required placeholder={"https://site.com/article-1\nhttps://site.com/article-2"} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Название прогона (необязательно)"><input name="name" className="input" placeholder="Октябрь, декор" /></Field>
            <Field label="Модерация">
              <select name="moderationMode" className="input" defaultValue="required">
                <option value="required">Обязательна: пауза, пока всё не проверено</option>
                <option value="auto">Автоодобрение: без паузы (пины без картинки отклоняются)</option>
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" name="stepByStep" className="h-4 w-4" />
            Пошагово: останавливаться после каждого этапа (ручной режим)
          </label>
          <div className="flex gap-2">
            <SubmitButton className="btn-brand" pendingText="Запускаю…">Запустить</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
