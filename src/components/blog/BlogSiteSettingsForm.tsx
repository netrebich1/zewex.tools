"use client";
import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/ui";
import { saveBlogSiteSettings } from "@/actions/blog";
import { PUBLISH_MODES, REVIEW_MODES, SITE_LIMITS, type BlogSiteSettings } from "@/lib/blog/types";

export type WpCategoryOption = { id: number; name: string; parent?: number | null };
export type RecipeOption = { id: string; name: string; isActive: boolean };

/** Настройки сайта в сервисе инфо-статей: сценарий по умолчанию, проверка, публикация, категории WordPress, лимит, поиск. */
export function BlogSiteSettingsForm({ site, settings: s, categories, recipes }: { site: { id: string; name: string; defaultRecipeId: string | null }; settings: BlogSiteSettings; categories: WpCategoryOption[]; recipes: RecipeOption[] }) {
  const [rules, setRules] = useState(s.categories.rules);
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? (id ? `#${id}` : "");
  const box = "rounded-xl border border-line p-3 space-y-3";
  return (
    <ActionForm action={saveBlogSiteSettings} hidden={{ id: site.id }} className="space-y-5">
      <section className={box}>
        <div className="text-[13px] font-semibold">Основное</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Название сайта в сервисе"><input name="name" className="input" defaultValue={site.name} /></Field>
          <Field label="Сценарий по умолчанию" hint="Подставляется на шаге «Сценарий» нового запуска.">
            <select name="defaultRecipeId" className="input" defaultValue={site.defaultRecipeId ?? ""}>
              <option value="">— выбирать при запуске —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isActive ? "" : " (выключен)"}</option>)}
            </select>
          </Field>
          <Field label="Одновременно статей в работе" hint={`${SITE_LIMITS.concurrency[0]}–${SITE_LIMITS.concurrency[1]}. Поиск и оценка фото — самая долгая часть.`}><input name="concurrency" type="number" min={SITE_LIMITS.concurrency[0]} max={SITE_LIMITS.concurrency[1]} className="input" defaultValue={s.concurrency} /></Field>
        </div>
      </section>
      <section className={box}>
        <div className="text-[13px] font-semibold">Проверка и публикация (по умолчанию для новых запусков)</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Проверка перед публикацией">
            <select name="review" className="input" defaultValue={s.review}>{REVIEW_MODES.map((m) => <option key={m.value} value={m.value} title={m.help}>{m.label}</option>)}</select>
          </Field>
          <Field label="Режим публикации">
            <select name="publishMode" className="input" defaultValue={s.publishMode}>{PUBLISH_MODES.map((m) => <option key={m.value} value={m.value} title={m.help}>{m.label}</option>)}</select>
          </Field>
          <Field label="Год в адресе статьи, %" hint="Пусто — как в сценарии."><input name="yearInUrlPercent" type="number" min={0} max={100} className="input" defaultValue={s.yearInUrlPercent ?? ""} placeholder="как в сценарии" /></Field>
        </div>
        <p className="help">{REVIEW_MODES.find((m) => m.value === s.review)?.help}</p>
      </section>
      <section className={box}>
        <div className="flex flex-wrap items-baseline gap-2"><div className="text-[13px] font-semibold">Категории WordPress</div><span className="help">{categories.length ? `В кэше ${categories.length} категорий.` : "Категории ещё не загружены — нажмите «Синхронизировать категории» ниже."}</span></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Категория по умолчанию">
            <select name="catDefaultId" className="input" defaultValue={s.categories.defaultId ?? ""}>
              <option value="">— не задана (по умолчанию WordPress) —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.parent ? "— " : ""}{c.name}</option>)}
              {s.categories.defaultId && !categories.some((c) => c.id === s.categories.defaultId) && <option value={s.categories.defaultId}>{catName(s.categories.defaultId)}</option>}
            </select>
          </Field>
          <label className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[13.5px] mt-6"><input type="checkbox" name="catUseAi" defaultChecked={s.categories.useAi} className="mt-0.5 h-4 w-4" /><span><b>Подбирать категорию ИИ</b><span className="help block">Если правила не подошли, модель выбирает категорию из списка сайта по теме.</span></span></label>
        </div>
        <div className="space-y-1.5">
          <div className="label">Правила «если ключ содержит слово → категория»</div>
          {rules.length === 0 && <p className="help">Правил нет. Пример: «hair» → «Hair Care».</p>}
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input name="ruleP" className="input py-1.5" defaultValue={r.pattern} placeholder="подстрока ключа" />
              <select name="ruleC" className="input py-1.5" defaultValue={r.categoryId}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.parent ? "— " : ""}{c.name}</option>)}
                {!categories.some((c) => c.id === r.categoryId) && <option value={r.categoryId}>{catName(r.categoryId) || `#${r.categoryId}`}</option>}
              </select>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setRules((l) => l.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRules((l) => [...l, { pattern: "", categoryId: categories[0]?.id ?? 0 }])} disabled={!categories.length}>+ Добавить правило</button>
        </div>
      </section>
      <section className={box}>
        <div className="text-[13px] font-semibold">Поиск фото: гео и язык</div>
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <Field label="Страна" hint="us, gb, de… Пусто — из сценария."><input name="searchCountry" className="input py-1.5" defaultValue={s.search.country} placeholder="из сценария" maxLength={8} /></Field>
          <Field label="Язык" hint="en, de… Пусто — из сценария."><input name="searchLanguage" className="input py-1.5" defaultValue={s.search.language} placeholder="из сценария" maxLength={8} /></Field>
        </div>
        <p className="help">Доступ по REST API WordPress, команды и видимость — в общем разделе <Link href="/sites" className="underline">«Сайты»</Link>.</p>
      </section>
      <SubmitButton pendingText="Сохраняю…">Сохранить настройки сайта</SubmitButton>
    </ActionForm>
  );
}
