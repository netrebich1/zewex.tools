"use client";
import { useState } from "react";

export type ToolOption = { slug: string; name: string; section: string };

/**
 * Какие инструменты видит сотрудник: галочки по разделам или «все, включая будущие».
 * Поля читает `permissionsFromForm` (маркер `toolsPresent`, `toolsAll`, `tools`).
 */
export function ToolsAccessFields({ tools, value = [] }: { tools: ToolOption[]; value?: "all" | string[] }) {
  const [all, setAll] = useState(value === "all");
  const sections = [...new Set(tools.map((t) => t.section))];
  return (
    <div className="space-y-3">
      <input type="hidden" name="toolsPresent" value="1" />
      <label className="flex items-center gap-2 text-[14px]">
        <input type="checkbox" name="toolsAll" value="1" className="h-4 w-4" checked={all} onChange={(e) => setAll(e.target.checked)} /> Все инструменты, включая те, что появятся позже
      </label>
      {!all && (
        <div className="grid gap-3 sm:grid-cols-2">
          {sections.map((section) => (
            <div key={section}>
              <span className="label">{section}</span>
              <div className="space-y-1.5">
                {tools.filter((t) => t.section === section).map((t) => (
                  <label key={t.slug} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="tools" value={t.slug} defaultChecked={value !== "all" && value.includes(t.slug)} className="h-4 w-4" /> {t.name}</label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!all && <p className="help">Неотмеченные инструменты сотрудник не видит на главной и не откроет по ссылке.</p>}
    </div>
  );
}
