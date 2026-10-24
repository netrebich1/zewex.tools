"use client";
import Link from "next/link";
import { useState } from "react";
import type { ArtFormat } from "@prisma/client";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/ui";
import { saveArtSiteSettings } from "@/actions/articles";
import { SITE_LIMITS, type ArtSiteSettings } from "@/lib/articles/types";
import { RunParamsFields } from "./RunParamsFields";

export type WpCategoryOption = { id: number; name: string; parent?: number | null };
export type NicheOption = { code: string; name: string; parentCode: string | null };
export type RecipeOption = { id: string; name: string; nicheCode: string; format: ArtFormat; isActive: boolean };

type Props = {
  site: { id: string; name: string; nicheCode: string | null; defaultRecipeId: string | null };
  settings: ArtSiteSettings;
  categories: WpCategoryOption[];
  niches: NicheOption[];
  recipes: RecipeOption[];
};

const FORMAT: Record<ArtFormat, string> = { REAL_PHOTO: "реальные фото", GENERATED_PHOTO: "ИИ-картинки" };

/**
 * Настройки сайта в сервисе «Статьи» (все поля ArtSiteSettings группами + ниша и сценарий по умолчанию).
 * Значения «Фото / Публикация / Поиск» — по умолчанию для новых запусков; «Автозапуск» и «ИИ-модерация» действуют на весь сайт
 * и те же, что на экране «Автозапуск сайтов» (пределы — SITE_LIMITS). Рядом с каждым таким полем — скрытое исходное значение
 * orig_<имя>: при сохранении меняются только поля, которые тронули здесь (actions/articles.ts settingsFromForm).
 */
export function SiteSettingsForm({ site, settings: s, categories, niches, recipes }: Props) {
  const [niche, setNiche] = useState(site.nicheCode ?? "");
  const [rules, setRules] = useState(s.categories.rules.length ? s.categories.rules : []);
  const recipeList = niche ? recipes.filter((r) => r.nicheCode === niche || r.id === site.defaultRecipeId) : recipes;
  const catName = (id: number | null) => categories.find((c) => c.id === id)?.name ?? (id ? `#${id}` : "");
  const groupBox = "rounded-xl border border-line p-3 space-y-3";
  const check = (name: string, label: string, help: string, on: boolean, withOrig = false) => (
    <label className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[13.5px]">
      <input type="checkbox" name={name} defaultChecked={on} className="mt-0.5 h-4 w-4" />
      {withOrig && <input type="hidden" name={`orig_${name}`} value={on ? "1" : "0"} />}
      <span><b>{label}</b><span className="help block">{help}</span></span>
    </label>
  );
  const L = SITE_LIMITS;
  /** Число автозапуска/ИИ с исходным значением для «сохранять только изменённое». */
  const numField = (name: string, value: number, [min, max]: readonly [number, number]) => (
    <>
      <input name={name} type="number" min={min} max={max} className="input py-1.5" defaultValue={value} />
      <input type="hidden" name={`orig_${name}`} value={String(value)} />
    </>
  );

  return (
    <ActionForm action={saveArtSiteSettings} hidden={{ id: site.id }} className="space-y-5">
      <section className={groupBox}>
        <div className="text-[13px] font-semibold">Основное</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Название сайта в сервисе"><input name="name" className="input" defaultValue={site.name} /></Field>
          <Field label="Ниша" hint="Определяет, какие сценарии и профили поиска подходят сайту.">
            <select name="nicheCode" className="input" value={niche} onChange={(e) => setNiche(e.target.value)}>
              <option value="">— не задана —</option>
              {niches.filter((n) => !n.parentCode).map((n) => (
                <optgroup key={n.code} label={n.name}>
                  <option value={n.code}>{n.name}</option>
                  {niches.filter((x) => x.parentCode === n.code).map((x) => <option key={x.code} value={x.code}>— {x.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Сценарий по умолчанию" hint="Подставляется на шаге «Сценарий» нового запуска.">
            <select name="defaultRecipeId" className="input" defaultValue={site.defaultRecipeId ?? ""}>
              <option value="">— выбирать при запуске —</option>
              {recipeList.map((r) => <option key={r.id} value={r.id}>{r.name} · {FORMAT[r.format]}{r.isActive ? "" : " (выключен)"}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-[13px] font-semibold">По умолчанию для новых запусков</div>
        <p className="help">Эти значения подставляются на странице «Новый запуск», там их можно изменить для конкретной партии.</p>
        <RunParamsFields s={s} siteLevel aiModOn={s.aiModeration.enabled} />
      </section>

      <section className={groupBox}>
        <div className="flex flex-wrap items-baseline gap-2">
          <div className="text-[13px] font-semibold">Категории WordPress</div>
          <span className="help">{categories.length ? `В кэше ${categories.length} категорий.` : "Категории ещё не загружены — нажмите «Синхронизировать категории» ниже."}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Категория по умолчанию" hint="Если ни одно правило не подошло и ИИ не выбирает категорию.">
            <select name="catDefaultId" className="input" defaultValue={s.categories.defaultId ?? ""}>
              <option value="">— не задана (по умолчанию WordPress) —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.parent ? "— " : ""}{c.name}</option>)}
              {s.categories.defaultId && !categories.some((c) => c.id === s.categories.defaultId) && <option value={s.categories.defaultId}>{catName(s.categories.defaultId)}</option>}
            </select>
          </Field>
          <div className="pt-6">{check("catUseAi", "Подбирать категорию ИИ", "Если правила не подошли, модель выбирает категорию из списка сайта по теме статьи.", s.categories.useAi)}</div>
        </div>
        <div className="space-y-1.5">
          <div className="label">Правила «если ключ содержит слово → категория»</div>
          {rules.length === 0 && <p className="help">Правил нет. Пример: «coffin» → «Coffin Nails».</p>}
          {rules.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input name="ruleP" className="input py-1.5" defaultValue={r.pattern} placeholder="подстрока ключа" />
              <select name="ruleC" className="input py-1.5" defaultValue={r.categoryId}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.parent ? "— " : ""}{c.name}</option>)}
                {!categories.some((c) => c.id === r.categoryId) && <option value={r.categoryId}>{catName(r.categoryId) || `#${r.categoryId}`}</option>}
              </select>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setRules((l) => l.filter((_, j) => j !== i))} title="Убрать правило">✕</button>
            </div>
          ))}
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRules((l) => [...l, { pattern: "", categoryId: categories[0]?.id ?? 0 }])} disabled={!categories.length}>+ Добавить правило</button>
        </div>
      </section>

      <section className={groupBox}>
        <div className="flex flex-wrap items-baseline gap-2"><div className="text-[13px] font-semibold">Автозапуск и лимиты</div><Link href="/pinterest/articles/automation" className="help underline">то же на экране «Автозапуск сайтов»</Link></div>
        <p className="help">Воркер берёт статьи сайта по двум цепочкам: «фото» (поиск → отбор) и «написание» (план → публикация). Лимит — сколько статей сайта одновременно в цепочке ({L.photoLimit[0]}–{L.photoLimit[1]}). Цепочка работает, пока включена: сама она не выключается. Выключенная — статьи ждут в очереди.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">{check("autoPhotoEnabled", "Цепочка «фото» включена", "Поиск, фильтр, оценка и отбор кадров.", s.autostart.photoEnabled, true)}<Field label="Одновременно статей в «фото»">{numField("autoPhotoLimit", s.autostart.photoLimit, L.photoLimit)}</Field></div>
          <div className="space-y-2">{check("autoWritingEnabled", "Цепочка «написание» включена", "План, тексты секций, мета, сборка.", s.autostart.writingEnabled, true)}<Field label="Одновременно статей в «написании»">{numField("autoWritingLimit", s.autostart.writingLimit, L.writingLimit)}</Field></div>
          <div className="space-y-2"><Field label="Одновременно публикаций" hint="Загрузка фото в медиатеку нагружает хостинг.">{numField("autoPublishLimit", s.autostart.publishLimit, L.publishLimit)}</Field></div>
        </div>
      </section>

      <section className={groupBox}>
        <div className="text-[13px] font-semibold">ИИ-модерация фото</div>
        <p className="help">Включено: у каждой статьи сайта (реальные фото) после отбора фото сначала проверяет ИИ — галочка «Модерация фото до текста» в запуске включается сама. ИИ берёт статью в течение ~20 секунд. Работает, если на экране «Автозапуск сайтов» включён мастер-выключатель «ИИ-проверка фото».</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {check("aiModEnabled", "ИИ проверяет отобранные фото", "Модель смотрит кадры, убирает неподходящие, добавляет из резерва и одобряет — статья уходит писать текст. Сомнительные отдаёт сотруднику.", s.aiModeration.enabled, true)}
          {check("aiModAutoApply", "Применять решения ИИ автоматически", "Выключено — решения ИИ показываются человеку как подсказка.", s.aiModeration.autoApply, true)}
          <Field label="Запуск от (статей)" hint="1 — проверять каждую статью сразу. Больше — ждать, пока накопится столько (не дольше 30 мин). К уже идущей проверке новые статьи добавляются без ожидания.">{numField("aiModBatchFrom", s.aiModeration.batchFrom, L.batchFrom)}</Field>
          <Field label="Параллельно статей" hint={`${L.concurrency[0]}–${L.concurrency[1]}`}>{numField("aiModConcurrency", s.aiModeration.concurrency, L.concurrency)}</Field>
          <Field label="Ждать, если в публикации ≥ N" hint="0 — не ждать.">{numField("aiModBacklog", s.aiModeration.backlogThreshold, L.backlogThreshold)}</Field>
        </div>
      </section>

      <section className={groupBox}>
        <div className="text-[13px] font-semibold">Прочее</div>
        <Field label="Google Таблица (ссылка)" hint="Из неё берутся ключи на шаге «Ключи» нового запуска, и в неё же записываются статус, ссылка и дата статьи. Вкладка должна называться доменом сайта. Подключение и проверка — в блоке «Google Таблицы» ниже.">
          <input name="sheetUrl" className="input" defaultValue={s.sheetUrl} placeholder="https://docs.google.com/spreadsheets/…" />
        </Field>
        <p className="help">Доступ по REST API WordPress, команды и видимость сайта сотрудникам — в общем разделе <Link href="/sites" className="underline">«Сайты»</Link>.</p>
      </section>

      <SubmitButton pendingText="Сохраняю…">Сохранить настройки сайта</SubmitButton>
    </ActionForm>
  );
}
