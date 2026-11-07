"use client";
import { useState, type ReactNode } from "react";

/**
 * «Показать ещё»: длинный список не выводится целиком — первые `initial` элементов, дальше кнопка
 * «Показать ещё N» (по `step` за раз) и «Свернуть». Элементы приходят готовыми (со своими key),
 * поэтому компонент подходит и для серверных страниц: они передают массив JSX.
 */
type Common = { initial?: number; step?: number; noun?: string };

function label(rest: number, step: number, noun?: string) {
  const n = Math.min(step, rest);
  return n === rest ? `Показать ещё ${rest}${noun ? ` ${noun}` : ""}` : `Показать ещё ${n} из ${rest}`;
}

/** Для обычных списков: `as` — контейнер (div / ul / ol), кнопки — под ним. */
export function ShowMore({ items, initial = 5, step = 20, noun, as: Tag = "div", className = "", controlsClassName = "" }: Common & {
  items: ReactNode[]; as?: "div" | "ul" | "ol"; className?: string; controlsClassName?: string;
}) {
  const [shown, setShown] = useState(initial);
  const rest = items.length - shown;
  return (
    <>
      <Tag className={className}>{items.slice(0, shown)}</Tag>
      {(rest > 0 || shown > initial) && (
        <div className={`mt-2 flex flex-wrap gap-2 ${controlsClassName}`}>
          {rest > 0 && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown((s) => s + step)}>{label(rest, step, noun)}</button>}
          {rest > 0 && rest > step && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown(items.length)}>Показать все {items.length}</button>}
          {shown > initial && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown(initial)}>Свернуть</button>}
        </div>
      )}
    </>
  );
}

/** Для строк таблицы: ставится внутрь <tbody>, кнопки — отдельной строкой на всю ширину. */
export function ShowMoreRows({ rows, colSpan, initial = 10, step = 50, noun }: Common & { rows: ReactNode[]; colSpan: number }) {
  const [shown, setShown] = useState(initial);
  const rest = rows.length - shown;
  return (
    <>
      {rows.slice(0, shown)}
      {(rest > 0 || shown > initial) && (
        <tr className="hover:!bg-transparent">
          <td colSpan={colSpan} className="!py-2">
            <div className="flex flex-wrap gap-2">
              {rest > 0 && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown((s) => s + step)}>{label(rest, step, noun)}</button>}
              {rest > 0 && rest > step && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown(rows.length)}>Показать все {rows.length}</button>}
              {shown > initial && <button type="button" className="btn-ghost btn-sm" onClick={() => setShown(initial)}>Свернуть</button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
