import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Empty, PageHeader, type SearchParams } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ItemCard } from "@/components/stylist/ItemCard";
import { LookPicker } from "@/components/stylist/LookPicker";
import { checkStock } from "@/actions/stylist";
import { BASE_PATH, CATEGORIES, CATEGORY_LABELS, money } from "@/lib/stylist/consts";
import { activeLook, canSee, listCollections, lookChoices, looksOfItems } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistFavorites({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const q = await searchParams;
  const cat = typeof q.cat === "string" ? q.cat : "";
  const brand = typeof q.store === "string" ? q.store : "";
  const sort = typeof q.sort === "string" ? q.sort : "new";
  const favs = await prisma.stFav.findMany({
    orderBy: { createdAt: "desc" },
    take: 600,
    include: { item: { include: { store: { select: { id: true, name: true, brand: true, segment: true, geo: true, adapter: true, contacts: true } } } } },
  });
  const all = favs.map((f) => f.item);
  let items = all.filter((i) => (!cat || i.category === cat) && (!brand || i.store.brand === brand));
  if (sort === "price_asc") items = [...items].sort((a, b) => a.priceEur - b.priceEur);
  if (sort === "price_desc") items = [...items].sort((a, b) => b.priceEur - a.priceEur);
  if (sort === "discount") items = [...items].sort((a, b) => b.discount - a.discount);
  const [look, choices, collections, inLooks] = await Promise.all([activeLook(me), lookChoices(me), listCollections(me), looksOfItems(me, items.map((i) => i.id))]);
  const cats = CATEGORIES.filter((c) => all.some((i) => i.category === c.id));
  const brands = [...new Set(all.map((i) => i.store.brand))].sort();
  const href = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ ...(cat ? { cat } : {}), ...(brand ? { store: brand } : {}), ...(sort !== "new" ? { sort } : {}), ...patch });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    const s = p.toString();
    return `${BASE_PATH}/favorites${s ? `?${s}` : ""}`;
  };
  const gone = all.filter((i) => !i.inStock).length;
  const sale = all.filter((i) => i.discount > 0).length;
  const total = Math.round(items.reduce((s, i) => s + i.priceEur, 0) * 100) / 100;

  return (
    <>
      <StNav />
      <PageHeader
        title="Избранное"
        subtitle="Вещи, отложенные сердечком в каталоге или через расширение. Отсюда их удобно раскладывать по образам. Здесь видны и те вещи, которых уже нет в наличии."
        actions={all.length > 0 ? (
          <ActionForm action={checkStock} className="" hidden={{ fav: "1" }}>
            <SubmitButton pendingText="Проверяю… до минуты">Проверить наличие и цены</SubmitButton>
          </ActionForm>
        ) : undefined}
      />

      {all.length === 0 ? (
        <Empty title="В избранном пока пусто" hint="Нажмите на сердечко на фото вещи в каталоге — она появится здесь." action={<Link href={BASE_PATH} className="btn-primary">В каталог</Link>} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
            <span>Всего: <b>{all.length}</b></span>
            {sale > 0 && <span className="text-danger">со скидкой: <b>{sale}</b></span>}
            {gone > 0 && <span className="text-muted">нет в наличии: <b>{gone}</b></span>}
            <span className="text-muted">показано {items.length} на {money(total, "EUR")}</span>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            <Link href={href({ cat: "" })} className={`tab ${!cat ? "active" : ""}`}>Все вещи <span className="text-muted">{all.length}</span></Link>
            {cats.map((c) => <Link key={c.id} href={href({ cat: c.id })} className={`tab ${cat === c.id ? "active" : ""}`}>{CATEGORY_LABELS[c.id]} <span className="text-muted">{all.filter((i) => i.category === c.id).length}</span></Link>)}
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            <span className="mr-1 self-center text-[13px] text-muted">Магазин:</span>
            <Link href={href({ store: "" })} className={`tab ${!brand ? "active" : ""}`}>Все</Link>
            {brands.map((b) => <Link key={b} href={href({ store: b })} className={`tab ${brand === b ? "active" : ""}`}>{b} <span className="text-muted">{all.filter((i) => i.store.brand === b).length}</span></Link>)}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-line pb-3 text-[13px]">
            <span className="mr-1 text-muted">Сначала:</span>
            {[["new", "недавно добавленные"], ["price_asc", "дешёвые"], ["price_desc", "дорогие"], ["discount", "большая скидка"]].map(([id, label]) => (
              <Link key={id} href={href({ sort: id === "new" ? "" : id })} className={`tab ${sort === id ? "active" : ""}`}>{label}</Link>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {items.map((it) => (
              <ItemCard key={it.id} item={it} fav showGeo action={<LookPicker itemId={it.id} itemName={`${it.store.brand} · ${it.name}`} looks={choices} collections={collections} activeId={look?.id ?? null} inLooks={inLooks[it.id] ?? []} />} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
