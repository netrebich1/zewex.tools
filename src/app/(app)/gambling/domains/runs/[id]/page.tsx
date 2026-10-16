import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DomainsNav, STATUS_TONE } from "@/components/domains/DomainsNav";
import { DomainRunView, type RunPayload } from "@/components/domains/DomainRunView";
import { canAccessDomainRun, parseSettings, runDomains } from "@/lib/domains/runs";
import { deleteDomainRunAction, restartDomainRunAction, stopDomainRun } from "@/actions/domains";
import { getCountry, RUN_STATUS_LABELS, type DomainRunProgress } from "@/lib/domains/types";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DomainRunPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const run = await prisma.domainRun.findUnique({ where: { id } });
  if (!run || !canAccessDomainRun(me, run)) notFound();
  const settings = parseSettings(run.settings);
  const domains = await runDomains(id);
  const live = run.status === "QUEUED" || run.status === "RUNNING";
  const payload: RunPayload = {
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      progress: (run.progress ?? null) as DomainRunProgress | null,
      totalChecked: run.totalChecked,
      totalAvailable: run.totalAvailable,
      incompleteBrands: Array.isArray(run.incompleteBrands) ? (run.incompleteBrands as string[]) : [],
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      settings,
    },
    domains,
  };
  const country = getCountry(settings.countryCode);

  return (
    <>
      <DomainsNav />
      <PageHeader
        back={{ href: "/gambling/domains", label: "Подборы" }}
        title={run.name}
        subtitle={
          <>
            <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{RUN_STATUS_LABELS[run.status] ?? run.status}</Badge>
            <span className="ml-2">{country?.name ?? settings.countryCode.toUpperCase()} · зоны: {settings.tlds.join(", ")} · {settings.perBrand} на бренд (+{settings.extraPerBrand} запас) · создан {fmtDate(run.createdAt)}{run.finishedAt ? ` · завершён ${fmtDate(run.finishedAt)}` : ""}</span>
          </>
        }
        actions={
          <>
            {live && (
              <ActionForm action={stopDomainRun} className="inline" hidden={{ id: run.id }}>
                <SubmitButton className="btn-danger" pendingText="…" confirm="Остановить подбор? Проверенные домены сохранятся.">Остановить</SubmitButton>
              </ActionForm>
            )}
            {!live && (
              <ActionForm action={restartDomainRunAction} className="inline" hidden={{ id: run.id }}>
                <SubmitButton className="btn-ghost" pendingText="…" confirm="Запустить заново? Все проверенные домены и выбор будут стёрты.">Запустить заново</SubmitButton>
              </ActionForm>
            )}
            <Link href={`/gambling/domains/new?from=${run.id}`} className="btn-ghost">Повторить с этими настройками</Link>
            {!live && (
              <ActionForm action={deleteDomainRunAction} className="inline" hidden={{ id: run.id }}>
                <SubmitButton className="btn-ghost text-danger" pendingText="…" confirm="Удалить подбор вместе со всеми доменами?">Удалить</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="space-y-5">
        <Card title="Настройки подбора">
          <div className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-2">
            <div><span className="label">Приставки, уровень 1</span><span className="font-mono text-[13px]">{settings.suffixTiers[0].join(", ") || "—"}</span></div>
            <div><span className="label">Приставки, уровень 2</span><span className="font-mono text-[13px]">{settings.suffixTiers[1].join(", ") || "—"}</span></div>
            <div><span className="label">Приставки, уровень 3</span><span className="font-mono text-[13px]">{settings.suffixTiers[2].join(", ") || "—"}</span></div>
            <div><span className="label">Дефис</span>{settings.allowHyphen ? "разрешён" : "запрещён"}{settings.serpKeyword ? <> · <span className="label inline">ключ:</span> {settings.serpKeyword}</> : null}</div>
            {settings.serp && (
              <div className="sm:col-span-2"><span className="label">Выдача Google</span><span className="help">{settings.serp.provider === "dataforseo" ? "DataForSEO" : "SerpAPI"} · доменов с брендом: {settings.serp.domains.length} · снято {fmtDate(settings.serp.fetchedAt)}{settings.minedSuffixes.length ? ` · приставки конкурентов: ${settings.minedSuffixes.slice(0, 12).map((m) => `${m.suffix} (${m.count})`).join(", ")}${settings.minedSuffixes.length > 12 ? "…" : ""}` : ""}</span></div>
            )}
          </div>
        </Card>
        <DomainRunView initial={payload} />
      </div>
    </>
  );
}
