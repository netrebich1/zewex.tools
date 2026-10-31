import Link from "next/link";
import type { GroupRef } from "@/lib/analytics/access";

/** Фильтр по группам сайтов: «Все сайты» + группы (цветная точка). `href(groupId)` строит адрес с остальными параметрами. */
export function GroupChips({ groups, active, href, total }: { groups: GroupRef[]; active?: string; href: (id?: string) => string; total: number }) {
  if (!groups.length) return null;
  const chip = (on: boolean) => `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition ${on ? "bg-ink text-bg border-ink" : "border-line bg-surface text-ink-2 hover:border-line-2"}`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <Link href={href()} className={chip(!active)}>Все сайты <span className="opacity-60 tabular-nums">{total}</span></Link>
      {groups.map((g) => (
        <Link key={g.id} href={href(g.id)} className={chip(active === g.id)}>
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: g.color }} />{g.name} <span className="opacity-60 tabular-nums">{g.count}</span>
        </Link>
      ))}
    </div>
  );
}
