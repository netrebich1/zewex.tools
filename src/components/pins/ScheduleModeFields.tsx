"use client";
import { useState } from "react";
import { Field } from "@/components/ui";
import type { Recipe } from "@/lib/pins/types";

/**
 * Режим расписания прогона, как в старом сервисе:
 * «Строго N в день» — главное правило, каждый день добивается до N, окно растёт само;
 * «От даты до даты» — все пины равномерно по дням между датами (потолок 100 в день, остаток после последней даты).
 */
export function ScheduleModeFields({ s }: { s: Recipe["schedule"] }) {
  const [mode, setMode] = useState<"fixed" | "dates">(s.dailyMode === "dates" ? "dates" : "fixed");
  const box = (m: "fixed" | "dates") => `rounded-xl border p-3 cursor-pointer ${mode === m ? "border-brand ring-2 ring-brand/30" : "border-line"}`;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className={box("fixed")}>
        <div className="flex items-center gap-2"><input type="radio" name="dailyMode" value="fixed" checked={mode === "fixed"} onChange={() => setMode("fixed")} /> <b>Строго N пинов в день</b></div>
        <p className="help mt-1">Этот прогон ставит ровно N своих пинов в каждый день, пока пины не кончатся. Пины других прогонов сайта на те же даты плюсуются. Сколько дней выйдет — считается само.</p>
        {mode === "fixed" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Пинов этого прогона в день"><input name="pinsPerDay" type="number" min={1} max={100} className="input py-1.5" defaultValue={s.pinsPerDay} /></Field>
            <Field label="Начинать с" hint="Пусто — ближайший день, где есть место"><input name="startFrom" type="date" className="input py-1.5" defaultValue={s.startFrom === "next_free_day" ? "" : s.startFrom} /></Field>
          </div>
        )}
      </label>
      <label className={box("dates")}>
        <div className="flex items-center gap-2"><input type="radio" name="dailyMode" value="dates" checked={mode === "dates"} onChange={() => setMode("dates")} /> <b>Равномерно от даты до даты</b></div>
        <p className="help mt-1">Все пины этого прогона делятся поровну по дням между двумя датами и плюсуются к пинам других прогонов.</p>
        {mode === "dates" && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="С даты" hint="Пусто — с ближайшего дня"><input name="startFrom" type="date" className="input py-1.5" defaultValue={s.startFrom === "next_free_day" ? "" : s.startFrom} /></Field>
            <Field label="По дату"><input name="lastDate" type="date" className="input py-1.5" defaultValue={s.lastDate} required /></Field>
            <input type="hidden" name="pinsPerDay" value={100} />
          </div>
        )}
      </label>
      <p className="help sm:col-span-2">Жёсткое правило: у сайта не больше <b>100 пинов в день</b> по всем прогонам вместе. Если настройки дают больше, лишние пины ставятся на ближайшие свободные дни, а рядом с прогоном появится жёлтая плашка: сколько перенесено и почему. Выгрузка всегда одна на день: один файл на сайт со всеми прогонами.</p>
    </div>
  );
}
