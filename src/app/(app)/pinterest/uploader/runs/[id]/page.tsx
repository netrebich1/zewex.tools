import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireUploader, runFor } from "@/lib/uploader/access";
import { runView } from "@/lib/uploader/views";
import { RUN_LIVE } from "@/lib/uploader/types";
import { deleteRunAction, retryRunAction, stopRunAction } from "@/actions/uploader";
import { RunView } from "@/components/uploader/RunView";
import { formatRu } from "@/lib/pins/schedule/math";

export const dynamic = "force-dynamic";

export default async function UploaderRunPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUploader();
  const { id } = await params;
  if (!(await runFor(me, id))) notFound();
  const view = await runView(id);
  if (!view) notFound();
  const live = RUN_LIVE.has(view.status);
  const retryable = view.tasks.some((t) => t.phase === "upload" && (t.status === "FAILED" || (t.status === "SKIPPED" && t.profileId && t.errorKind !== "no_file")));
  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/uploader/runs", label: "Запуски" }}
        title={`Заливка за ${formatRu(view.day)}`}
        subtitle={`${view.source === "schedule" ? "По расписанию" : "Кнопкой"} · агент ${view.agent.name}`}
        actions={
          <>
            {live && <ActionForm action={stopRunAction} className="inline" hidden={{ id }}><SubmitButton className="btn-danger" pendingText="…" confirm="Остановить? Ждущие сайты будут пропущены, текущий агент доделает.">Остановить</SubmitButton></ActionForm>}
            {!live && retryable && <ActionForm action={retryRunAction} className="inline" hidden={{ id }}><SubmitButton className="btn-ghost" pendingText="…">Повторить неудачные</SubmitButton></ActionForm>}
            {!live && <ActionForm action={deleteRunAction} className="inline" hidden={{ id }}><SubmitButton className="btn-ghost text-danger" pendingText="…" confirm="Удалить запуск? Отметки в «Проектах» останутся.">Удалить</SubmitButton></ActionForm>}
          </>
        }
      />
      <RunView initial={view} />
    </>
  );
}
