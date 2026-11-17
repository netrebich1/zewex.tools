import Link from "next/link";

/** Вкладки направлений: «Вся Wexora» + направления верхнего уровня. `href(id)` строит адрес вкладки. */
export function DirTabs({ dirs, active, href }: { dirs: { id: string; name: string }[]; active?: string; href: (id?: string) => string }) {
  return (
    <div className="mb-4 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
      <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1 whitespace-nowrap">
        <Link href={href()} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold transition ${!active ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>Вся Wexora</Link>
        {dirs.map((d) => (
          <Link key={d.id} href={href(d.id)} className={`rounded-lg px-3.5 py-1.5 text-[14px] font-semibold transition ${active === d.id ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{d.name}</Link>
        ))}
      </div>
    </div>
  );
}
