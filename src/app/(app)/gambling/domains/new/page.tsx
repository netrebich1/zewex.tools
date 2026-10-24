import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PageHeader, sp, type SearchParams } from "@/components/ui";
import { DomainsNav } from "@/components/domains/DomainsNav";
import { NewDomainRunForm } from "@/components/domains/NewDomainRunForm";
import { canAccessDomainRun, domainRunWhere, parseSettings } from "@/lib/domains/runs";
import { DEFAULT_SETTINGS, type CountryPreset, type DomainRunSettings } from "@/lib/domains/types";
import { defaultCountryPreset } from "@/lib/domains/presets";

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
    // Удобный старт: зоны, приставки и правила из последнего подбора пользователя, бренды пустые.
    // Подбор старого формата (до наборов стран) не берём: его гео-приставки теперь живут в наборах стран.
    const last = await prisma.domainRun.findFirst({ where: { ...domainRunWhere(me), createdById: me.id }, orderBy: { createdAt: "desc" } });
    if (last) {
      const s = parseSettings(last.settings);
      const modern = Array.isArray((last.settings as { items?: unknown } | null)?.items);
      defaults = modern
        ? { ...s, brands: [], items: [], countryPresets: {}, minedSuffixes: [], serp: null }
        : { ...DEFAULT_SETTINGS, countryCode: s.countryCode, perBrand: s.perBrand, extraPerBrand: s.extraPerBrand };
    }
  }
  // Режим «максимум» по умолчанию всегда (старые подборы его не знали): ключи и выдача, все варианты, зона страны и зоны конкурентов; снять можно в форме
  defaults = { ...defaults, autoResearch: true, checkAll: true, autoZones: true };
  const savedPresets: Record<string, CountryPreset> = {};
  for (const p of await prisma.domainCountryPreset.findMany()) savedPresets[p.countryCode] = defaultCountryPreset(p.countryCode, p.tlds);
  return (
    <>
      <DomainsNav />
      <PageHeader back={{ href: "/gambling/domains", label: "Подборы" }} title="Новый подбор" subtitle="Добавьте бренды с кодами стран (можно пачками по странам) — гео-приставки каждой страны система подставит сама. При желании соберите ключевые слова брендов и снимите выдачу Google — они подскажут модификаторы и зоны." />
      <NewDomainRunForm defaults={defaults} initialName={name} savedPresets={savedPresets} />
    </>
  );
}
