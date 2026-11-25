import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DomainsNav, STATUS_TONE } from "@/components/domains/DomainsNav";
import { DomainRunView, type RunPayload } from "@/components/domains/DomainRunView";
import { EmdRunView } from "@/components/domains/EmdRunView";
import { RenameRun } from "@/components/domains/RenameRun";
import { canAccessDomainRun, parseSettings, runDomains } from "@/lib/domains/runs";
import { deleteDomainRunAction, restartDomainRunAction, stopDomainRun } from "@/actions/domains";
import { getCountry, LETTER_MODE_LABELS, RUN_STATUS_LABELS, type DomainRunProgress } from "@/lib/domains/types";
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
  const countries = Array.from(new Set(settings.items.map((it) => it.country)));
  const countryNames = countries.map((c) => getCountry(c)?.name ?? c.toUpperCase()).join(", ");
  const isEmd = settings.mode === "emd";
  const emdKeywords = settings.items.reduce((a, it) => a + (it.emd?.keywords.length ?? 0), 0);
  const emdGrid = settings.emd ? (
    <div className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-2">
      <div className="sm:col-span-2"><span className="label">Таблица</span><a href={settings.emd.sourceUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">{settings.emd.fileName || settings.emd.sourceUrl}</a> <span className="help">· загружена {fmtDate(settings.emd.loadedAt)} · кластеров {settings.items.length} · ключей {emdKeywords}</span></div>
      <div><span className="label">Ключи в домены</span>тема кластера + ключи с частотой от {settings.emd.minVolume} · метка до {settings.emd.maxLen} символов{settings.allowHyphen ? " · с дефисом" : ""}</div>
      <div><span className="label">Зоны</span>зона страны{settings.tlds.length ? `, ${settings.tlds.join(", ")}` : ""}{settings.autoZones ? " · из таблицы и выдачи" : ""}</div>
      <div><span className="label">Выдача Google</span>{settings.autoResearch ? `TOP-10 по каждому ключу · подсветка от ${settings.emd.matchPct}% ключа в домене` : "не снимали"}</div>
      <div><span className="label">Доменов на кластер</span>{settings.perBrand}</div>
    </div>
  ) : null;
  const settingsGrid = isEmd ? emdGrid : (
    <div className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-2">
      <div><span className="label">Общие приставки, уровень 1</span><span className="font-mono text-[13px]">{settings.suffixTiers[0].join(", ") || "—"}</span></div>
      <div><span className="label">Общие приставки, уровень 2</span><span className="font-mono text-[13px]">{settings.suffixTiers[1].join(", ") || "—"}</span></div>
      <div><span className="label">Общие приставки, уровень 3</span><span className="font-mono text-[13px]">{settings.suffixTiers[2].join(", ") || "—"}</span></div>
      {countries.filter((c) => settings.countryPresets[c]).map((c) => {
        const p = settings.countryPresets[c]!;
        return (
          <div key={c}><span className="label">Набор страны {c.toUpperCase()}</span><span className="font-mono text-[13px]">1: {p.tiers[0].join(", ") || "—"} · 2: {p.tiers[1].join(", ") || "—"} · 3: {p.tiers[2].join(", ") || "—"}{p.tlds.length ? ` · зоны: ${p.tlds.join(", ")}` : ""}</span></div>
        );
      })}
      <div><span className="label">Бренд + буква</span>{LETTER_MODE_LABELS[settings.letterMode]} · анализ ключевых слов: {settings.useKeywords ? "да" : "нет"} · запас модификаторов (уровни 4–6): {settings.usePool ? "да" : "нет"} · брендов с модификаторами: {settings.items.filter((it) => it.modifiers.length).length}</div>
      <div><span className="label">Дефис</span>{settings.allowHyphen ? "разрешён" : "запрещён"}{settings.serpKeyword ? <> · <span className="label inline">ключ:</span> {settings.serpKeyword}</> : null}</div>
      {settings.serp && (
        <div className="sm:col-span-2"><span className="label">Выдача Google</span><span className="help">{settings.serp.provider === "dataforseo" ? "DataForSEO" : "SerpAPI"} · доменов с брендом: {settings.serp.domains.length} · снято {fmtDate(settings.serp.fetchedAt)}{settings.minedSuffixes.length ? ` · приставки конкурентов: ${settings.minedSuffixes.slice(0, 12).map((m) => `${m.suffix} (${m.count})`).join(", ")}${settings.minedSuffixes.length > 12 ? "…" : ""}` : ""}</span></div>
      )}
    </div>
  );

  return (
    <>
      <DomainsNav />
      <PageHeader
        back={{ href: "/gambling/domains", label: "Подборы" }}
        title={run.name}
        subtitle={
          <>
            <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{RUN_STATUS_LABELS[run.status] ?? run.status}</Badge>
            <span className="ml-2">{isEmd ? "EMD по ключам · " : ""}{countryNames} · зоны: {settings.tlds.join(", ")} · {settings.perBrand} {isEmd ? "на кластер" : `на бренд (+${settings.extraPerBrand} запас)`} · создан {fmtDate(run.createdAt)}{run.finishedAt ? ` · завершён ${fmtDate(run.finishedAt)}` : ""}</span>
          </>
        }
        actions={
          <>
            <RenameRun id={run.id} name={run.name} />
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
            <Link href={isEmd ? `/gambling/domains/emd/new?from=${run.id}` : `/gambling/domains/new?from=${run.id}`} className="btn-ghost">Повторить с этими настройками</Link>
            {!live && (
              <ActionForm action={deleteDomainRunAction} className="inline" hidden={{ id: run.id }}>
                <SubmitButton className="btn-ghost text-danger" pendingText="…" confirm="Удалить подбор вместе со всеми доменами?">Удалить</SubmitButton>
              </ActionForm>
            )}
          </>
        }
      />

      <div className="space-y-5">
        {/* На телефоне настройки свёрнуты — иначе до результатов долго листать. */}
        <details className="card p-4 sm:hidden">
          <summary className="h2 cursor-pointer select-none">Настройки подбора</summary>
          <div className="mt-3">{settingsGrid}</div>
        </details>
        <Card title="Настройки подбора" className="hidden sm:block">{settingsGrid}</Card>
        {isEmd ? <EmdRunView initial={payload} /> : <DomainRunView initial={payload} />}
      </div>
    </>
  );
}
