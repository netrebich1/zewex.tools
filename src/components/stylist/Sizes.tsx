import { unpack } from "@/lib/stylist/consts";

/**
 * Размерная сетка вещи: в наличии — зелёные, «осталось мало» — жёлтые, нет — зачёркнутые.
 * Если магазин отдаёт только размеры в наличии — показываем их; если размеры не загружены — подпись.
 */
export function SizeGrid({ item, compact }: { item: { sizes: string; sizesAll: string; sizesLow: string; sizesAt: Date | null }; compact?: boolean }) {
  const have = unpack(item.sizes);
  const low = unpack(item.sizesLow);
  const all = unpack(item.sizesAll).length ? unpack(item.sizesAll) : have;
  if (!item.sizesAt) return compact ? null : <span className="text-[13px] text-muted">размеры ещё не загружены</span>;
  if (!all.length) return <span className={`text-danger ${compact ? "text-[11px]" : "text-[13px]"}`}>размеров в наличии нет</span>;
  const box = compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-[13px]";
  return (
    <span className="flex flex-wrap gap-1">
      {all.map((s) => {
        const ok = have.includes(s);
        const few = low.includes(s);
        return (
          <span
            key={s}
            title={!ok ? "нет в наличии" : few ? "осталось мало" : "в наличии"}
            className={`rounded font-medium ${box} ${!ok ? "bg-ink/5 text-muted line-through" : few ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}
          >
            {s}
          </span>
        );
      })}
    </span>
  );
}
