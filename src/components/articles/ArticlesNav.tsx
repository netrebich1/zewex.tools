"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Счётчики модерации (как на Обзоре и в списке «Модерации фото»): `moderationCounts` в src/lib/articles/queries.ts. */
export type NavCounts = { photos: number; insufficient: number; articles: number };

const ITEMS: Array<{ href: string; label: string; exact?: boolean; not?: string; count?: keyof NavCounts }> = [
  { href: "/pinterest/articles", label: "Обзор", exact: true },
  { href: "/pinterest/articles/automation", label: "Автозапуск" },
  { href: "/pinterest/articles/moderation/photos", label: "Модерация фото", count: "photos" },
  { href: "/pinterest/articles/moderation/ai", label: "ИИ-модерация" },
  { href: "/pinterest/articles/moderation/articles", label: "Модерация статей", count: "articles" },
  { href: "/pinterest/articles/publications", label: "Публикации" },
  { href: "/pinterest/articles/recipes", label: "Рецепты" },
  { href: "/pinterest/articles/journal", label: "Журнал" },
  { href: "/pinterest/articles/failed-keywords", label: "Неудачные ключи" },
  { href: "/pinterest/articles/sites", label: "Сайты" },
  { href: "/pinterest/articles/runs/new", label: "Новый запуск" },
];

/** Подменю сервиса «Статьи» (пилюли под шапкой портала, как у Пинов). Счётчики модерации обновляются при переходах. */
export function ArticlesNav({ counts: initial }: { counts?: NavCounts | null }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<NavCounts | null>(initial ?? null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/articles/moderation?counts=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { counts?: NavCounts } | null) => {
          if (alive && d?.counts) setCounts(d.counts);
        })
        .catch(() => {});
    const t = window.setTimeout(load, 300);
    const i = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearTimeout(t);
      window.clearInterval(i);
    };
  }, [pathname]);

  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Pinterest Articles</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href) && !(it.not && pathname.startsWith(it.not));
        const n = it.count && counts ? counts[it.count] : 0;
        const low = it.count === "photos" && counts ? counts.insufficient : 0;
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`} title={low ? `Ждут проверки: ${n}; «Мало фото»: ${low}` : undefined}>
            {it.label}
            {n > 0 && <span className={`rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${active ? "bg-bg/20" : "bg-brand-soft text-warn"}`}>{n}</span>}
          </Link>
        );
      })}
    </div>
  );
}
