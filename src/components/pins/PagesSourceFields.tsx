"use client";
import { useEffect, useState } from "react";
import { Alert, Field } from "@/components/ui";
import type { PagesSource } from "@/lib/pins/types";

export type WpCategory = { id: number; name: string; count: number };

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:text-ink hover:border-line-2";

/**
 * Поля «Откуда брать статьи»: вручную или из WordPress по REST API
 * (тип записей, категории, период публикации, лимит, пропуск уже использованных).
 * Имена полей совпадают с разбором в lib/pins/recipeForm.ts; используется в рецепте сайта и на странице нового прогона.
 */
export function PagesSourceFields({ siteId, p, hasWp, categories, onChange, compact }: {
  siteId: string;
  p: PagesSource;
  hasWp: boolean;
  /** Готовый список категорий (если родитель уже загрузил); иначе компонент загрузит сам. */
  categories?: WpCategory[];
  /** Уведомлять родителя об изменениях (страница прогона использует фильтр для предпросмотра). */
  onChange?: (next: PagesSource) => void;
  /** Без переключателя «вручную / WordPress» (когда вкладка уже выбрана выше). */
  compact?: boolean;
}) {
  const [v, setV] = useState<PagesSource>(p);
  const [cats, setCats] = useState<WpCategory[]>(categories ?? []);
  const [catsError, setCatsError] = useState("");
  const [catsLoading, setCatsLoading] = useState(false);

  useEffect(() => { setV(p); }, [p]);
  useEffect(() => { if (categories) setCats(categories); }, [categories]);

  const set = <K extends keyof PagesSource>(k: K, val: PagesSource[K]) => {
    const next = { ...v, [k]: val };
    setV(next);
    onChange?.(next);
  };
  const toggleCat = (id: number) => set("categories", v.categories.includes(id) ? v.categories.filter((x) => x !== id) : [...v.categories, id]);

  const wpOn = v.source === "wp";
  useEffect(() => {
    if (!wpOn || !hasWp || categories || cats.length || catsLoading) return;
    setCatsLoading(true); setCatsError("");
    fetch(`/api/pins/wp/taxonomies?site=${siteId}`, { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "Ошибка"); setCats(j.categories ?? []); })
      .catch((e) => setCatsError((e as Error).message))
      .finally(() => setCatsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wpOn, hasWp, siteId]);

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={`rounded-xl border p-3 cursor-pointer ${!wpOn ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
            <div className="flex items-center gap-2"><input type="radio" name="pagesSource" value="manual" checked={!wpOn} onChange={() => set("source", "manual")} /> <b>Ссылки вручную</b></div>
            <p className="help mt-1">При запуске прогона вставляете список ссылок на статьи.</p>
          </label>
          <label className={`rounded-xl border p-3 cursor-pointer ${wpOn ? "border-brand ring-2 ring-brand/30" : "border-line"} ${hasWp ? "" : "opacity-60"}`} title={hasWp ? "" : "Сначала выберите доступ WordPress"}>
            <div className="flex items-center gap-2"><input type="radio" name="pagesSource" value="wp" checked={wpOn} disabled={!hasWp} onChange={() => set("source", "wp")} /> <b>Из WordPress по REST API</b></div>
            <p className="help mt-1">Статьи подтягиваются по фильтру: тип, категории, период публикации. При запуске без ссылок фильтр применяется сам.</p>
          </label>
        </div>
      )}
      {compact && <input type="hidden" name="pagesSource" value={v.source} />}

      {wpOn && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Что брать">
              <select name="pagesPostType" className="input py-1.5" value={v.postType} onChange={(e) => set("postType", e.target.value === "pages" ? "pages" : "posts")}>
                <option value="posts">Записи (posts)</option>
                <option value="pages">Страницы (pages)</option>
              </select>
            </Field>
            <Field label="Период публикации">
              <select name="pagesPeriod" className="input py-1.5" value={v.period} onChange={(e) => set("period", e.target.value as PagesSource["period"])}>
                <option value="all">Любые даты</option>
                <option value="days">За последние N дней</option>
                <option value="range">С даты по дату</option>
              </select>
            </Field>
            {v.period === "days" && (
              <Field label="Дней назад" hint="Считается от момента запуска">
                <input name="pagesDays" type="number" min={1} max={3650} className="input py-1.5" value={v.days} onChange={(e) => set("days", Math.max(1, Number(e.target.value) || 1))} />
              </Field>
            )}
            {v.period === "range" && (
              <>
                <Field label="Опубликованы с"><input name="pagesAfter" type="date" className="input py-1.5" value={v.after} onChange={(e) => set("after", e.target.value)} /></Field>
                <Field label="по"><input name="pagesBefore" type="date" className="input py-1.5" value={v.before} onChange={(e) => set("before", e.target.value)} /></Field>
              </>
            )}
            <Field label="Не больше статей" hint="До 500 за прогон">
              <input name="pagesLimit" type="number" min={1} max={500} className="input py-1.5" value={v.limit} onChange={(e) => set("limit", Math.min(500, Math.max(1, Number(e.target.value) || 1)))} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <input type="hidden" name="pagesSkipUsedPresent" value="1" />
            <label className="flex items-center gap-1.5"><input type="checkbox" name="pagesSkipUsed" checked={v.skipUsed} onChange={(e) => set("skipUsed", e.target.checked)} className="h-4 w-4" /> пропускать статьи, которые уже были в прогонах</label>
            {v.postType === "posts" && (
              <label className="flex items-center gap-1.5"><input type="checkbox" name="pagesExclude" checked={v.excludeCategories} onChange={(e) => set("excludeCategories", e.target.checked)} className="h-4 w-4" /> категории ниже — исключить, остальные брать</label>
            )}
          </div>

          {v.postType === "posts" && (
            <div className="space-y-1.5">
              <div className="text-[12px] text-muted">Категории {v.excludeCategories ? "(исключаются)" : "(только из них; ничего не отмечено — все)"}{catsLoading ? " · загружаю…" : ""}</div>
              {catsError && <Alert tone="warn">Не удалось загрузить категории: {catsError}</Alert>}
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
                {cats.map((c) => (
                  <label key={c.id} className={chip}><input type="checkbox" name="pagesCategories" value={c.id} checked={v.categories.includes(c.id)} onChange={() => toggleCat(c.id)} className="h-3.5 w-3.5" /> {c.name} <span className="text-muted">{c.count}</span></label>
                ))}
                {/* Выбранные категории, которых нет в загруженном списке (список ещё не пришёл) — не теряем. */}
                {v.categories.filter((id) => !cats.some((c) => c.id === id)).map((id) => <input key={id} type="hidden" name="pagesCategories" value={id} />)}
                {!cats.length && !catsLoading && !catsError && <span className="help">{hasWp ? "Категорий пока нет." : "Нет доступа WordPress."}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
