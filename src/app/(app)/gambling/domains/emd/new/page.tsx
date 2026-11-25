import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, sp, type SearchParams } from "@/components/ui";
import { DomainsNav } from "@/components/domains/DomainsNav";
import { RunTypeSwitch } from "@/components/domains/RunTypeSwitch";
import { EmdRunForm, EMD_FORM_DEFAULTS, type EmdFormDefaults } from "@/components/domains/EmdRunForm";
import { canAccessDomainRun, parseSettings } from "@/lib/domains/runs";

export const dynamic = "force-dynamic";

/** Новый подбор EMD по кластерам ключей; ?from=<id> подставляет настройки другого подбора EMD («Повторить»). */
export default async function NewEmdRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const from = sp(await searchParams, "from");
  let defaults: EmdFormDefaults = EMD_FORM_DEFAULTS;
  if (from) {
    const run = await prisma.domainRun.findUnique({ where: { id: from } });
    if (run && canAccessDomainRun(me, run)) {
      const s = parseSettings(run.settings);
      if (s.mode === "emd" && s.emd) {
        defaults = { sourceUrl: s.emd.sourceUrl, name: `${run.name} (повтор)`, minVolume: s.emd.minVolume, maxLen: s.emd.maxLen, matchPct: s.emd.matchPct, perCluster: s.perBrand, tlds: s.tlds.join(", "), allowHyphen: s.allowHyphen, serp: s.autoResearch, autoZones: s.autoZones };
      }
    }
  }
  return (
    <>
      <DomainsNav />
      <PageHeader back={{ href: "/gambling/domains", label: "Подборы" }} title="EMD по ключам" subtitle="Домены точного вхождения под кластеры ключей: тема и ключи темы из выгрузки «Наблюдение кластеры», выдача Google по каждому ключу, проверка свободности." />
      <RunTypeSwitch active="emd" />
      <EmdRunForm defaults={defaults} />
    </>
  );
}
