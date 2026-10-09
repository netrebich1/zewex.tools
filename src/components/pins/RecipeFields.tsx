import { Field } from "@/components/ui";
import type { Recipe } from "@/lib/pins/types";

export type RecipeSetOption = { id: string; name: string; count: number; topic?: string };
export type RecipeCanvasStyle = { id: string; name: string; previewUrl: string | null; zewex: boolean };
export type RecipeFieldsData = {
  aiSets: RecipeSetOption[];
  /** Утверждённые Canvas-стили каталога (выбираются напрямую, с превью). */
  canvasStyles: RecipeCanvasStyle[];
  pinoraTypes: Array<{ id: string; ru: string }>;
  /** Доступы WordPress команды; не передавать, если выбор WP на этой форме не нужен. */
  wps?: Array<{ id: string; name: string }>;
};

export const LANGS = [["en", "English"], ["ru", "Русский"], ["uk", "Українська"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["pl", "Polski"], ["pt", "Português"]];

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:text-ink hover:border-line-2";

/**
 * Поля рецепта: компактно, в четыре блока. Наборы ИИ и типы Pinora — чипы,
 * Canvas-стили — сетка превью. Чистая разметка без серверных импортов.
 */
export function RecipeFields({ r, data }: { r: Recipe; data: RecipeFieldsData }) {
  const num = (name: string, label: string, value: number, max = 20, min = 0) => (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
      <span className="text-[13px]">{label}</span>
      <input name={name} type="number" min={min} max={max} className="input w-20 py-1 text-center" defaultValue={value} />
    </label>
  );
  const pct = (name: string, label: string, value: number) => (
    <label className="flex items-center justify-between gap-1 rounded-lg border border-line px-2 py-1">
      <span className="text-[12px]">{label}</span>
      <span className="flex items-center gap-0.5"><input name={name} type="number" min={0} max={100} className="input w-14 py-0.5 px-1 text-center text-[12px]" defaultValue={value} /><span className="text-[11px] text-muted">%</span></span>
    </label>
  );
  const check = (name: string, label: string, on: boolean) => (
    <label className={chip}><input type="checkbox" name={name} defaultChecked={on} className="h-3.5 w-3.5" /> {label}</label>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 1. Сколько и каких пинов */}
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Пинов на одну ссылку</div>
        <div className="grid grid-cols-2 gap-2">
          {num("mixAi", "ИИ-пины", r.mix.ai)}
          {num("mixPhotos", "Фото из статьи", r.mix.photos)}
          {num("mixCanvas", "Canvas-пины", r.mix.canvas)}
          {num("mixPinora", "Pinora-пины", r.mix.pinora)}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Какие фото брать"><select name="photosMode" className="input py-1.5" defaultValue={r.photosMode}><option value="all">Все фото статьи</option><option value="featured_only">Только миниатюру</option></select></Field>
          <Field label="Фото со ссылкой, %"><input name="photoLinkPercent" type="number" min={0} max={100} className="input py-1.5" defaultValue={r.publishing.photoLinkPercent} /></Field>
        </div>
      </section>

      {/* 2. Расписание и публикация */}
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Расписание и публикация</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Пинов в день (до 100)"><input name="pinsPerDay" type="number" min={1} max={100} className="input py-1.5" defaultValue={r.schedule.pinsPerDay} /></Field>
          <Field label="Начинать с" hint="Пусто — следующий свободный день"><input name="startFrom" type="date" className="input py-1.5" defaultValue={r.schedule.startFrom === "next_free_day" ? "" : r.schedule.startFrom} /></Field>
          <Field label="Модерация"><select name="moderationMode" className="input py-1.5" defaultValue={r.schedule.moderationMode}><option value="required">Обязательна</option><option value="auto">Автоодобрение</option></select></Field>
          <Field label="Домен для ссылок" hint="Пусто — домен статьи"><input name="linkDomain" className="input py-1.5" defaultValue={r.publishing.linkDomain} placeholder="site.com" /></Field>
          {data.wps && (
            <div className="col-span-2">
              <Field label="WordPress для медиатеки">
                <select name="wpConnectionId" className="input py-1.5" defaultValue={r.publishing.wpConnectionId ?? ""}>
                  <option value="">— не выбрано —</option>
                  {data.wps.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
          )}
        </div>
        <p className="help">Окно 30 дней, до 2 пинов со статьи в день, первый пин в первые 3 дня, шаг 2–5 дней, 08:00–21:00.</p>
      </section>

      {/* 3. Тексты */}
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">Тексты и надписи</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Язык"><select name="language" className="input py-1.5" defaultValue={r.text.language}>{LANGS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></Field>
          <Field label="Аудитория"><select name="audience" className="input py-1.5" defaultValue={r.text.audience}><option value="women">Женщины</option><option value="men">Мужчины</option><option value="mix">Смешанная</option></select></Field>
          <Field label="Число идей брать" hint="Цифра на пине и в текстах"><select name="numberSource" className="input py-1.5" defaultValue={r.text.numberSource}><option value="sections">По разделам статьи (H2 с фото)</option><option value="images">По всем фото статьи</option><option value="none">Не считать</option></select></Field>
          <Field label="Фирменный цвет"><input name="brandColor" className="input py-1.5" placeholder="#FFC800" defaultValue={r.text.brandColor ?? ""} /></Field>
        </div>
        <div className="text-[12px] text-muted">Доля пинов с элементом, % (0 — никогда, 100 — всегда). Действует на ИИ-, Pinora- и Canvas-пины.</div>
        <div className="grid grid-cols-3 gap-1.5">
          {pct("pctSeason", "сезон", r.text.percents.season)}
          {pct("pctYear", "год", r.text.percents.year)}
          {pct("pctNumber", "число идей", r.text.percents.number)}
          {pct("pctCta", "призыв", r.text.percents.cta)}
          {pct("pctSiteName", "имя сайта", r.text.percents.siteName)}
          {pct("pctHashtags", "хэштеги", r.text.percents.hashtags)}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {check("multiBoard", "до 3 досок на пин", r.boards.multiBoard)}
        </div>
      </section>

      {/* 4. ИИ-наборы и Pinora */}
      <section className="rounded-xl border border-line p-3 space-y-2">
        <div className="text-[13px] font-semibold">ИИ-наборы</div>
        <div className="flex flex-wrap gap-1.5">
          {data.aiSets.map((s) => <label key={s.id} className={chip}><input type="checkbox" name="aiSetIds" value={s.id} defaultChecked={r.sets.aiSetIds.includes(s.id)} className="h-3.5 w-3.5" /> {s.name} <span className="text-muted">{s.count}</span></label>)}
          {!data.aiSets.length && <p className="help">Наборов нет: соберите их в разделе «Стили».</p>}
        </div>
        <div className="text-[13px] font-semibold pt-1">Типы Pinora</div>
        <div className="flex flex-wrap gap-1.5">
          {data.pinoraTypes.map((t) => <label key={t.id} className={chip}><input type="checkbox" name="pinoraTypes" value={t.id} defaultChecked={r.sets.pinoraTypes.includes(t.id)} className="h-3.5 w-3.5" /> {t.ru}</label>)}
        </div>
      </section>

      {/* 5. Canvas-стили */}
      <section className="rounded-xl border border-line p-3 space-y-2 lg:col-span-2">
        <div className="flex items-baseline gap-2">
          <div className="text-[13px] font-semibold">Canvas-стили</div>
          <span className="help">Отметьте стили для этого {data.wps ? "сайта" : "прогона"}. Ничего не отмечено — используются все утверждённые.</span>
        </div>
        {data.canvasStyles.length === 0 ? (
          <p className="help">Утверждённых стилей нет: откройте Стили → Canvas-стили и примите понравившиеся.</p>
        ) : (
          <div className="grid gap-2 grid-cols-4 sm:grid-cols-6 lg:grid-cols-10">
            {data.canvasStyles.map((c) => (
              <label key={c.id} className="group relative cursor-pointer rounded-lg border border-line p-1 has-[:checked]:border-brand has-[:checked]:ring-2 has-[:checked]:ring-brand/40" title={c.name}>
                <input type="checkbox" name="canvasStyleIds" value={c.id} defaultChecked={r.sets.canvasStyleIds?.includes(c.id)} className="absolute left-2 top-2 z-10 h-4 w-4" />
                {c.previewUrl ? <img src={c.previewUrl} alt="" loading="lazy" className="w-full aspect-[2/3] object-cover rounded-md" /> : <div className="w-full aspect-[2/3] rounded-md bg-ink/5" />}
                <div className="mt-1 text-[11px] leading-tight truncate">{c.zewex ? "★ " : ""}{c.name}</div>
              </label>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
