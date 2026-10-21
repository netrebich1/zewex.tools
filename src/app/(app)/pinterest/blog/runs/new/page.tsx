import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader, type SearchParams, sp } from "@/components/ui";
import { blogSiteWhere } from "@/lib/blog/access";
import { mergeSiteSettings } from "@/lib/blog/types";
import { recipeReadiness, recipeShape, userSlots } from "@/lib/blog/recipes";
import { NewBlogRunForm, type RunFormRecipe, type RunFormSite } from "@/components/blog/NewBlogRunForm";

export const dynamic = "force-dynamic";

/** Новый запуск инфо-статей: сайт → рецепт → ключи → параметры. */
export default async function NewBlogRunPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const preset = sp(await searchParams, "site");
  const [sites, recipes, have] = await Promise.all([
    prisma.blogSite.findMany({ where: { ...(await blogSiteWhere(me)), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, defaultRecipeId: true, accessId: true, settings: true, wpCategories: true } }),
    prisma.blogRecipe.findMany({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
    userSlots(me),
  ]);
  const siteRows: RunFormSite[] = sites.map((s) => ({ id: s.id, name: s.name, defaultRecipeId: s.defaultRecipeId, hasAccess: !!s.accessId, categoriesCount: Array.isArray(s.wpCategories) ? (s.wpCategories as unknown[]).length : 0, settings: mergeSiteSettings(s.settings) }));
  const recipeRows: RunFormRecipe[] = recipes.map((r) => { const shape = recipeShape(r); return { id: r.id, name: r.name, description: r.description, isDefault: r.isDefault, length: shape.params.length, images: { min: shape.params.images.min, max: shape.params.images.max }, readiness: recipeReadiness(shape, have) }; });
  return (
    <>
      <PageHeader back={{ href: "/pinterest/blog", label: "Обзор" }} title="Новый запуск" subtitle="Выберите сайт и рецепт, вставьте список тем (по одной в строке), проверьте параметры и запустите. Каждая строка станет отдельной статьёй в очереди." />
      <Card><NewBlogRunForm sites={siteRows} recipes={recipeRows} presetSiteId={preset} /></Card>
    </>
  );
}
