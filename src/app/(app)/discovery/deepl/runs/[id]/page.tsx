import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { JOB_TONE } from "@/components/deepl/DeeplNav";
import { DeeplHeader } from "@/components/deepl/DeeplHeader";
import { RunView } from "@/components/deepl/RunView";
import { canAccessJob, jobItems } from "@/lib/deepl/jobs";
import { deleteDeeplJob, resumeDeeplJob, stopDeeplJob } from "@/actions/deepl";
import { describeSettings, JOB_STATUS_LABELS, parseSettings } from "@/lib/deepl/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DeeplRunPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const job = await prisma.deeplJob.findUnique({ where: { id } });
  if (!job || !canAccessJob(me, job)) notFound();
  const settings = parseSettings(job.settings);
  const items = await jobItems(id);
  const live = job.status === "QUEUED" || job.status === "RUNNING";
  const stopped = items.some((i) => i.status === "stopped");

  return (
    <>
      <DeeplHeader />
      <PageHeader
        back={{ href: "/discovery/deepl", label: "Прогоны" }}
        title={job.name}
        subtitle={
          <>
            <Badge tone={JOB_TONE[job.status] ?? "neutral"}>{JOB_STATUS_LABELS[job.status] ?? job.status}</Badge>
            <span className="ml-2">{job.siteName} · {describeSettings(settings)}{settings.model ? ` · модель ${settings.model}` : ""}{settings.headingsModel && settings.headingsModel !== settings.model ? `, H2 ${settings.headingsModel}` : ""} · создан {fmtDate(job.createdAt)}{job.finishedAt ? ` · завершён ${fmtDate(job.finishedAt)}` : ""}</span>
          </>
        }
        actions={
          <>
            {live && !job.stopRequested && (
              <ActionForm action={stopDeeplJob} className="inline" hidden={{ id }}>
                <SubmitButton className="btn-danger" pendingText="…" confirm="Остановить прогон? Готовые этапы сохранятся, продолжить можно позже.">Остановить</SubmitButton>
              </ActionForm>
            )}
            {!live && stopped && (
              <ActionForm action={resumeDeeplJob} className="inline" hidden={{ id }}>
                <SubmitButton className="btn-primary" pendingText="…">Продолжить</SubmitButton>
              </ActionForm>
            )}
            <Link href={`/discovery/deepl/new?from=${id}`} className="btn-ghost">Новый прогон с этими настройками</Link>
            {!live && (
              <ActionForm action={deleteDeeplJob} className="inline" hidden={{ id }}>
                <SubmitButton className="btn-ghost text-danger" pendingText="…" confirm="Удалить прогон со всеми версиями статей? Опубликованное в WordPress останется.">Удалить</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />
      <RunView jobId={id} initialStatus={job.status} initialItems={JSON.parse(JSON.stringify(items))} publishDefaults={settings.publish} />
    </>
  );
}
