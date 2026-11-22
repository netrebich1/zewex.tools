import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, Card, Empty, PageHeader, type SearchParams } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { AddButton } from "@/components/stylist/AddButton";
import { LookPicker } from "@/components/stylist/LookPicker";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { queueSpirit } from "@/actions/stylist";
import { BRANDS } from "@/lib/stylist/dna";
import { ColorDot, ItemCard } from "@/components/stylist/ItemCard";
import { BASE_PATH, CATEGORIES, COLORS, GEOS, SEGMENTS, SIZE_OPTIONS, TAGS, money } from "@/lib/stylist/consts";
import { PAGE_SIZE, activeLook, canSee, filterQuery, listCollections, listItems, lookChoices, looksOfItems, lookTotals, parseFilter } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

const one = (q: SearchParams, k: string) => (Array.isArray(q[k]) ? q[k]![0] : (q[k] as string | undefined));
const many = (q: SearchParams, k: string) => (Array.isArray(q[k]) ? (q[k] as string[]) : q[k] ? [q[k] as string] : []);

export default async function StylistCatalog({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const q = await searchParams;
  const f = parseFilter((k) => one(q, k), (k) => many(q, k));
  const analogId = (one(q, "analog") ?? "").slice(0, 40);
  const [data, look, choices, collections, analogPiece] = await Promise.all([
    listItems(f),
    activeLook(me),
    lookChoices(me),
    listCollections(me),
    analogId ? prisma.stLookItem.findUnique({ where: { id: analogId }, include: { item: { include: { store: true } }, look: { select: { id: true, name: true } } } }) : null,
  ]);
  const analog = analogPiece && !analogPiece.parentId ? analogPiece : null;
  const href = (patch: Parameters<typeof filterQuery>[1]) => `${BASE_PATH}${filterQuery(f, { page: 1, ...patch }, analog?.id ?? "")}`;
  const inLooks = await looksOfItems(me, data.rows.map((r) => r.id));
  const totals = look ? lookTotals(look) : null;
  const pages = Math.ceil(data.total / PAGE_SIZE);
  const catTotal = Object.values(data.byCat).reduce((a, b) => a + b, 0);
  const brandTotal = data.byBrand.reduce((a, b) => a + b.count, 0);
  const tagGroups = [...new Set(TAGS.map((t) => t.group))];
  const unchecked = data.rows.filter((r) => !r.spiritAt && !r.spiritAsked).map((r) => r.id);
  const filtersOn = !!(f.spirit || f.seg || f.color || f.size || f.tags.length || f.q || f.pmin != null || f.pmax != null || f.sale || f.all || f.sort !== "new");

  return (
    <>
      <StNav />
      <PageHeader
        title="Каталог"
        subtitle="Вещи магазинов Мальты и Украины в одном месте: выбирайте тип вещи, магазин, цвет и фасон — и складывайте в образ. Фото и цены тянутся с сайтов магазинов и обновляются раз в сутки."
        actions={<Link href={`${BASE_PATH}/add`} className="btn-ghost">Добавить вещь по ссылке</Link>}
      />

      {analog ? (
        <div className="mb-4">
          <Alert tone="warn">
            Подбираете аналог к вещи «{analog.item.name}» ({analog.item.store.brand}, {money(analog.item.price, analog.item.currency)}) из образа «{analog.look.name}». Нажмите «Как аналог» на подходящих вещах.{" "}
            <Link href={`${BASE_PATH}/looks/${analog.look.id}`} className="font-semibold underline">Готово, вернуться в образ</Link>
          </Alert>
        </div>
      ) : look && totals ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-brand-soft px-4 py-2.5 text-[14px]">
          <span>Последний образ: <b>{look.collection ? `${look.collection.name} → ` : ""}{look.name}</b></span>
          <span className="text-ink-2">{totals.pieces ? `${totals.pieces} вещ. · ${totals.native ? `${money(totals.native.sum, totals.native.currency)} ≈ ` : ""}${money(totals.eur, "EUR")}` : "пока пусто — нажимайте «В образ» на карточках"}</span>
          <Link href={`${BASE_PATH}/looks/${look.id}`} className="btn-primary btn-sm">Открыть образ</Link>
          <Link href={`${BASE_PATH}/looks`} className="text-[13px] text-muted underline">другой образ</Link>
        </div>
      ) : (
        <div className="mb-4"><Alert>Нажмите «＋ В образ» на любой вещи: откроется список коллекций и образов. Там же можно создать новый образ с названием и новую коллекцию. Одна вещь может лежать в нескольких образах.</Alert></div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex gap-1.5">
          {GEOS.map((g) => <Link key={g.id} href={href({ geo: g.id, store: "" })} className={`tab ${f.geo === g.id ? "active" : ""}`}>{g.label}</Link>)}
        </div>
        <div className="flex gap-1.5">
          {[{ id: "woman", label: "Женское" }, { id: "man", label: "Мужское" }, { id: "any", label: "Всё" }].map((g) => (
            <Link key={g.id} href={href({ gender: g.id })} className={`tab ${f.gender === g.id ? "active" : ""}`}>{g.label}</Link>
          ))}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <Link href={href({ cat: "" })} className={`tab ${!f.cat ? "active" : ""}`}>Все вещи <span className="text-muted">{catTotal.toLocaleString("ru-RU")}</span></Link>
        {CATEGORIES.filter((c) => data.byCat[c.id] || f.cat === c.id).map((c) => (
          <Link key={c.id} href={href({ cat: c.id })} className={`tab ${f.cat === c.id ? "active" : ""}`}>{c.label} <span className="text-muted">{(data.byCat[c.id] ?? 0).toLocaleString("ru-RU")}</span></Link>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5 border-b border-line pb-3">
        <span className="mr-1 self-center text-[13px] text-muted">Магазин:</span>
        <Link href={href({ store: "" })} className={`tab ${!f.store ? "active" : ""}`}>Все <span className="text-muted">{brandTotal.toLocaleString("ru-RU")}</span></Link>
        {data.byBrand.map((b) => (
          <Link key={b.brand} href={href({ store: b.brand })} className={`tab ${f.store === b.brand ? "active" : ""}`}>{b.brand} <span className="text-muted">{b.count.toLocaleString("ru-RU")}</span></Link>
        ))}
      </div>

      <Card className="mb-4">
        <form method="get" className="flex flex-col gap-3">
          {f.geo !== "MT" && <input type="hidden" name="geo" value={f.geo} />}
          {f.gender !== "woman" && <input type="hidden" name="gender" value={f.gender} />}
          {f.cat && <input type="hidden" name="cat" value={f.cat} />}
          {f.store && <input type="hidden" name="store" value={f.store} />}
          {analog && <input type="hidden" name="analog" value={analog.id} />}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Поиск</span>
              <input name="q" defaultValue={f.q} placeholder="название или артикул" className="input sm:!w-[220px]" />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Сегмент</span>
              <select name="seg" defaultValue={f.seg} className="input !w-auto">
                <option value="">любой</option>
                {SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Цвет</span>
              <select name="color" defaultValue={f.color} className="input !w-auto">
                <option value="">любой</option>
                {COLORS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">В духе бренда</span>
              <select name="spirit" defaultValue={f.spirit} className="input !w-auto">
                <option value="">не важно</option>
                <option value="any">любого люксового</option>
                {BRANDS.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Размер</span>
              <input name="size" defaultValue={f.size} list="st-sizes" placeholder="M или 38" className="input !w-[110px]" />
              <datalist id="st-sizes">{SIZE_OPTIONS.map((s) => <option key={s} value={s} />)}</datalist>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Цена, € от</span>
              <input name="pmin" defaultValue={f.pmin ?? ""} inputMode="decimal" className="input !w-[90px]" />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">до</span>
              <input name="pmax" defaultValue={f.pmax ?? ""} inputMode="decimal" className="input !w-[90px]" />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Сортировка</span>
              <select name="sort" defaultValue={f.sort} className="input !w-auto">
                <option value="new">сначала новые</option>
                <option value="price_asc">сначала дешёвые</option>
                <option value="price_desc">сначала дорогие</option>
              </select>
            </label>
          </div>
          <details open={f.tags.length > 0}>
            <summary className="cursor-pointer text-[13px] font-medium">Фасон, материал, детали{f.tags.length ? ` — выбрано ${f.tags.length}` : ""}</summary>
            <div className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {tagGroups.map((g) => (
                <div key={g}>
                  <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{g}</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {TAGS.filter((t) => t.group === g).map((t) => (
                      <label key={t.id} className="flex items-center gap-1.5 text-[13px]">
                        <input type="checkbox" name="tag" value={t.id} defaultChecked={f.tags.includes(t.id)} /> {t.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" name="sale" value="1" defaultChecked={f.sale} /> только со скидкой</label>
            <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" name="all" value="1" defaultChecked={f.all} /> показывать и те, которых нет в наличии</label>
            <button className="btn-primary btn-sm">Показать</button>
            {filtersOn && <Link href={`${BASE_PATH}${filterQuery({ ...f, spirit: "", seg: "", color: "", size: "", tags: [], q: "", pmin: null, pmax: null, sale: false, all: false, sort: "new", page: 1 }, {}, analog?.id ?? "")}`} className="text-[13px] text-muted underline">сбросить фильтры</Link>}
          </div>
          {f.size && <p className="help">Размер ищется среди вещей, у которых размеры уже загружены. Zara отдаёт размеры только в карточке товара — они подтягиваются, когда вещь попадает в образ.</p>}
        </form>
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-[13px] text-muted">
        <span>Найдено: <b className="text-ink">{data.total.toLocaleString("ru-RU")}</b></span>
        {f.color && <span className="flex items-center gap-1"><ColorDot color={f.color} /> {COLORS.find((c) => c.id === f.color)?.label}</span>}
        {unchecked.length > 0 && (
          <ActionForm action={queueSpirit} className="flex flex-wrap items-center gap-2" hidden={{ items: unchecked.join(",") }}>
            <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm={`ИИ посмотрит фото ${unchecked.length} вещей на этой странице и отметит, какие из них в духе люксовых брендов. Это платно: меньше цента за вещь с ключа команды. Запустить?`}>ИИ: в духе каких брендов эти вещи ({unchecked.length})</SubmitButton>
          </ActionForm>
        )}
      </div>

      {data.rows.length === 0 ? (
        <Empty
          title="Ничего не найдено"
          hint={brandTotal === 0 && !filtersOn ? "Каталог этой страны ещё не собран. Откройте «Магазины» и нажмите «Обновить сейчас» или добавьте вещь по ссылке." : "Попробуйте снять часть фильтров или выбрать другой тип вещи."}
          action={<Link href={`${BASE_PATH}/stores`} className="btn-primary">Магазины</Link>}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {data.rows.map((it) => (
            <ItemCard key={it.id} item={it} action={analog ? <AddButton itemId={it.id} analog={analog.id} /> : <LookPicker itemId={it.id} itemName={`${it.store.brand} · ${it.name}`} looks={choices} collections={collections} activeId={look?.id ?? null} inLooks={inLooks[it.id] ?? []} />} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[14px]">
          {f.page > 1 && <Link href={href({ page: f.page - 1 })} className="btn-ghost btn-sm">← Назад</Link>}
          <span className="text-muted">Страница {f.page} из {pages}</span>
          {f.page < pages && <Link href={href({ page: f.page + 1 })} className="btn-primary btn-sm">Дальше →</Link>}
        </div>
      )}
    </>
  );
}
