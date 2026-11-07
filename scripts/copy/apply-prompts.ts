/**
 * Наборы промптов и сценарии «Article Copy» (мешап): клонируют боевые наборы реальных фото по нишам и подменяют
 * текстовые шаги файлами из prompts/copy/<ниша>-<stageKey>.txt. Идемпотентно: повторный запуск обновляет тексты.
 *   sudo -u zewex_tools_usr -H npx tsx scripts/copy/apply-prompts.ts [--dry]
 * Сценарий мешапа: ArtRecipe.forCopy = true, модель планирования — gemini-2.5-flash (не lite: меньше путает photo_n).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

const DRY = process.argv.includes("--dry");
const DIR = join(process.cwd(), "prompts", "copy");
/** Боевые сценарии реальных фото по нишам (номера на странице «Сценарии»). */
const SOURCE: Array<{ niche: string; recipeNumber: number }> = [
  { niche: "nails", recipeNumber: 2 },
  { niche: "hair", recipeNumber: 5 },
  { niche: "outfits", recipeNumber: 7 },
];
const PLAN_MODEL = "openrouter:google/gemini-2.5-flash";

function fromFile(niche: string, stageKey: string): { system: string | null; text: string } | null {
  const f = join(DIR, `${niche}-${stageKey}.txt`);
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const m = /===SYSTEM===\n([\s\S]*?)\n===TEXT===\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${f}: нет блоков ===SYSTEM=== / ===TEXT===`);
  const system = m[1].trim();
  return { system: system || null, text: m[2].trim() + "\n" };
}

async function main() {
  for (const src of SOURCE) {
    const recipe = await prisma.artRecipe.findFirst({ where: { number: src.recipeNumber } });
    if (!recipe?.promptSetId) throw new Error(`Сценарий №${src.recipeNumber} не найден или без набора`);
    const set = await prisma.artPromptSet.findUnique({ where: { id: recipe.promptSetId }, include: { prompts: true } });
    if (!set) throw new Error(`Набор ${recipe.promptSetId} не найден`);
    const targetName = `${set.name} · Article Copy`;
    let target = await prisma.artPromptSet.findFirst({ where: { name: targetName }, include: { prompts: true } });
    if (!target) {
      const id = randomUUID();
      console.log(`+ набор «${targetName}»`);
      if (!DRY) await prisma.artPromptSet.create({ data: { id, name: targetName, description: `Мешап-статьи Article Copy. Исходник: «${set.name}». Тексты шагов — prompts/copy/${src.niche}-*.txt в репозитории.`, nicheCode: set.nicheCode, subnicheCode: set.subnicheCode, format: set.format, isActive: true } });
      target = { ...set, id, name: targetName, prompts: [] };
    }
    const idByStage = new Map<string, string>();
    for (const p of set.prompts) {
      const file = fromFile(src.niche, p.stageKey);
      const existing = target.prompts.find((t) => t.stageKey === p.stageKey);
      const data = { name: file ? `${p.name} · Copy` : p.name, system: file ? file.system : p.system, text: file ? file.text : p.text, model: p.model, isActive: true };
      if (existing) {
        idByStage.set(p.stageKey, existing.id);
        const changed = existing.text !== data.text || (existing.system ?? null) !== (data.system ?? null);
        if (changed) { console.log(`  ~ ${src.niche}/${p.stageKey}${file ? " (из файла)" : ""}`); if (!DRY) await prisma.artPrompt.update({ where: { id: existing.id }, data }); }
      } else {
        const id = randomUUID();
        idByStage.set(p.stageKey, id);
        console.log(`  + ${src.niche}/${p.stageKey}${file ? " (из файла)" : " (копия)"}`);
        if (!DRY) await prisma.artPrompt.create({ data: { id, setId: target.id, stageKey: p.stageKey, ...data } });
      }
    }
    // Сценарий мешапа.
    const stagePromptIds: Record<string, string> = {};
    for (const [k, v] of Object.entries((recipe.stagePromptIds as Record<string, string> | null) ?? {})) {
      const srcPrompt = set.prompts.find((p) => p.id === v);
      stagePromptIds[k] = srcPrompt ? idByStage.get(srcPrompt.stageKey) ?? v : v;
    }
    for (const [k, v] of idByStage) if (!stagePromptIds[k]) stagePromptIds[k] = v;
    const stageModels = { ...((recipe.stageModels as Record<string, string> | null) ?? {}), rp_photo_plan: PLAN_MODEL };
    const copyRecipe = await prisma.artRecipe.findFirst({ where: { forCopy: true, nicheCode: recipe.nicheCode, format: recipe.format } });
    const data: Prisma.ArtRecipeUncheckedCreateInput = {
      id: copyRecipe?.id ?? randomUUID(), number: copyRecipe?.number ?? ((await prisma.artRecipe.aggregate({ _max: { number: true } }))._max.number ?? 0) + 1,
      name: `${recipe.name} · Article Copy`, description: `Сценарий мешап-статей (Article Copy). Исходник: №${recipe.number}. Правится скриптом scripts/copy/apply-prompts.ts.`,
      nicheCode: recipe.nicheCode, subnicheCode: recipe.subnicheCode, format: recipe.format, promptSetId: target.id, isActive: true, isDefault: false, forCopy: true,
      stagePromptIds, stageModels, text: recipe.text as Prisma.InputJsonValue, images: recipe.images as Prisma.InputJsonValue, photoSearch: recipe.photoSearch as Prisma.InputJsonValue, publish: recipe.publish as Prisma.InputJsonValue,
    };
    console.log(`${copyRecipe ? "~" : "+"} сценарий №${data.number} «${data.name}»`);
    if (!DRY) {
      if (copyRecipe) await prisma.artRecipe.update({ where: { id: copyRecipe.id }, data: { ...data, id: undefined, number: undefined } });
      else await prisma.artRecipe.create({ data });
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
