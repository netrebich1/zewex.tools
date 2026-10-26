"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Field } from "@/components/ui";
import { launchBlogAction } from "@/actions/blog";
import type { RecipeReadiness } from "@/lib/blog/recipes";
import { PUBLISH_MODES, REVIEW_MODES, type BlogSiteSettings } from "@/lib/blog/types";
import { KeywordsInput } from "./KeywordsInput";
import { BlogSheetImport } from "./BlogSheetImport";

export type RunFormSite = { id: string; name: string; defaultRecipeId: string | null; hasAccess: boolean; categoriesCount: number; settings: BlogSiteSettings; domain: string };
export type RunFormRecipe = { id: string; name: string; description: string | null; isDefault: boolean; length: { min: number; max: number }; images: { min: number; max: number }; readiness: RecipeReadiness };

/** Новый запуск: сайт → сценарий (готовность промтов и ключей) → ключи → параметры этого запуска. */
export function NewBlogRunForm({ sites, recipes, presetSiteId, sheets }: { sites: RunFormSite[]; recipes: RunFormRecipe[]; presetSiteId?: string; sheets: { connected: boolean; email: string | null } }) {
  const [source, setSource] = useState<"list" | "sheet">("list");
  const [siteId, setSiteId] = useState(presetSiteId && sites.some((s) => s.id === presetSiteId) ? presetSiteId : sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId);
  const pickDefault = (s?: RunFormSite) => (s?.defaultRecipeId && recipes.some((r) => r.id === s.defaultRecipeId) ? s.defaultRecipeId : recipes.find((r) => r.readiness.ok)?.id ?? recipes[0]?.id ?? "");
  const [recipeId, setRecipeId] = useState(() => pickDefault(site));
  const recipe = recipes.find((r) => r.id === recipeId);
  const [count, setCount] = useState(0);
  useEffect(() => { setRecipeId(pickDefault(site)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [siteId]);

  const warnings: string[] = [];
  if (site && !site.hasAccess) warnings.push("У сайта нет доступа WordPress: публикация не пройдёт. Привяжите доступ в разделе «Сайты».");
  if (site && site.settings.publishMode !== "moderate_first" && !site.categoriesCount) warnings.push("Категории WordPress не синхронизированы: категория будет выбрана по умолчанию WordPress. Нажмите «Синхронизировать категории» в настройках сайта.");

  return (
    <ActionForm action={launchBlogAction} className="space-y-6">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="recipeId" value={recipeId} />

      <section className="space-y-2">
        <div className="font-medium">1. Сайт</div>
        {sites.length === 0 ? <Alert tone="warn">Сайтов в сервисе нет. Откройте <Link href="/pinterest/blog/sites" className="underline">«Сайты»</Link> и подключите сайт.</Alert> : (
          <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {site && <p className="help">Проверка: {REVIEW_MODES.find((m) => m.value === site.settings.review)?.label} · публикация: {PUBLISH_MODES.find((m) => m.value === site.settings.publishMode)?.label} · <Link href={`/pinterest/blog/sites/${site.id}?tab=settings`} className="underline">настройки сайта</Link></p>}
        {warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      </section>

      <section className="space-y-2">
        <div className="font-medium">2. Сценарий</div>
        {recipes.length === 0 ? <Alert tone="warn">Сценариев нет. Создайте сценарий в разделе <Link href="/pinterest/blog/scenarios" className="underline">«Сценарии»</Link>.</Alert> : (
          <div className="grid gap-2 sm:grid-cols-2">
            {recipes.map((r) => {
              const on = r.id === recipeId;
              return (
                <label key={r.id} className={`rounded-xl border p-3 cursor-pointer ${on ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-2"}`}>
                  <div className="flex items-start gap-2">
                    <input type="radio" name="recipePick" className="mt-1" checked={on} onChange={() => setRecipeId(r.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5"><b className="truncate">{r.name}</b>{r.isDefault && <Badge>по умолчанию</Badge>}{r.id === site?.defaultRecipeId && <Badge tone="brand">сценарий сайта</Badge>}</div>
                      <div className="help mt-0.5">{r.length.min}–{r.length.max} слов · {r.images.min}–{r.images.max} фото{r.description ? ` · ${r.description}` : ""}</div>
                      {r.readiness.ok ? <div className="mt-1"><Badge tone="ok">готов: промты и ключи на месте</Badge></div> : (
                        <div className="mt-1 space-y-1 text-[12.5px]">
                          {r.readiness.missingPrompts.length > 0 && <div className="text-danger">Нет промтов шагов: {r.readiness.missingPrompts.join(", ")} — <Link href={`/pinterest/blog/scenarios/${r.id}?tab=prompts`} className="underline">заполнить</Link></div>}
                          {r.readiness.missingSlots.length > 0 && <div className="text-warn">Нет ключей ИИ для: {r.readiness.missingSlots.join(", ")} — <Link href="/keys" className="underline">назначить ключ сервису «Pin Blog Article»</Link></div>}
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3"><div className="font-medium">3. Ключи и темы</div>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-[13px]">
            <button type="button" className={`rounded-md px-3 py-1 ${source === "list" ? "bg-ink/10 font-medium" : ""}`} onClick={() => { setSource("list"); setCount(0); }}>Списком</button>
            <button type="button" className={`rounded-md px-3 py-1 ${source === "sheet" ? "bg-ink/10 font-medium" : ""}`} onClick={() => { setSource("sheet"); setCount(0); }}>Из Google Таблицы</button>
          </div>
        </div>
        {site && source === "list" && <KeywordsInput key={site.id} siteId={site.id} onCount={setCount} />}
        {site && source === "sheet" && <BlogSheetImport key={site.id} siteId={site.id} defaultUrl={site.settings.sheetUrl} domain={site.domain} sheets={sheets} onCount={setCount} />}
      </section>

      <section className="space-y-2">
        <div className="font-medium">4. Параметры запуска</div>
        <p className="help">Заполнено из настроек сайта и сценария. Меняется только для этого запуска.</p>
        {site && (
          <div key={site.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Проверка перед публикацией">
              <select name="review" className="input py-1.5" defaultValue={site.settings.review}>{REVIEW_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
            </Field>
            <Field label="Режим публикации">
              <select name="publishMode" className="input py-1.5" defaultValue={site.settings.publishMode}>{PUBLISH_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
            </Field>
            <Field label="Год в адресе статьи, %" hint="Пусто — как в настройках сайта или сценарии."><input name="yearInUrlPercent" type="number" min={0} max={100} className="input py-1.5" defaultValue={site.settings.yearInUrlPercent ?? ""} placeholder="как в сценарии" /></Field>
            <Field label="Объём статьи, слов (от – до)" hint={recipe ? `В сценарии ${recipe.length.min}–${recipe.length.max}. Пусто — как в сценарии.` : undefined}>
              <div className="grid grid-cols-2 gap-2"><input name="lengthMin" type="number" min={300} max={6000} className="input py-1.5" placeholder={recipe ? String(recipe.length.min) : ""} /><input name="lengthMax" type="number" min={300} max={6000} className="input py-1.5" placeholder={recipe ? String(recipe.length.max) : ""} /></div>
            </Field>
            <Field label="Картинок (от – до)" hint={recipe ? `В сценарии ${recipe.images.min}–${recipe.images.max}.` : undefined}>
              <div className="grid grid-cols-2 gap-2"><input name="imagesMin" type="number" min={1} max={12} className="input py-1.5" placeholder={recipe ? String(recipe.images.min) : ""} /><input name="imagesMax" type="number" min={1} max={12} className="input py-1.5" placeholder={recipe ? String(recipe.images.max) : ""} /></div>
            </Field>
            <Field label="Поиск фото: страна / язык" hint="Пусто — из сценария.">
              <div className="grid grid-cols-2 gap-2"><input name="searchCountry" className="input py-1.5" defaultValue={site.settings.search.country} placeholder="us" maxLength={8} /><input name="searchLanguage" className="input py-1.5" defaultValue={site.settings.search.language} placeholder="en" maxLength={8} /></div>
            </Field>
            <Field label="Название запуска (необязательно)"><input name="name" className="input py-1.5" placeholder="Октябрь · волосы · 20 тем" /></Field>
            <Field label="Тестовая метка" hint="Служебная пометка, в тексты не попадает."><input name="testLabel" className="input py-1.5" placeholder="например, test-oct" /></Field>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton className="btn-brand" pendingText="Ставлю в очередь…">Запустить {count ? `${count} статей` : ""}</SubmitButton>
        <span className="help">{!recipe ? "Выберите сценарий" : !recipe.readiness.ok ? "Сценарий не готов: статьи встанут в очередь, но упадут на этапе без промта или ключа" : !count ? "Добавьте ключи" : "Статьи встанут в очередь, воркер начнёт по лимиту сайта"}</span>
      </div>
    </ActionForm>
  );
}
