import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getRunForUser } from "@/lib/pins/runs/actions";
import { runStatus } from "@/lib/pins/runs/status";
import { Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { continueRunAction, deleteRunAction, redoMissingAction, skipFailedAction, stopRunAction, updateRunSettings } from "@/actions/pins";
import { RecipeFields } from "@/components/pins/RecipeFields";
import { recipeFieldsData } from "@/components/sites/PinsRecipeForm";
import { RunStatus } from "@/components/pins/RunStatus";
import { mergeRecipe } from "@/lib/pins/types";
import { RunLog, RunPins, RunSchedule } from "@/components/pins/RunDetails";
import Link from "next/link";
import { type SearchParams, sp } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const q = await searchParams;
  const tab = ["overview", "pins", "schedule", "log", "settings"].includes(sp(q, "tab") ?? "") ? (sp(q, "tab") as string) : "overview";
  const pageNo = Math.max(1, Number(sp(q, "page")) || 1);
  const run = await getRunForUser(me, id);
  if (!run) notFound();
  const view = await runStatus(id);
  if (!view) notFound();
  const r = mergeRecipe(run.settings);
  const busy = view.job != null && ["PENDING", "RUNNING", "STOPPING"].includes(view.job.status);
  const live = ["QUEUED", "RUNNING"].includes(run.status);
  const sets = run.siteId ? await prisma.pinSet.findMany({ where: { siteId: run.siteId }, orderBy: { name: "asc" } }) : [];
  const fieldsData = await recipeFieldsData(sets);

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins/runs", label: "Прогоны" }} title={run.name || `Прогон ${id.slice(0, 8)}`} subtitle={`${run.site?.name ?? "—"} · ИИ ${r.mix.ai}, фото ${r.mix.photos}, canvas ${r.mix.canvas}, pinora ${r.mix.pinora} на ссылку · ${r.schedule.pinsPerDay}/день · модерация: ${r.schedule.moderationMode === "auto" ? "авто" : "обязательна"} · режим: ${run.stepByStep ? "пошаговый" : "автопилот"}`} />
      <div className="mb-4 flex flex-wrap gap-2">
        {[["overview", "Обзор"], ["pins", `Страницы и пины · ${view.pages.total}/${view.total.planned}`], ["schedule", `Расписание · ${view.total.scheduled}`], ["log", "Журнал этапов"], ["settings", "Настройки"]].map(([k, l]) => (
          <Link key={k} href={`/pinterest/pins/runs/${id}?tab=${k}`} className={`badge px-3 py-1 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>
        ))}
      </div>
      {tab === "overview" && (
      <div className="space-y-5">
        <RunStatus initial={view} />
        <Card title="Действия" description={run.stepByStep ? "Пошаговый режим: после каждого этапа прогон встаёт на паузу, «Продолжить» запускает следующий этап." : "Автопилот: этапы идут сами. «Продолжить» нужен после модерации, паузы или исправления проблемы."}>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={continueRunAction} className="inline" hidden={{ id }}>
              <SubmitButton className="btn-primary" pendingText="…">{busy ? "Выполняется…" : "Продолжить"}</SubmitButton>
            </ActionForm>
            <ActionForm action={redoMissingAction} className="inline" hidden={{ id }}>
              <SubmitButton className="btn-ghost" pendingText="…">Доделать недостающее</SubmitButton>
            </ActionForm>
            <ActionForm action={skipFailedAction} className="inline" hidden={{ id }}>
              <SubmitButton className="btn-ghost" confirm="Отклонить все пины, у которых так и нет картинки?" pendingText="…">Пропустить сбойные</SubmitButton>
            </ActionForm>
            <ActionForm action={stopRunAction} className="inline" hidden={{ id }}>
              <SubmitButton className="btn-ghost" pendingText="…">Стоп</SubmitButton>
            </ActionForm>
            {run.status === "WAITING_MODERATION" && <Link href={`/pinterest/pins/moderation?run=${id}`} className="btn-brand">Модерация этого прогона</Link>}
            {run.status === "DONE" && <Link href={`/pinterest/pins/export?site=${run.siteId ?? ""}`} className="btn-ghost">Выгрузка CSV</Link>}
            <ActionForm action={deleteRunAction} className="inline ml-auto" hidden={{ id }}>
              <SubmitButton className="btn-danger" confirm="Удалить прогон вместе со всеми пинами и картинками?" pendingText="…">Удалить</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
      )}
      {tab === "pins" && <RunPins runId={id} page={pageNo} />}
      {tab === "schedule" && <RunSchedule runId={id} />}
      {tab === "log" && <RunLog runId={id} />}
      {tab === "settings" && (
        <Card title="Настройки прогона" description={live ? "Прогон выполняется: чтобы изменить настройки, сначала нажмите «Стоп»." : "Свои для этого прогона. Изменения применяются к этапам, которые ещё не прошли: например, число пинов в день — к расписанию, количество пинов — к плану. Стили, язык и доски — в настройках сайта."}>
          <ActionForm action={updateRunSettings} hidden={{ id }} className="space-y-4">
            <fieldset disabled={live} className="space-y-4 disabled:opacity-60">
              <RecipeFields r={r} data={fieldsData} scope="run" />
              <SubmitButton pendingText="Сохраняю…">Сохранить настройки прогона</SubmitButton>
            </fieldset>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
