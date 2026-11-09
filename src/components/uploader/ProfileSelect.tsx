"use client";
import { useMemo, useState } from "react";

/** Селект профиля Dolphin «имя · ID» с полем поиска по имени и ID (профилей бывают сотни, имена повторяются). Отправка — через AutoForm при смене селекта. */
export function ProfileSelect({ name, value, options }: { name: string; value: string; options: Array<{ id: string; name: string }> }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = s ? options.filter((o) => o.name.toLowerCase().includes(s) || o.id.includes(s) || o.id === value) : options;
    return base.slice(0, 300);
  }, [q, options, value]);
  return (
    <div className="flex gap-1.5">
      {options.length > 15 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="имя или ID…" className="input py-1 w-[110px] text-[12.5px]" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />}
      <select name={name} className="input py-1 text-[12.5px] min-w-[150px]" defaultValue={value} key={value}>
        <option value="">— не задан —</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.id}</option>)}
      </select>
    </div>
  );
}
