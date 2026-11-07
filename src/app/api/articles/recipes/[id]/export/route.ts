import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { recipeShape } from "@/lib/articles/recipes";

export const dynamic = "force-dynamic";

/** Экспорт рецепта с набором промтов в JSON (для переноса между инсталляциями и резервной копии). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const { id } = await ctx.params;
  const r = await prisma.artRecipe.findUnique({ where: { id }, include: { promptSet: { include: { prompts: { orderBy: [{ stageKey: "asc" }, { createdAt: "asc" }] } } } } });
  if (!r) return NextResponse.json({ error: "Рецепт не найден" }, { status: 404 });
  const shape = recipeShape(r);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    recipe: { ...shape, number: r.number, description: r.description, isActive: r.isActive, isDefault: r.isDefault },
    promptSet: r.promptSet
      ? {
          id: r.promptSet.id,
          name: r.promptSet.name,
          description: r.promptSet.description,
          nicheCode: r.promptSet.nicheCode,
          subnicheCode: r.promptSet.subnicheCode,
          format: r.promptSet.format,
          isActive: r.promptSet.isActive,
          prompts: r.promptSet.prompts.map((p) => ({ id: p.id, stageKey: p.stageKey, name: p.name, system: p.system, text: p.text, model: p.model, isActive: p.isActive })),
        }
      : null,
  };
  const fname = `recipe-${(r.number ?? "")}-${r.name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || id.slice(0, 8)}.json`;
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${encodeURIComponent(fname)}"`, "Cache-Control": "no-store" },
  });
}
