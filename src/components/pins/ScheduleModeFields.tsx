"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import type { Recipe, ScheduleMode } from "@/lib/pins/types";
import { GrowthStepsEditor } from "@/components/pins/GrowthStepsEditor";

/**
 * Режим расписания прогона:
 * «Строго N в день» — каждый день добивается до N, окно растёт само;
 * «От даты до даты» — все пины равномерно между датами (потолок 100 в день, остаток после последней даты);
 * «Плавный рост» — ступени для молодых сайтов: неделя по 15, неделя по 20, потом по 30…;
 * «Вклинить в график» — N пинов прогона в день поверх уже стоящих пинов сайта, по желанию с общим лимитом дня.
 */
export function ScheduleModeFields({ s }: { s: Recipe["schedule"] }) {
  const [mode, setMode] = useState<ScheduleMode>(s.dailyMode);
  const [insN, setInsN] = useState(Math.min(100, s.pinsPerDay || 15));
  const [keepTotal, setKeepTotal] = useState(s.insertTotal > 0);
  const [total, setTotal] = useState(s.insertTotal || 100);
  const box = (m: ScheduleMode) => `rounded-xl border p-3 cursor-pointer ${mode === m ? "border-brand ring-2 ring-brand/30" : "border-line"}`;
  const radio = (m: ScheduleMode, title: string) => (
    <div className="flex items-center gap-2"><input type="radio" name="dailyMode" value={m} checked={mode === m} onChange={() => setMode(m)} /> <b>{title}</b></div>
  );
  const startField = (hint = "Пусто — ближайший день, где есть место") => (
    <Field label="Начинать с" hint={hint}><input name="startFrom" type="date" className="input py-1.5" defaultValue={s.startFrom === "next_free_day" ? "" : s.startFrom} /></Field>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={box("fixed")}>
        {radio("fixed", "Строго N пинов в день")}
        <p className="help mt-1">Этот прогон ставит ровно N своих пинов в каждый день, пока пины не кончатся. Пины других прогонов сайта на те же даты плюсуются. Сколько дней выйдет — считается само.</p>
        {mode === "fixed" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Пинов этого прогона в день"><input name="pinsPerDay" type="number" min={1} max={100} className="input py-1.5" defaultValue={s.pinsPerDay} /></Field>
            {startField()}
          </div>
        )}
      </label>
      <label className={box("dates")}>
        {radio("dates", "Равномерно от даты до даты")}
        <p className="help mt-1">Все пины этого прогона делятся поровну по дням между двумя датами и плюсуются к пинам других прогонов.</p>
        {mode === "dates" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="С даты" hint="Пусто — с ближайшего дня"><input name="startFrom" type="date" className="input py-1.5" defaultValue={s.startFrom === "next_free_day" ? "" : s.startFrom} /></Field>
            <Field label="По дату"><input name="lastDate" type="date" className="input py-1.5" defaultValue={s.lastDate} required /></Field>
            <input type="hidden" name="pinsPerDay" value={100} />
          </div>
        )}
      </label>
      <label className={box("growth")}>
        {radio("growth", "Плавный рост (для молодых сайтов)")}
        <p className="help mt-1">Норма растёт ступенями: например, первую неделю по 15 пинов в день, вторую по 20, потом по 30. Новый аккаунт не получает сразу большой поток, Pinterest привыкает постепенно.</p>
        {mode === "growth" && (
          <div className="mt-2 space-y-2">
            <GrowthStepsEditor initial={s.growth} />
            <div className="grid grid-cols-2 gap-2">{startField("Пусто — с ближайшего свободного дня. День 1 ступеней = этот день")}</div>
            <input type="hidden" name="pinsPerDay" value={s.growth.at(-1)?.perDay ?? s.pinsPerDay} />
          </div>
        )}
      </label>
      <label className={box("insert")}>
        {radio("insert", "Вклинить в существующий график")}
        <p className="help mt-1">У сайта уже есть график. Этот прогон добавляет по N своих пинов в каждый день, начиная с даты, — поверх того, что уже стоит.</p>
        {mode === "insert" && (
          <div className="mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Пинов этого прогона в день"><input name="pinsPerDay" type="number" min={1} max={100} className="input py-1.5" value={insN} onChange={(e) => setInsN(Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))))} /></Field>
              {startField("Пусто — с ближайшего дня")}
            </div>
            <input type="hidden" name="insertTotalPresent" value="1" />
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" name="insertKeepTotal" checked={keepTotal} onChange={(e) => setKeepTotal(e.target.checked)} className="mt-0.5 h-3.5 w-3.5" />
              <span>Держать общее число пинов в дне — остальные пины сайта сдвинуть вперёд</span>
            </label>
            {keepTotal && <Field label="Всего пинов сайта в день" hint="Этот прогон + все остальные"><input name="insertTotal" type="number" min={insN} max={200} className="input py-1.5" value={total} onChange={(e) => setTotal(Math.max(1, Math.min(200, Math.floor(Number(e.target.value) || 1))))} /></Field>}
            <div className="rounded-lg bg-ink/5 px-3 py-2 text-[12.5px]">
              {keepTotal
                ? <>Пример: в дне было 90 пинов. Станет <b>{total}</b>: {insN} этого прогона + {Math.max(0, total - insN)} прежних, остальные прежние пины сдвинутся на следующие дни (порядок сохранится). Залитые в Pinterest дни и закреплённые пины не трогаются.{total > 100 && <> Сверх 100 в дне ({total - 100}) Pinterest опубликует <b>сразу</b> при загрузке файла.</>}</>
                : <>Пример: в дне было 90 пинов. Станет 90 + {insN} = <b>{90 + insN}</b>.{90 + insN > 100 ? <> Pinterest ставит по времени только 100 пинов в дне: 100 пойдут по расписанию, а {90 + insN - 100} — <b>сразу</b> при загрузке файла. Об этом будет жёлтая плашка у прогона.</> : " В пределах 100 — все пойдут по расписанию."} Больше 200 в день не ставится: лишнее уйдёт на следующие дни.</>}
            </div>
          </div>
        )}
      </label>
      <p className="help sm:col-span-2">Обычные режимы: у сайта не больше <b>100 пинов в день</b> по всем прогонам вместе, лишнее уходит на ближайшие свободные дни (жёлтая плашка у прогона). «Вклинить» и «Перераспределить график» (на странице сайта) разрешают до 200 в день: первые 100 — по расписанию, остальные публикуются сразу при загрузке файла. Выгрузка всегда одна на день: один файл на сайт со всеми прогонами.</p>
    </div>
  );
}
