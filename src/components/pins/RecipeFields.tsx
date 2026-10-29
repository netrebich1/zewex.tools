import type { ReactNode } from "react";
import { Field } from "@/components/ui";
import type { Recipe } from "@/lib/pins/types";
import { pinYear } from "@/lib/pins/prompts/elements";
import { PinoraPicker } from "@/components/pins/PinoraPicker";
import { ScheduleModeFields } from "@/components/pins/ScheduleModeFields";
import { YearRulesFields } from "@/components/pins/YearRulesFields";

export type RecipeSetOption = { id: string; name: string; count: number; topic?: string };
export type RecipeCanvasStyle = { id: string; name: string; previewUrl: string | null; zewex: boolean };
export type RecipeFieldsData = {
  aiSets: RecipeSetOption[];
  /** Canvas-наборы сайта (наборы утверждённых стилей). */
  canvasSets: RecipeSetOption[];
  /** Утверждённые Canvas-стили каталога (выбираются напрямую, с превью) — только в настройках сайта. */
  canvasStyles: RecipeCanvasStyle[];
  pinoraTypes: Array<{ id: string; ru: string }>;
  /** Доступы WordPress для сайтов без привязки; не передавать, если выбор WP не нужен. */
  wps?: Array<{ id: string; name: string }>;
};

export const LANGS = [["en", "English"], ["ru", "Русский"], ["uk", "Українська"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["pl", "Polski"], ["pt", "Português"]];

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:text-ink hover:border-line-2";

/**
 * Поля настроек пинов. Два уровня:
 * - scope="site" — настройки сайта в сервисе: наборы ИИ, Canvas-стили, типы Pinora, язык, аудитория, цвет, домен ссылок;
 * - scope="run"  — настройки прогона: сколько пинов каждого вида, расписание и модерация, элементы текстов, доски.
 * Имена полей разбирает lib/pins/recipeForm.ts; группа меняется, только если её поля пришли.
 */
export function RecipeFields({ r, data, scope }: { r: Recipe; data: RecipeFieldsData; scope: "site" | "run" }) {
  const num = (name: string, label: string, value: number, max = 20, min = 0) => (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
      <span className="text-[13px]">{label}</span>
      <input name={name} type="number" min={min} max={max} className="input w-20 py-1 text-center" defaultValue={value} />
    </label>
  );
  /** Строка таблицы элементов: название, доля пинов в %, поле со значением (или пояснение). */
  const element = (name: string, label: string, value: number, control: ReactNode) => (
    <div className="grid grid-cols-[1fr_96px] sm:grid-cols-[150px_110px_1fr] gap-2 items-center px-3 py-2">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="flex items-center gap-1"><input name={name} type="number" min={0} max={100} className="input w-16 py-1 px-1 text-center" defaultValue={value} /><span className="text-[12px] text-muted">%</span></span>
      <div className="col-span-2 sm:col-span-1 min-w-0">{control}</div>
    </div>
  );

  const setChips = (name: string, list: RecipeSetOption[], chosen: string[], empty: string) => (
    <div className="flex flex-wrap gap-1.5">
      {list.map((s) => <label key={s.id} className={chip} title={s.topic || ""}><input type="checkbox" name={name} value={s.id} defaultChecked={chosen.includes(s.id)} className="h-3.5 w-3.5" /> {s.name} <span className="text-muted">{s.count}</span></label>)}
      {!list.length && <p className="help">{empty}</p>}
    </div>
  );

  /**
   * Наборы: ИИ-наборы, Canvas-наборы, типы Pinora — только названия (для этого наборы и собираются).
   * compact — для прогона: отдельные Canvas-стили сайта не показываются, а передаются скрытыми полями как есть.
   */
  const styles = (compact: boolean) => (
    <section className="rounded-xl border border-line p-3 space-y-3 lg:col-span-2">
      <input type="hidden" name="setsPresent" value="1" />
      {compact && (r.sets.canvasStyleIds ?? []).map((id) => <input key={id} type="hidden" name="canvasStyleIds" value={id} />)}
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="text-[13px] font-semibold">{compact ? "Наборы стилей для этого прогона" : "Наборы стилей"}</div>
        <span className="help">Наборы собираются в разделе «Стили». {compact ? "Отмечено как у сайта." : ""} Canvas: ничего не отмечено — все утверждённые стили.</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-1.5"><div className="text-[12px] text-muted">ИИ-наборы (шаблоны ИИ-пинов)</div>{setChips("aiSetIds", data.aiSets, r.sets.aiSetIds, "Наборов нет: соберите их в разделе «Стили».")}</div>
        <div className="space-y-1.5"><div className="text-[12px] text-muted">Canvas-наборы</div>{setChips("canvasSetIds", data.canvasSets, r.sets.canvasSetIds, "Canvas-наборов нет: соберите их в разделе «Стили» → Canvas.")}</div>
        <div className="space-y-1.5"><div className="text-[12px] text-muted">Pinora: ниша и типы</div>
          <PinoraPicker key={`${r.sets.pinoraNiche}|${r.sets.pinoraTypes.join(",")}`} niche={r.sets.pinoraNiche} types={r.sets.pinoraTypes} />
        </div>
      </div>
      {!compact && (
        <details className="pt-1">
          <summary className="help cursor-pointer">Отдельные Canvas-стили (необязательно): отмечаются вдобавок к наборам{(r.sets.canvasStyleIds ?? []).length ? ` · выбрано ${(r.sets.canvasStyleIds ?? []).length}` : ""}</summary>
          {data.canvasStyles.length === 0 ? (
            <p className="help mt-2">Утверждённых стилей нет: откройте Стили → Canvas-стили и примите понравившиеся.</p>
          ) : (
            <div className="mt-2 grid gap-2 grid-cols-4 sm:grid-cols-6 lg:grid-cols-10">
              {data.canvasStyles.map((c) => (
                <label key={c.id} className="group relative cursor-pointer rounded-lg border border-line p-1 has-[:checked]:border-brand has-[:checked]:ring-2 has-[:checked]:ring-brand/40" title={c.name}>
                  <input type="checkbox" name="canvasStyleIds" value={c.id} defaultChecked={r.sets.canvasStyleIds?.includes(c.id)} className="absolute left-1.5 top-1.5 z-10 h-4 w-4" />
                  {c.previewUrl ? <img src={c.previewUrl} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-md" /> : <div className="w-full aspect-[2/3] rounded-md bg-ink/5" />}
                  <div className="mt-1 text-[11px] leading-tight truncate">{c.zewex ? "★ " : ""}{c.name}</div>
                </label>
              ))}
            </div>
          )}
        </details>
      )}
    </section>
  );

  if (scope === "run") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line p-3 space-y-2">
          <div className="text-[13px] font-semibold">Пинов на одну ссылку</div>
          <div className="grid grid-cols-2 gap-2">
            {num("mixAi", "ИИ-пины", r.mix.ai)}
            {num("mixPhotos", "Фото из статьи", r.mix.photos)}
            {num("mixCanvas", "Canvas-пины", r.mix.canvas)}
            {num("mixPinora", "Pinora-пины", r.mix.pinora)}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Какие фото брать" hint="Миниатюра — главная картинка записи в WordPress"><select name="photosMode" className="input py-1.5" defaultValue={r.photosMode}><option value="auto">Авто: кулинария — миниатюра, остальное — фото из статьи</option><option value="sections">Всегда фото из статьи</option><option value="featured_only">Всегда только миниатюра записи</option></select></Field>
            <Field label="Фото со ссылкой, %"><input name="photoLinkPercent" type="number" min={0} max={100} className="input py-1.5" defaultValue={r.publishing.photoLinkPercent} /></Field>
          </div>
          <div>
            <div className="text-[12px] text-muted mb-1">Фото на одном Canvas-пине <span className="help">· ничего не отмечено — как умеет стиль; для кулинарии обычно только 1</span></div>
            <input type="hidden" name="canvasPhotoCountsPresent" value="1" />
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 6].map((n) => <label key={n} className={chip}><input type="checkbox" name="canvasPhotoCounts" value={n} defaultChecked={(r.sets.canvasPhotoCounts ?? []).includes(n)} className="h-3.5 w-3.5" /> {n} фото</label>)}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-line p-3 space-y-3">
          <div className="text-[13px] font-semibold">Блоговые статьи <span className="help">· как сделать, советы, чек-листы, рецепты — не подборки идей</span></div>
          <div className="grid gap-1.5">
            {([
              ["auto", "Определять по каждой статье", "Сначала ищем статью в нашем сервисе статей; если её там нет — смотрим устройство страницы (шаги, разделы, списки) и заголовок."],
              ["all", "Все статьи прогона — блоговые", "Для отдельного блогового прогона."],
              ["none", "Все статьи — подборки идей", "Блоговые шаблоны не используются."],
            ] as const).map(([v, l, h]) => (
              <label key={v} className="flex items-start gap-2 text-[13px]"><input type="radio" name="blogMode" value={v} defaultChecked={r.blog.mode === v} className="mt-0.5" /><span><b>{l}</b> <span className="help">— {h}</span></span></label>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {num("blogAi", "ИИ-пины (блог)", r.blog.ai)}
            {num("blogCanvas", "Canvas (блог)", r.blog.canvas)}
            {num("blogPhotos", "Готовых фото-пинов", r.blog.photos)}
          </div>
          {r.blog.canvas > 0 && <p className="help text-warn">Canvas для блога: фото наших статей — уже пины с надписями, Canvas режет их, и надписи получаются обрубками. Лучше 0.</p>}
          <p className="help">Это набор на одну блоговую статью вместо «Пинов на одну ссылку». Готовые фото-пины — вертикальные фото статьи в формате пина: публикуются как есть, все со ссылкой на статью, не больше указанного числа; фото, которые сайт уже публиковал, второй раз не берутся. Pinora блоговым статьям не делается. Доски — из досок с пометкой [блог] и досок для всех. В расписании пины одной блоговой статьи расходятся по разным дням.</p>
        </section>

        <section className="rounded-xl border border-line p-3 space-y-3">
          <div className="text-[13px] font-semibold">Расписание</div>
          <ScheduleModeFields s={r.schedule} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Модерация"><select name="moderationMode" className="input py-1.5" defaultValue={r.schedule.moderationMode}><option value="required">Обязательна</option><option value="auto">Автоодобрение</option></select></Field>
            <Field label="Доски">
              <input type="hidden" name="multiBoardPresent" value="1" />
              <label className={`${chip} mt-0.5`}><input type="checkbox" name="multiBoard" defaultChecked={r.boards.multiBoard} className="h-3.5 w-3.5" /> до 3 досок на пин</label>
            </Field>
          </div>
          <details className="rounded-lg border border-line px-3 py-2">
            <summary className="cursor-pointer text-[13px]">Предпочтения раскладки статьи <span className="help">· мягкие: норма дня важнее, при конфликте берётся ближайший возможный вариант</span></summary>
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Field label="Первый пин статьи в первые N дней"><input name="firstPinWindowDays" type="number" min={1} max={60} className="input py-1.5" defaultValue={r.schedule.firstPinWindowDays} /></Field>
              <Field label="Шаг между пинами статьи от, дней"><input name="stepMinDays" type="number" min={1} max={60} className="input py-1.5" defaultValue={r.schedule.stepMinDays} /></Field>
              <Field label="Шаг до, дней"><input name="stepMaxDays" type="number" min={1} max={60} className="input py-1.5" defaultValue={r.schedule.stepMaxDays} /></Field>
              <Field label="Пинов одной статьи в день" hint="0 — без ограничения"><input name="perPagePerDay" type="number" min={0} max={20} className="input py-1.5" defaultValue={r.schedule.perPagePerDay} /></Field>
            </div>
            <p className="help mt-2">Время публикации 08:00–21:00, минуты разбрасываются случайно.</p>
          </details>
        </section>

        {styles(true)}

        <section className="rounded-xl border border-line p-3 space-y-2 lg:col-span-2">
          <div className="flex items-baseline gap-2 flex-wrap">
            <div className="text-[13px] font-semibold">Элементы текстов и надписей</div>
            <span className="help">Для каждого элемента: на какой доле пинов он появится (0 — никогда, 100 — всегда) и что именно подставлять. Действует на ИИ-, Pinora- и Canvas-пины.</span>
          </div>
          <div className="divide-y divide-line rounded-lg border border-line">
            <div className="grid grid-cols-[1fr_96px] sm:grid-cols-[150px_110px_1fr] gap-2 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted">
              <span>Элемент</span><span>Доля пинов</span><span className="hidden sm:block">Что подставлять</span>
            </div>
            {element("pctSeason", "Сезон", r.text.percents.season, <span className="help">Слово сезона определяется по статье и дате.</span>)}
            {element("pctYear", "Год", r.text.percents.year, (
              <div>
                <div className="flex items-center gap-2">
                  <input name="textYear" inputMode="numeric" pattern="[0-9]{4}" className="input w-24 py-1 text-center" placeholder={pinYear({})} defaultValue={r.text.year} />
                  <span className="help">Пусто — текущий ({pinYear({})}, с октября уже следующий). Доля действует на надпись на пине, заголовок и описание.</span>
                </div>
              </div>
            ))}
            <YearRulesFields value={r.text.yearRules} baseYear={r.text.year || pinYear({})} />
            {element("pctNumber", "Число идей", r.text.percents.number, (
              <div className="flex items-center gap-2">
                <select name="numberSource" className="input py-1 w-auto" defaultValue={r.text.numberSource}><option value="sections">По разделам статьи (H2 с фото)</option><option value="images">По всем фото статьи</option><option value="none">Не считать</option></select>
                <span className="help">Цифра на пине и в текстах.</span>
              </div>
            ))}
            {element("pctCta", "Призыв", r.text.percents.cta, <span className="help">Фраза-призыв подбирается ИИ под тему.</span>)}
            {element("pctSiteName", "Имя сайта", r.text.percents.siteName, (
              <div className="flex items-center gap-2">
                <input name="textSiteName" className="input w-48 py-1" placeholder="site.com" defaultValue={r.text.siteName} />
                <span className="help">Пусто — домен сайта (домен для ссылок из настроек сайта, иначе домен статьи).</span>
              </div>
            ))}
            {element("pctHashtags", "Хэштеги", r.text.percents.hashtags, <span className="help">В описании пина; Pinterest их не показывает, но учитывает.</span>)}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Язык и аудитория</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Язык текстов"><select name="language" className="input py-1.5" defaultValue={r.text.language}>{LANGS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></Field>
          <Field label="Аудитория"><select name="audience" className="input py-1.5" defaultValue={r.text.audience}><option value="women">Женщины</option><option value="men">Мужчины</option><option value="mix">Смешанная</option></select></Field>
          <Field label="Фирменный цвет"><input name="brandColor" className="input py-1.5" placeholder="#FFC800" defaultValue={r.text.brandColor ?? ""} /></Field>
          <Field label="Домен для ссылок" hint="Пусто — домен статьи"><input name="linkDomain" className="input py-1.5" defaultValue={r.publishing.linkDomain} placeholder="site.com" /></Field>
          {data.wps && (
            <div className="col-span-2">
              <Field label="Доступ WordPress" hint="У сайта нет привязки к доступу: выберите, через какой WordPress грузить медиатеку.">
                <select name="wpConnectionId" className="input py-1.5" defaultValue={r.publishing.wpConnectionId ?? ""}>
                  <option value="">— не выбрано —</option>
                  {data.wps.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
          )}
        </div>
      </section>

      {styles(false)}
    </div>
  );
}
