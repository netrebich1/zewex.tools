import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { NewRunForm } from "@/components/pins/NewRunForm";
import { mergeRecipe, runDefaultsFrom } from "@/lib/pins/types";
import { pinSiteWhere } from "@/lib/sites/access";
import { recipeFieldsData } from "@/components/sites/PinsRecipeForm";
import { siteDomains } from "@/lib/pins/siteDomains";

export const dynamic = "force-dynamic";

export default async function NewRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const preset = sp(params, "site");
  const sites = await prisma.pinSite.findMany({
    where: { ...(await pinSiteWhere(me)), isActive: true }, orderBy: { name: "asc" },
    select: { id: true, name: true, recipe: true, wpConnectionId: true, _count: { select: { boards: true } }, sets: true },
  });
  // Настройки прогона подставляются из последнего прогона каждого сайта (сайт хранит только стили, язык, доски).
  const lastRuns = await prisma.pinRun.findMany({
    where: { siteId: { in: sites.map((s) => s.id) }, NOT: { name: "__system__" } },
    orderBy: { createdAt: "desc" }, distinct: ["siteId"], select: { siteId: true, settings: true, name: true, createdAt: true },
  });
  const conns = await prisma.siteAccess.findMany({ where: { id: { in: sites.flatMap((s) => [s.wpConnectionId, mergeRecipe(s.recipe).publishing.wpConnectionId]).filter((x): x is string => !!x) } }, select: { id: true, baseUrl: true, linkDomain: true } });
  const rows = await Promise.all(sites.map(async (s) => {
    const r = mergeRecipe(s.recipe);
    const conn = conns.find((c) => c.id === (r.publishing.wpConnectionId || s.wpConnectionId));
    const last = lastRuns.find((x) => x.siteId === s.id);
    const run = runDefaultsFrom(s.recipe, last?.settings ?? null);
    return {
      id: s.id, name: s.name, per: run.mix.ai + run.mix.photos + run.mix.canvas + run.mix.pinora, perDay: run.schedule.pinsPerDay, boards: s._count.boards,
      hasWp: !!(s.wpConnectionId || r.publishing.wpConnectionId), aiSets: r.sets.aiSetIds.length, canvasStyles: (r.sets.canvasStyleIds ?? []).length, mix: run.mix,
      domains: siteDomains([s.name, conn?.baseUrl, conn?.linkDomain, r.publishing.linkDomain]),
      recipe: run, lastRun: last ? { name: last.name, at: last.createdAt.toLocaleDateString("ru-RU") } : null,
      fields: await recipeFieldsData(s.sets),
    };
  }));

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins", label: "Сегодня" }} title="Новый прогон" subtitle="Выберите сайт и режим, добавьте ссылки вручную или подтяните статьи из WordPress, задайте сколько пинов и по какому расписанию, затем запустите." />
      <Card><NewRunForm sites={rows} presetSiteId={preset} /></Card>
    </>
  );
}
