"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ArtFormat } from "@prisma/client";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Field } from "@/components/ui";
import { launchArticlesAction } from "@/actions/articles";
import type { RecipeReadiness } from "@/lib/articles/launch";
import { PUBLISH_MODES, type ArtSiteSettings } from "@/lib/articles/types";
import { KeywordsInput } from "./KeywordsInput";
import { RunParamsFields } from "./RunParamsFields";
import { SheetImport } from "./SheetImport";

export type RunFormSite = { id: string; name: string; nicheCode: string | null; nicheName: string | null; defaultRecipeId: string | null; hasAccess: boolean; categoriesCount: number; settings: ArtSiteSettings; /** Домен сайта = название вкладки Google Таблицы */ domain: string };
export type RunFormRecipe = { id: string; name: string; description: string | null; nicheCode: string; nicheName: string; format: ArtFormat; isDefault: boolean; readiness: RecipeReadiness };

export const FORMAT_LABELS: Record<ArtFormat, string> = { REAL_PHOTO: "Реальные фото", GENERATED_PHOTO: "ИИ-картинки" };

/**
 * Новый запуск по шагам: 1) сайт → 2) рецепт (по нише сайта, с готовностью промтов и ключей) → 3) ключи → 4) параметры.
 * Ключи — списком или из Google Таблицы (SheetImport): во втором случае рецепт и режим каждой статьи берутся из строки таблицы.
 * Параметры заполняются из настроек сайта и относятся только к этому запуску (сохраняются в ArtRun.settings и в снимок каждой статьи).
 */
export function NewArticlesRunForm({ sites, recipes, presetSiteId, sheets }: { sites: RunFormSite[]; recipes: RunFormRecipe[]; presetSiteId?: string; sheets: { connected: boolean; email: string | null } }) {
  const [siteId, setSiteId] = useState(presetSiteId && sites.some((s) => s.id === presetSiteId) ? presetSiteId : sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId);
  const [allRecipes, setAllRecipes] = useState(false);
  const list = useMemo(() => {
    const byNiche = site?.nicheCode ? recipes.filter((r) => r.nicheCode === site.nicheCode) : recipes;
    return allRecipes || !byNiche.length ? recipes : byNiche;
  }, [recipes, site, allRecipes]);
  const pickDefault = (s?: RunFormSite) => (s?.defaultRecipeId && recipes.some((r) => r.id === s.defaultRecipeId) ? s.defaultRecipeId : list.find((r) => r.readiness.ok)?.id ?? list[0]?.id ?? "");
  const [recipeId, setRecipeId] = useState(() => pickDefault(site));
  const recipe = recipes.find((r) => r.id === recipeId);
  const [count, setCount] = useState(0);
  const [source, setSource] = useState<"manual" | "sheet">("manual");
  const fromSheet = source === "sheet";

  // Смена сайта: рецепт по умолчанию из настроек сайта, параметры — из настроек сайта (через key на секции)
  useEffect(() => {
    setRecipeId(pickDefault(site));
    setAllRecipes(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const warnings: string[] = [];
  if (site && !site.hasAccess) warnings.push("У сайта нет доступа WordPress: публикация не пройдёт. Привяжите доступ в разделе «Сайты».");
  if (site && !site.nicheCode) warnings.push("У сайта не задана ниша: показаны все рецепты. Задайте нишу в настройках сайта, чтобы видеть только подходящие.");
  if (site && site.settings.publishMode !== "moderate_first" && !site.categoriesCount) warnings.push("Категории WordPress не синхронизированы: при публикации категория будет выбрана по умолчанию WordPress. Нажмите «Синхронизировать категории» в настройках сайта.");

  return (
    <ActionForm action={launchArticlesAction} className="space-y-6">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="recipeId" value={recipeId} />

      <section className="space-y-2">
        <div className="font-medium">1. Сайт</div>
        {sites.length === 0 ? (
          <Alert tone="warn">Сайтов в сервисе нет. Откройте <Link href="/pinterest/articles/sites" className="underline">«Сайты»</Link> и подключите сайт.</Alert>
        ) : (
          <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}{s.nicheName ? ` — ${s.nicheName}` : ""}</option>)}
          </select>
        )}
        {site && <p className="help">Ниша: {site.nicheName ?? "не задана"} · модерация фото до текста: {site.settings.photoReview ? "включена" : "выключена"} · публикация: {PUBLISH_MODES.find((m) => m.value === site.settings.publishMode)?.label} · <Link href={`/pinterest/articles/sites/${site.id}?tab=settings`} className="underline">настройки сайта</Link></p>}
        {warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <div className="font-medium">2. Рецепт</div>
          <span className="help">Рецепт = ниша + формат + промты и модели каждого шага. {site?.nicheCode && <button type="button" className="underline" onClick={() => setAllRecipes((v) => !v)}>{allRecipes ? "только для ниши сайта" : "показать все рецепты"}</button>}</span>
        </div>
        {fromSheet ? (
          <Alert tone="neutral">Ключи берутся из Google Таблицы: рецепт каждой статьи задаёт колонка «Сценарий» — это номер рецепта (№ на странице <Link href="/pinterest/articles/recipes" className="underline">«Рецепты»</Link>). Выбирать рецепт здесь не нужно.</Alert>
        ) : list.length === 0 ? <Alert tone="warn">Рецептов нет. Создайте рецепт в разделе <Link href="/pinterest/articles/recipes" className="underline">«Рецепты»</Link>.</Alert> : (
          <div className="grid gap-2 sm:grid-cols-2">
            {list.map((r) => {
              const on = r.id === recipeId;
              return (
                <label key={r.id} className={`rounded-xl border p-3 cursor-pointer ${on ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-2"}`}>
                  <div className="flex items-start gap-2">
                    <input type="radio" name="recipePick" className="mt-1" checked={on} onChange={() => setRecipeId(r.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5"><b className="truncate">{r.name}</b>{r.isDefault && <Badge>по умолчанию</Badge>}<Badge>{FORMAT_LABELS[r.format]}</Badge>{r.id === site?.defaultRecipeId && <Badge tone="brand">рецепт сайта</Badge>}</div>
                      <div className="help mt-0.5">{r.nicheName}{r.description ? ` · ${r.description}` : ""}</div>
                      <Readiness r={r} />
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-medium">3. Ключи</div>
          <div className="flex gap-1.5">
            {([["manual", "Вставить списком"], ["sheet", "Из Google Таблицы"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => { setSource(k); setCount(0); }} className={`badge px-3 py-1 ${source === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</button>
            ))}
          </div>
        </div>
        {site && (fromSheet
          ? <SheetImport key={site.id} siteId={site.id} defaultUrl={site.settings.sheetUrl} domain={site.domain} sheets={sheets} onCount={setCount} />
          : <KeywordsInput siteId={site.id} onCount={setCount} />)}
      </section>

      <section className="space-y-2">
        <div className="font-medium">4. Параметры запуска</div>
        <p className="help">Заполнено из настроек сайта. Меняется только для этого запуска: сохраняется в запуске и в снимке каждой статьи.</p>
        {fromSheet && <Alert tone="neutral">Из таблицы: колонка «Режим» решает для каждой статьи, нужна ли модерация фото до текста (галочка ниже не действует); «Год в URL», «Гео», «Язык» и «Свежесть», если заполнены в строке, важнее значений ниже.</Alert>}
        {site && (
          <div key={site.id} className="rounded-xl border border-line p-3 sm:p-4">
            <RunParamsFields s={site.settings} />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Название запуска (необязательно)"><input name="name" className="input" placeholder="Октябрь · ногти · 30 ключей" /></Field>
              <Field label="Тестовая метка" hint="Служебная пометка для тестовых прогонов, в тексты статьи не попадает."><input name="testLabel" className="input" placeholder="например, test-oct" /></Field>
            </div>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton className="btn-brand" pendingText="Ставлю в очередь…">Запустить {count ? `${count} статей` : ""}</SubmitButton>
        <span className="help">
          {fromSheet
            ? (!count ? "Нажмите «Прочитать таблицу», чтобы увидеть, какие строки пойдут в работу" : "Статьи встанут в очередь, строки таблицы получат статус «в работе»")
            : !recipe ? "Выберите рецепт" : !recipe.readiness.ok ? "Рецепт не готов: статьи встанут в очередь, но упадут на этапе без промта или ключа" : !count ? "Добавьте ключи" : `Статьи встанут в очередь, воркер начнёт по лимитам сайта`}
        </span>
      </div>
    </ActionForm>
  );
}

function Readiness({ r }: { r: RunFormRecipe }) {
  const rd = r.readiness;
  if (rd.ok) return <div className="mt-1"><Badge tone="ok">готов: промты и ключи на месте</Badge></div>;
  return (
    <div className="mt-1 space-y-1 text-[12.5px]">
      {rd.noPromptSet && <div className="text-danger">Нет набора промтов для ниши и формата — <Link href={`/pinterest/articles/recipes/${r.id}`} className="underline">открыть рецепт</Link></div>}
      {rd.missingPrompts.length > 0 && <div className="text-danger">Нет промтов шагов: {rd.missingPrompts.join(", ")} — <Link href={`/pinterest/articles/recipes/${r.id}`} className="underline">исправить в рецепте</Link></div>}
      {rd.missingSlots.length > 0 && <div className="text-warn">Нет ключей ИИ для: {rd.missingSlots.join(", ")} — <Link href="/keys" className="underline">назначить ключ сервису «Статьи»</Link></div>}
    </div>
  );
}
