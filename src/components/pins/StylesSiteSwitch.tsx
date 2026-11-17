"use client";
import { useRouter } from "next/navigation";

/** Выбор сайта на странице «Стили»: переключает сразу, без отдельной кнопки. */
export function StylesSiteSwitch({ tab, siteId, sites }: { tab: string; siteId: string; sites: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  return (
    <label className="ml-auto flex items-center gap-2 text-[13px]">
      <span className="text-muted">Сайт:</span>
      <select className="input py-1.5 font-medium" value={siteId} onChange={(e) => router.push(`/pinterest/pins/styles?tab=${tab}&site=${e.target.value}`)}>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}
