import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, sp, type SearchParams } from "@/components/ui";
import { DomainsNav } from "@/components/domains/DomainsNav";
import { NewDomainRunForm } from "@/components/domains/NewDomainRunForm";
import { canAccessDomainRun, domainRunWhere, parseSettings } from "@/lib/domains/runs";
import { DEFAULT_SETTINGS, type DomainRunSettings } from "@/lib/domains/types";

export const dynamic = "force-dynamic";

/** Новый подбор: форма с настройками; ?from=<id> подставляет настройки другого подбора («Повторить»). */
export default async function NewDomainRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const from = sp(params, "from");
  let defaults: DomainRunSettings = DEFAULT_SETTINGS;
  let name = "";
  if (from) {
    const run = await prisma.domainRun.findUnique({ where: { id: from } });
    if (run && canAccessDomainRun(me, run)) {
      defaults = parseSettings(run.settings);
      name = `${run.name} (повтор)`;
    }
  } else {
    // Удобный старт: зоны, приставки и страна из последнего подбора пользователя, бренды пустые.
    const last = await prisma.domainRun.findFirst({ where: { ...domainRunWhere(me), createdById: me.id }, orderBy: { createdAt: "desc" } });
    if (last) defaults = { ...parseSettings(last.settings), brands: [], minedSuffixes: [], serp: null };
  }
  return (
    <>
      <DomainsNav />
      <PageHeader back={{ href: "/gambling/domains", label: "Подборы" }} title="Новый подбор" subtitle="Вставьте бренды, задайте зоны и приставки по уровням. При желании сначала снимите выдачу Google: она подскажет, какие приставки и зоны используют конкуренты." />
      <NewDomainRunForm defaults={defaults} initialName={name} />
    </>
  );
}
