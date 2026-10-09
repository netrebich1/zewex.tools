import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { NewRunForm } from "@/components/pins/NewRunForm";
import { mergeRecipe } from "@/lib/pins/types";
import { recipeFieldsData } from "@/components/sites/PinsRecipeForm";

export const dynamic = "force-dynamic";

export default async function NewRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const preset = sp(params, "site");
  const sites = await prisma.pinSite.findMany({
    where: { ...(me.role === "ADMIN" ? {} : { teamId: { in: me.teamIds } }), isActive: true }, orderBy: { name: "asc" },
    select: { id: true, name: true, recipe: true, wpConnectionId: true, _count: { select: { boards: true } }, sets: true },
  });
  const rows = sites.map((s) => {
    const r = mergeRecipe(s.recipe);
    return {
      id: s.id, name: s.name, per: r.mix.ai + r.mix.photos + r.mix.canvas + r.mix.pinora, perDay: r.schedule.pinsPerDay, boards: s._count.boards,
      hasWp: !!(r.publishing.wpConnectionId || s.wpConnectionId), aiSets: r.sets.aiSetIds.length, canvasSets: r.sets.canvasSetIds.length, mix: r.mix,
      recipe: r, fields: recipeFieldsData(s.sets),
    };
  });

  return (
    <>
      <PageHeader back={{ href: "/pinterest/pins", label: "Сегодня" }} title="Новый прогон" subtitle="Выберите сайт и режим, добавьте ссылки вручную или подтяните статьи из WordPress, затем запустите." />
      <Card><NewRunForm sites={rows} presetSiteId={preset} /></Card>
    </>
  );
}
