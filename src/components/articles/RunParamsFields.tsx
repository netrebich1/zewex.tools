"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import { PUBLISH_MODES, type ArtRunSettings, type ArtSiteSettings } from "@/lib/articles/types";

export const FRESHNESS = [["", "любая"], ["y", "за год"], ["m", "за месяц"], ["w", "за неделю"]];
export const COUNTRIES = ["us", "gb", "ca", "au", "de", "fr", "es", "it", "pl", "ua", "ru"];
export const LANGUAGES = ["en", "de", "fr", "es", "it", "pl", "uk", "ru"];

type Src = Pick<ArtSiteSettings, "photoCount" | "photoReview" | "publishMode" | "search" | "yearInUrlPercent"> | Pick<ArtRunSettings, "photoCount" | "photoReview" | "publishMode" | "search" | "yearInUrlPercent">;

/**
 * Общие поля «фото / модерация / публикация / поиск / год в URL» — в настройках сайта (значения по умолчанию)
 * и в параметрах запуска. Имена полей разбирают settingsFromForm и runSettingsFromForm в actions/articles.ts.
 * aiModOn — у сайта включена ИИ-модерация фото: модерация фото до текста включается для статей с реальными фото сама
 * (lib/articles/launch.ts): в запуске галочка показывается включённой и заблокированной; в настройках сайта остаётся
 * редактируемой (это значение по умолчанию на случай, когда ИИ-модерацию выключат), с пояснением.
 */
export function RunParamsFields({ s, siteLevel = false, aiModOn = false }: { s: Src; siteLevel?: boolean; aiModOn?: boolean }) {
  const forced = aiModOn && !siteLevel;
  const [mode, setMode] = useState<"exact" | "range">(s.photoCount.mode);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Фото</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Field label="Сколько фото" hint={mode === "exact" ? "Одно число для всех статей" : "Случайно из диапазона для каждой статьи"}>
            <select name="photoCountMode" className="input py-1.5" value={mode} onChange={(e) => setMode(e.target.value as "exact" | "range")}>
              <option value="exact">Точно</option>
              <option value="range">Диапазон</option>
            </select>
          </Field>
          <Field label={mode === "exact" ? "Штук" : "От"}><input name="photoMin" type="number" min={1} max={60} className="input py-1.5" defaultValue={s.photoCount.min} /></Field>
          {mode === "range" ? <Field label="До"><input name="photoMax" type="number" min={1} max={60} className="input py-1.5" defaultValue={Math.max(s.photoCount.min, s.photoCount.max)} /></Field> : <div />}
        </div>
        <p className="help">Одно фото = одна секция статьи. Минимум для публикации — 15 подходящих кадров; если найдётся меньше, статья встанет в «Не хватило фото». В строке ключа можно задать своё число (4-я колонка).</p>
        <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[13.5px] ${aiModOn ? "border-brand/40 bg-brand-soft/40" : "border-line"}`}>
          {/* key: при смене сайта в форме запуска галочка перерисовывается с новым состоянием */}
          <input key={forced ? "ai" : "manual"} type="checkbox" name="photoReview" defaultChecked={forced || s.photoReview} disabled={forced} className="mt-0.5 h-4 w-4" />
          {forced && <input type="hidden" name="photoReview" value="on" />}
          <span>
            <b>Модерация фото до текста</b>
            {aiModOn
              ? <span className="help block">{siteLevel ? "Пока включена ИИ-модерация фото (блок ниже), фото каждой статьи с реальными фото проверяет ИИ до текста — эта галочка действует только при выключенной ИИ-модерации." : "Включена ИИ-модерацией фото сайта: фото каждой статьи (реальные фото) после отбора проверит ИИ, и только потом пишется текст. Сомнительные статьи ИИ отдаёт сотруднику. Выключить — в настройках сайта, блок «ИИ-модерация фото»."}</span>
              : <span className="help block">Включено: после отбора статья ждёт одобрения кадров человеком в «Модерации фото», и только потом пишется текст. Выключено: текст пишется сразу, проверяется готовая статья перед публикацией.</span>}
          </span>
        </label>
      </section>

      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Публикация</div>
        <Field label="Режим публикации">
          <select name="publishMode" className="input py-1.5" defaultValue={s.publishMode}>
            {PUBLISH_MODES.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.help}</option>)}
          </select>
        </Field>
        <Field label="Год в адресе статьи, %" hint={siteLevel ? "Доля статей, у которых в URL добавляется текущий год (например, …-ideas-2026). Пусто — как в сценарии." : "Пусто — как в настройках сайта или сценарии."}>
          <input name="yearInUrlPercent" type="number" min={0} max={100} className="input py-1.5" defaultValue={s.yearInUrlPercent ?? ""} placeholder="как в сценарии" />
        </Field>
      </section>

      <section className="rounded-xl border border-line p-3 space-y-2 lg:col-span-2">
        <div className="text-[13px] font-semibold">Поиск фото: гео, язык, свежесть</div>
        <p className="help">Переопределяют настройки поиска из сценария. Пусто — берётся из сценария.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Field label="Страна" hint="Код страны Google: us, gb, de…">
            <input name="searchCountry" list="art-countries" className="input py-1.5" defaultValue={s.search.country} placeholder="из сценария" maxLength={8} />
            <datalist id="art-countries">{COUNTRIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Язык" hint="Код языка: en, de, uk…">
            <input name="searchLanguage" list="art-langs" className="input py-1.5" defaultValue={s.search.language} placeholder="из сценария" maxLength={8} />
            <datalist id="art-langs">{LANGUAGES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Свежесть" hint="Насколько новые картинки искать">
            <select name="searchFreshness" className="input py-1.5" defaultValue={s.search.freshness}>
              <option value="">из сценария</option>
              {FRESHNESS.filter(([v]) => v).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
      </section>
    </div>
  );
}
