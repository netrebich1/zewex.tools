"use client";
import { useState } from "react";
import { PINORA_NICHES, PINORA_TYPES } from "@/lib/pins/prompts/pinoraTypes";

const chip = "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px] cursor-pointer has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:text-ink hover:border-line-2";

/**
 * Pinora: ниша и типы пинов, как в старом сервисе. «Авто» — ниша определяется по каждой статье,
 * доступны только универсальные типы; конкретная ниша открывает её особые типы (Нутри, До/После…).
 */
export function PinoraPicker({ niche, types }: { niche: string; types: string[] }) {
  const [n, setN] = useState(PINORA_NICHES.some((x) => x.id === niche) ? niche : "auto");
  const [picked, setPicked] = useState<Set<string>>(new Set(types));
  const list = PINORA_TYPES.filter((t) => (n === "auto" ? !t.only : !t.only || t.only === n));
  const toggle = (id: string) => setPicked((p) => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  return (
    <div className="space-y-1.5">
      <select name="pinoraNiche" className="input py-1 w-auto" value={n} onChange={(e) => setN(e.target.value)}>
        <option value="auto">Ниша: авто (по каждой статье)</option>
        {PINORA_NICHES.map((x) => <option key={x.id} value={x.id}>Ниша: {x.label}</option>)}
      </select>
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => <label key={t.id} className={chip}><input type="checkbox" name="pinoraTypes" value={t.id} checked={picked.has(t.id)} onChange={() => toggle(t.id)} className="h-3.5 w-3.5" /> {t.ru}{t.only ? <span className="text-muted">· {PINORA_NICHES.find((x) => x.id === t.only)?.label}</span> : null}</label>)}
      </div>
      {n === "auto" && <p className="help">В режиме «авто» доступны только универсальные типы; особые (Нутри, Сравнение, Аппетит, До/После, Цветовая история) появятся при выборе ниши.</p>}
    </div>
  );
}
