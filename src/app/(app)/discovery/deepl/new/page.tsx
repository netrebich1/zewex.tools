import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, sp, type SearchParams } from "@/components/ui";
import { DeeplHeader } from "@/components/deepl/DeeplHeader";
import { NewJobForm } from "@/components/deepl/NewJobForm";
import { listSites } from "@/lib/deepl/wp";
import { canAccessJob } from "@/lib/deepl/jobs";
import { DEFAULT_SETTINGS, parseSettings, type DeeplSettings } from "@/lib/deepl/types";

export const dynamic = "force-dynamic";

export default async function NewDeeplJob({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const [sites, prompts, scenarios, binding, deeplKeys] = await Promise.all([
    listSites(me),
    prisma.deeplPrompt.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, purpose: true } }),
    prisma.deeplScenario.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, settings: true } }),
    prisma.slot.findFirst({ where: { key: "text_main", project: { slug: "deepl" } }, select: { _count: { select: { bindings: true } } } }),
    prisma.deeplKey.count({ where: { isActive: true } }),
  ]);

  // «Повторить с этими настройками»: сайт и настройки из прошлого прогона, иначе первый сценарий.
  let initial: DeeplSettings = scenarios[0] ? parseSettings(scenarios[0].settings) : DEFAULT_SETTINGS;
  let initialSite = sites[0]?.id ?? "";
  const from = sp(params, "from");
  if (from) {
    const job = await prisma.deeplJob.findUnique({ where: { id: from } });
    if (job && canAccessJob(me, job)) {
      initial = parseSettings(job.settings);
      if (job.accessId && sites.some((s) => s.id === job.accessId)) initialSite = job.accessId;
    }
  }

  return (
    <>
      <DeeplHeader />
      <PageHeader
        back={{ href: "/discovery/deepl", label: "Прогоны" }}
        title="Новый прогон"
        subtitle="1) найдите статьи на сайте по статусу и дате публикации; 2) выберите сценарий или настройте цепочку; 3) запустите — статьи обрабатываются параллельно в фоне."
      />
      <NewJobForm
        sites={sites}
        prompts={prompts}
        scenarios={scenarios.map((s) => ({ id: s.id, name: s.name, settings: parseSettings(s.settings) }))}
        initial={initial}
        initialSite={initialSite}
        hasEditKey={(binding?._count.bindings ?? 0) > 0}
        isAdmin={me.role === "ADMIN"}
        deeplKeys={deeplKeys}
      />
    </>
  );
}
