import Link from "next/link";
import { Card, Field } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveBoards, saveRecipe } from "@/actions/pins";
import { mergeRecipe } from "@/lib/pins/types";
import { PINORA_TYPES } from "@/lib/pins/prompts/pinora";
import { RecipeFields, type RecipeFieldsData } from "@/components/pins/RecipeFields";
import type { PinBoard, PinSet, PinSite, SiteAccess } from "@prisma/client";

export const NICHES = [["", "— не задана —"], ["decor", "Декор и интерьер"], ["nails", "Ногти"], ["hair", "Причёски"], ["outfit", "Одежда"], ["cooking", "Рецепты"], ["other", "Другое"]];

type Props = { site: PinSite & { boards: PinBoard[]; sets: PinSet[] }; wps: Pick<SiteAccess, "id" | "name">[] };

/** Данные для полей рецепта из наборов сайта. */
export function recipeFieldsData(sets: PinSet[], wps?: Pick<SiteAccess, "id" | "name">[]): RecipeFieldsData {
  const opt = (s: PinSet) => ({ id: s.id, name: s.name, count: (s.styleIds as string[]).length, topic: s.topic || undefined });
  return {
    aiSets: sets.filter((s) => s.setKind === "ai").map(opt),
    canvasSets: sets.filter((s) => s.setKind === "canvas").map(opt),
    pinoraTypes: PINORA_TYPES.map((t) => ({ id: t.id, ru: t.ru })),
    ...(wps ? { wps: wps.map((w) => ({ id: w.id, name: w.name })) } : {}),
  };
}

/** Настройки Pinterest Pins для сайта: рецепт по умолчанию для прогонов и доски. */
export function PinsRecipeForm({ site, wps }: Props) {
  const id = site.id;
  const r = mergeRecipe(site.recipe);
  return (
    <>
      <Card title="Pinterest Pins: рецепт по умолчанию" description="Эти настройки подставляются в каждый новый прогон; там их можно изменить для конкретного прогона.">
        <ActionForm action={saveRecipe} hidden={{ id }} className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Название сайта"><input name="name" className="input" defaultValue={site.name} /></Field>
            <Field label="Ниша" hint="Влияет на умную обрезку фото и подбор стилей."><select name="niche" className="input" defaultValue={site.niche}>{NICHES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <p className="help">Наборы стилей собираются в разделе <Link href={`/pinterest/pins/styles?tab=ai&site=${id}`} className="underline">«Стили» сервиса</Link>: там видно, как выглядит каждый ИИ-стиль и Canvas-шаблон.</p>
          <RecipeFields r={r} data={recipeFieldsData(site.sets, wps)} />
          <SubmitButton pendingText="Сохраняю…">Сохранить рецепт</SubmitButton>
        </ActionForm>
      </Card>

      <Card title="Доски Pinterest" description="По одной в строке. ИИ выбирает доску для каждой статьи из этого списка.">
        <ActionForm action={saveBoards} hidden={{ id }}>
          <textarea name="boards" className="input font-mono text-[13px]" rows={Math.min(16, Math.max(5, site.boards.length + 1))} defaultValue={site.boards.map((b) => b.name).join("\n")} />
          <SubmitButton pendingText="…">Сохранить доски</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
