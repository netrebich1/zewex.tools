import Link from "next/link";

const TYPES = [
  { key: "brand", href: "/gambling/domains/new", title: "Под бренды", hint: "Список брендов «бренд ; NL» → бренд + приставки + зоны" },
  { key: "emd", href: "/gambling/domains/emd/new", title: "EMD по таблице ключей", hint: "Ссылка на таблицу кластеров (тема, ключи, гео, частота) → домены из самих ключей" },
] as const;

/** Выбор типа подбора вверху формы нового подбора. */
export function RunTypeSwitch({ active }: { active: "brand" | "emd" }) {
  return (
    <div className="mb-5 grid gap-2 sm:grid-cols-2">
      {TYPES.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`rounded-xl border p-3 transition-colors ${active === t.key ? "border-ink bg-ink text-bg" : "border-line bg-surface hover:border-ink/40"}`}
        >
          <div className="font-semibold text-[15px]">{t.title}</div>
          <div className={`text-[12.5px] ${active === t.key ? "opacity-80" : "text-muted"}`}>{t.hint}</div>
        </Link>
      ))}
    </div>
  );
}
