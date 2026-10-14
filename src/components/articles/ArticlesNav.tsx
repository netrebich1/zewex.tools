"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; exact?: boolean; not?: string }> = [
  { href: "/pinterest/articles", label: "Обзор", exact: true },
  { href: "/pinterest/articles/automation", label: "Автозапуск" },
  { href: "/pinterest/articles/moderation/photos", label: "Модерация фото" },
  { href: "/pinterest/articles/moderation/ai", label: "ИИ-модерация" },
  { href: "/pinterest/articles/moderation/articles", label: "Модерация статей" },
  { href: "/pinterest/articles/publications", label: "Публикации" },
  { href: "/pinterest/articles/recipes", label: "Рецепты" },
  { href: "/pinterest/articles/journal", label: "Журнал" },
  { href: "/pinterest/articles/sites", label: "Сайты" },
  { href: "/pinterest/articles/runs/new", label: "Новый запуск" },
];

/** Подменю сервиса «Статьи» (пилюли под шапкой портала, как у Пинов). */
export function ArticlesNav() {
  const pathname = usePathname();
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-line pb-3">
      <span className="text-[13px] font-semibold text-muted mr-2">Pinterest Articles</span>
      {ITEMS.map((it) => {
        const active = it.exact ? pathname === it.href : pathname.startsWith(it.href) && !(it.not && pathname.startsWith(it.not));
        return (
          <Link key={it.href} href={it.href} className={`tab ${active ? "active" : ""}`}>
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}
