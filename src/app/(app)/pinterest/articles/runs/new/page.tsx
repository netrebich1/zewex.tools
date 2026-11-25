import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { artSiteWhere } from "@/lib/articles/access";
import { mergeSiteSettings } from "@/lib/articles/types";
import { recipeReadiness, recipeShape, userSlots } from "@/lib/articles/launch";
import { sheetsConnection, siteDomains } from "@/lib/articles/sheets";
import { NewArticlesRunForm, type RunFormRecipe, type RunFormSite } from "@/components/articles/NewArticlesRunForm";

export const dynamic = "force-dynamic";

/** Новый запуск статей: сайт → сценарий (готовность промтов и ключей) → ключи (списком или из Google Таблицы) → параметры. */
export default async function NewArticlesRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const preset = sp(await searchParams, "site");
  const [sites, recipes, niches, have, sheets] = await Promise.all([
    prisma.artSite.findMany({ where: { ...(await artSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, nicheCode: true, defaultRecipeId: true, accessId: true, settings: true, wpCategories: true, access: { select: { baseUrl: true, linkDomain: true, name: true } } } }),
    prisma.artRecipe.findMany({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    prisma.artNiche.findMany({ select: { code: true, name: true } }),
    userSlots(me),
    sheetsConnection(),
  ]);
  const nicheName = (code: string | null) => niches.find((n) => n.code === code)?.name ?? code ?? null;
  const siteRows: RunFormSite[] = sites.map((s) => ({
    id: s.id, name: s.name, nicheCode: s.nicheCode, nicheName: nicheName(s.nicheCode), defaultRecipeId: s.defaultRecipeId, hasAccess: !!s.accessId,
    categoriesCount: Array.isArray(s.wpCategories) ? (s.wpCategories as unknown[]).length : 0, settings: mergeSiteSettings(s.settings), domain: siteDomains(s)[0] ?? "",
  }));
  const recipeRows: RunFormRecipe[] = await Promise.all(recipes.map(async (r) => {
    const shape = recipeShape(r);
    return { id: r.id, name: r.name, description: r.description, nicheCode: r.nicheCode, nicheName: nicheName(r.nicheCode) ?? r.nicheCode, format: r.format, isDefault: r.isDefault, readiness: await recipeReadiness(shape, have) };
  }));

  return (
    <>
      <PageHeader back={{ href: "/pinterest/articles", label: "Обзор" }} title="Новый запуск" subtitle="Выберите сайт и сценарий, вставьте список ключей (по одному в строке) или возьмите их из Google Таблицы, проверьте параметры и запустите. Каждая строка станет отдельной статьёй в очереди." />
      <Card><NewArticlesRunForm sites={siteRows} recipes={recipeRows} presetSiteId={preset} sheets={sheets} /></Card>
    </>
  );
}
