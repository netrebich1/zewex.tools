import type { ReactNode } from "react";
import { COLOR_HEX, GEO_LABELS, TAG_LABELS, money, unpack } from "@/lib/stylist/consts";
import type { CatalogItem } from "@/lib/stylist/queries";
import { BRAND_NAMES, parseSpirits } from "@/lib/stylist/dna";

/** Точка цвета: группа цвета или точный оттенок магазина. */
export function ColorDot({ color, hex, title }: { color: string; hex?: string; title?: string }) {
  const bg = hex || COLOR_HEX[color];
  return (
    <span
      title={title}
      className="inline-block h-3 w-3 shrink-0 rounded-full border border-line-2"
      style={bg ? { background: bg } : { background: "conic-gradient(#e33,#fc3,#3b6,#39f,#a4e,#e33)" }}
    />
  );
}

/** Фото вещи: тянется по ссылке с сайта магазина (у нас не хранится). */
export function ItemPhoto({ item, className = "" }: { item: { imageUrl: string; name: string }; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.imageUrl} alt={item.name} loading="lazy" referrerPolicy="no-referrer" className={`h-full w-full object-cover ${className}`} />
  );
}

export function Price({ item }: { item: { price: number; oldPrice: number | null; currency: string; priceEur: number } }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className={`text-[15px] font-bold ${item.oldPrice ? "text-danger" : ""}`}>{money(item.price, item.currency)}</span>
      {item.oldPrice && <span className="text-[12px] text-muted line-through">{money(item.oldPrice, item.currency)}</span>}
      {item.currency !== "EUR" && item.priceEur > 0 && <span className="text-[12px] text-muted">≈ {money(item.priceEur, "EUR")}</span>}
    </span>
  );
}

/** Метки «в духе бренда»: проверенные ИИ — сплошные (с оценкой), по словам названия — пунктиром. */
export function SpiritChips({ item }: { item: { spiritData: unknown; spiritAt: Date | null } }) {
  const list = parseSpirits(item.spiritData);
  if (!list.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((s) => (
        <span
          key={`${s.brand}-${s.source}`}
          title={`${s.why}${s.icon ? ` · ${s.icon}` : ""}${s.source === "rule" ? " (предположение, ИИ фото не смотрел)" : ""}`}
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${s.source === "ai" ? "bg-brand-soft text-warn" : "border border-dashed border-line-2 text-muted"}`}
        >
          {s.level === "lookalike" ? "≈ " : "в духе "}{BRAND_NAMES[s.brand]}{s.source === "ai" ? ` ${s.score}%` : "?"}
        </span>
      ))}
    </span>
  );
}

/** Карточка вещи каталога. `action` — кнопка под карточкой. */
export function ItemCard({ item, action, showGeo }: { item: CatalogItem; action?: ReactNode; showGeo?: boolean }) {
  const sizes = unpack(item.sizes);
  const tags = unpack(item.tags).slice(0, 3);
  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border border-line bg-surface ${item.inStock ? "" : "opacity-60"}`}>
      <a href={item.url} target="_blank" rel="noreferrer noopener" className="relative block aspect-[3/4] bg-ink/5" title="Открыть на сайте магазина">
        <ItemPhoto item={item} />
        {!item.inStock && <span className="absolute left-2 top-2 rounded bg-ink px-1.5 py-0.5 text-[11px] font-medium text-bg">нет в наличии</span>}
        {item.inStock && item.oldPrice && <span className="absolute left-2 top-2 rounded bg-danger px-1.5 py-0.5 text-[11px] font-medium text-white">−{Math.round((1 - item.price / item.oldPrice) * 100)}%</span>}
      </a>
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <div className="flex items-center justify-between gap-2 text-[12px] text-muted">
          <span className="truncate font-semibold uppercase tracking-wide">{item.store.brand}{showGeo ? ` · ${GEO_LABELS[item.store.geo] ?? item.store.geo}` : ""}</span>
          <span className="flex items-center gap-1 truncate"><ColorDot color={item.color} hex={item.colorHex} /><span className="truncate">{item.colorName}</span></span>
        </div>
        <div className="line-clamp-2 min-h-[2.5em] text-[13px] leading-tight">{item.name}</div>
        <Price item={item} />
        <SpiritChips item={item} />
        {(sizes.length > 0 || tags.length > 0) && (
          <div className="flex flex-wrap gap-1 text-[11px] text-muted">
            {sizes.length > 0 && <span className="rounded bg-ink/5 px-1.5 py-0.5">{sizes.join(" · ")}</span>}
            {tags.map((t) => <span key={t} className="rounded bg-ink/5 px-1.5 py-0.5">{TAG_LABELS[t] ?? t}</span>)}
          </div>
        )}
        {action && <div className="mt-auto pt-1.5">{action}</div>}
      </div>
    </div>
  );
}
