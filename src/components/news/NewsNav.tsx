"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const ITEMS = [
  { href: "/discovery/news", label: "Лента", exact: true },
  { href: "/discovery/news/sources", label: "Источники" },
  { href: "/discovery/news/entities", label: "Сущности" },
  { href: "/discovery/news/views", label: "Просмотры" },
  { href: "/discovery/news/runs", label: "Прогоны и расход" },
  { href: "/discovery/news/settings", label: "Настройки" },
];

/** Подменю модуля «Новости» и переключатель проекта (сайта). */
export function NewsNav({ projects, current }: { projects: { id: string; name: string }[]; current: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const q = current ? `?project=${current}` : "";
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="mr-1 text-[13px] font-semibold text-muted">Новости для Discover</span>
      {projects.length > 1 ? (
        <select
          className="input !h-8 !w-auto !py-0 text-[13px]"
          value={current ?? ""}
          onChange={(e) => router.push(`${pathname}?project=${e.target.value}`)}
          aria-label="Проект"
        >
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      ) : projects[0] ? (
        <span className="badge bg-ink/5 text-ink-2">{projects[0].name}</span>
      ) : null}
      <span className="mx-1 hidden h-4 w-px bg-line sm:block" />
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
        return (
          <Link key={it.href} href={`${it.href}${q}`} className={`tab ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
