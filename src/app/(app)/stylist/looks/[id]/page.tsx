import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { SizeGrid } from "@/components/stylist/Sizes";
import { StoreContacts, branchCount } from "@/components/stylist/StoreContacts";
import { ColorDot, ItemPhoto, Price, SpiritChips } from "@/components/stylist/ItemCard";
import { activateLook, checkSpirit, checkStock, copyLook, deleteLook, lookPieceAction, saveLook } from "@/actions/stylist";
import { AutoSubmitSelect } from "@/components/stylist/PrintButton";
import { BASE_PATH, CATEGORY_LABELS, GEO_LABELS, SEGMENT_LABELS, money, seasonLabel, unpack } from "@/lib/stylist/consts";
import { activeLook, canSee, getLook, listClients, listCollections, lookTotals, type LookPiece } from "@/lib/stylist/queries";
import { clientFit, type ClientSizes } from "@/lib/stylist/clients";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

function Sizes({ piece }: { piece: LookPiece }) {
  return <span className="flex flex-wrap items-center gap-1.5">{piece.item.sizesAt ? "В интернет-магазине:" : ""} <SizeGrid item={piece.item} /></span>;
}

/** Цена изменилась с момента, когда вещь положили в образ. */
function PriceChange({ piece }: { piece: LookPiece }) {
  const was = piece.addedPrice;
  if (!was || Math.abs(was - piece.item.price) < 0.005) return null;
  const down = piece.item.price < was;
  return <span className={`text-[13px] font-medium ${down ? "text-ok" : "text-danger"}`}>{down ? "Подешевела" : "Подорожала"}: при добавлении в образ была {money(was, piece.item.currency)}</span>;
}

/** Есть ли вещь в размере клиента из карточки. */
function Fit({ client, piece }: { client: ClientSizes; piece: LookPiece }) {
  const f = clientFit(client, piece.item);
  if (f.state === "unknown") return null;
  if (f.state === "fit") return <span className="text-[13px] text-ok">Размер клиента {f.size} есть в наличии{piece.size && piece.size.toUpperCase() !== f.size ? ` (выбран другой: ${piece.size})` : ""}</span>;
  return <span className="text-[13px] font-medium text-danger">{f.state === "out" ? `Размера клиента ${f.size} сейчас нет в наличии` : `В размерной сетке вещи нет размера клиента (${f.size})`}</span>;
}

/** Что прислало расширение со страницы магазина: в каких магазинах есть вещь (город и размеры, по которым искали). */
function StoreStock({ piece }: { piece: LookPiece }) {
  const s = piece.item.storeStock as { at?: string; city?: string; sizes?: string[]; stores?: string[]; none?: boolean } | null;
  if (!s?.at) return null;
  return (
    <div className={`rounded-lg px-3 py-2 text-[13px] ${s.none ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>
      <b>{s.none ? "В магазинах поблизости нет" : `Есть в магазинах: ${(s.stores ?? []).length}`}</b>
      <span className="text-ink-2"> · {[s.city && `город ${s.city}`, s.sizes?.length && `размеры ${s.sizes.join(", ")}`, `проверено на сайте магазина ${fmtDate(s.at)}`].filter(Boolean).join(" · ")}</span>
      {!s.none && <ul className="mt-1 list-disc pl-5 text-ink">{(s.stores ?? []).map((x) => <li key={x}>{x}</li>)}</ul>}
    </div>
  );
}

/** Отметка стилиста: есть ли вещь в обычном магазине (после звонка, письма или проверки на сайте магазина). */
function InStore({ piece }: { piece: LookPiece }) {
  return (
    <ActionForm action={lookPieceAction} className="flex flex-wrap items-center gap-2 text-[13px]" hidden={{ piece: piece.id, op: "store" }}>
      <span className="font-medium">В магазине на острове:</span>
      <AutoSubmitSelect name="inStore" defaultValue={piece.inStore} options={[{ value: "", label: "не проверяли" }, { value: "yes", label: "есть — проверено" }, { value: "no", label: "нет" }]} />
      {piece.inStoreAt && <span className="text-muted">отмечено {fmtDate(piece.inStoreAt)}</span>}
    </ActionForm>
  );
}

/** Нужный клиенту размер: из сетки магазина; если магазин сетку не отдаёт — поле для ввода. */
function WantedSize({ piece }: { piece: LookPiece }) {
  const all = unpack(piece.item.sizesAll).length ? unpack(piece.item.sizesAll) : unpack(piece.item.sizes);
  const have = unpack(piece.item.sizes);
  const missing = !!piece.size && !!piece.item.sizesAt && !have.includes(piece.size);
  return (
    <ActionForm action={lookPieceAction} className="flex flex-wrap items-center gap-2 text-[13px]" hidden={{ piece: piece.id, op: "size" }}>
      <span className="font-medium">Нужный размер:</span>
      {all.length ? (
        <AutoSubmitSelect name="size" defaultValue={piece.size} options={[{ value: "", label: "не выбран" }, ...[...new Set([...all, ...(piece.size ? [piece.size] : [])])].map((s) => ({ value: s, label: have.includes(s) ? s : `${s} — нет` }))]} />
      ) : (
        <>
          <input name="size" defaultValue={piece.size} maxLength={20} placeholder="M или 38" className="input !w-[90px] !py-1 text-[13px]" />
          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
        </>
      )}
      {missing && <span className="font-medium text-danger">этого размера сейчас нет</span>}
      {!!piece.size && !missing && !!piece.item.sizesAt && <span className="text-ok">есть в наличии</span>}
    </ActionForm>
  );
}

function PieceActions({ piece, analog }: { piece: LookPiece; analog?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <a href={piece.item.url} target="_blank" rel="noreferrer noopener" className="btn-ghost btn-sm">На сайте магазина ↗</a>
      {analog && (
        <ActionForm action={lookPieceAction} className="" hidden={{ piece: piece.id, op: "main" }}>
          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сделать основной</SubmitButton>
        </ActionForm>
      )}
      {(piece.item.store.adapter === "zara" || piece.item.store.adapter === "itx") && (
        <ActionForm action={lookPieceAction} className="" hidden={{ piece: piece.id, op: "sizes" }}>
          <SubmitButton className="btn-ghost btn-sm" pendingText="Проверяю…">Проверить размеры</SubmitButton>
        </ActionForm>
      )}
      <ActionForm action={checkSpirit} className="" hidden={{ item: piece.itemId }}>
        <SubmitButton className="btn-ghost btn-sm" pendingText="ИИ смотрит фото…">{piece.item.spiritAt ? "Перепроверить бренд" : "В духе какого бренда?"}</SubmitButton>
      </ActionForm>
      <ActionForm action={lookPieceAction} className="" hidden={{ piece: piece.id, op: "remove" }}>
        <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm={analog ? undefined : "Убрать вещь из образа вместе с её аналогами?"}>Убрать</SubmitButton>
      </ActionForm>
    </div>
  );
}

export default async function StylistLook({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const { id } = await params;
  const [look, active, collections, clients] = await Promise.all([getLook(me, id), activeLook(me), listCollections(me), listClients(me)]);
  if (!look) notFound();
  const t = lookTotals(look);
  const client = look.client ?? look.collection?.client ?? null;
  const main = look.items.filter((p) => !p.parentId);
  const analogsOf = (pid: string) => look.items.filter((p) => p.parentId === pid);
  const isActive = active?.id === look.id;
  const catalogFor = (p: LookPiece) => {
    const q = new URLSearchParams({ analog: p.id, cat: p.item.category });
    if (p.item.store.geo !== "MT") q.set("geo", p.item.store.geo);
    if (p.item.gender !== "woman") q.set("gender", p.item.gender === "man" ? "man" : "any");
    return `${BASE_PATH}?${q.toString()}`;
  };
  const diff = (a: number, b: number) => money(Math.abs(Math.round((a - b) * 100) / 100), "EUR");

  return (
    <>
      <StNav />
      <PageHeader
        title={look.name}
        back={{ href: `${BASE_PATH}/looks`, label: look.collection ? `Коллекция «${look.collection.name}»` : "Все образы" }}
        actions={<>
          <Link href={`${BASE_PATH}/list?look=${look.id}`} className="btn-brand">Шопинг-лист</Link>
          <ActionForm action={checkStock} className="" hidden={{ look: look.id }}><SubmitButton className="btn-ghost" pendingText="Проверяю… до минуты">Проверить наличие</SubmitButton></ActionForm>
          {isActive ? <Link href={BASE_PATH} className="btn-primary">Добавить вещи из каталога</Link> : (
            <ActionForm action={activateLook} className="" hidden={{ look: look.id }}><SubmitButton>Собирать этот образ</SubmitButton></ActionForm>
          )}
        </>}
      />

      {client && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-[14px]">
          <span>Клиент: <Link href={`${BASE_PATH}/clients/${client.id}`} className="font-semibold underline">{client.name}</Link>{!look.client && look.collection ? <span className="text-muted"> (по коллекции)</span> : null}</span>
          <span className="text-ink-2">{[client.city && `город ${client.city}`, client.height && `рост ${client.height}`, client.sizeTop && `верх ${client.sizeTop}`, client.sizeBottom && `низ ${client.sizeBottom}`, client.sizeShoes && `обувь ${client.sizeShoes}`].filter(Boolean).join(" · ") || "размеры в карточке не указаны"}</span>
          {client.budget ? <span className={t.eur > client.budget ? "font-medium text-danger" : "text-ok"}>бюджет {money(client.budget, "EUR")}: {t.eur > client.budget ? `превышен на ${money(Math.round((t.eur - client.budget) * 100) / 100, "EUR")}` : "укладываемся"}</span> : null}
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="kpi">
          <span className="text-[13px] text-muted">Цена образа</span>
          <span className="kpi-value">{t.native ? money(t.native.sum, t.native.currency) : money(t.eur, "EUR")}</span>
          {t.native && <span className="text-[13px] text-muted">≈ {money(t.eur, "EUR")}</span>}
        </div>
        <div className="kpi">
          <span className="text-[13px] text-muted">С самыми дешёвыми аналогами</span>
          <span className="kpi-value">{money(t.minEur, "EUR")}</span>
          <span className="text-[13px] text-muted">{t.minEur < t.eur ? `экономия ${diff(t.eur, t.minEur)}` : "аналогов дешевле нет"}</span>
        </div>
        <div className="kpi">
          <span className="text-[13px] text-muted">Вещей</span>
          <span className="kpi-value">{t.pieces}</span>
          <span className={`text-[13px] ${t.outOfStock ? "text-danger" : "text-muted"}`}>{t.outOfStock ? `нет в наличии: ${t.outOfStock}` : "все в наличии"}</span>
        </div>
      </div>

      {main.length === 0 ? (
        <Empty title="В образе пока нет вещей" hint="Откройте каталог и нажимайте «В образ» на карточках." action={isActive ? <Link href={BASE_PATH} className="btn-primary">В каталог</Link> : undefined} />
      ) : (
        <div className="flex flex-col gap-4">
          {main.map((p) => {
            const analogs = analogsOf(p.id);
            return (
              <Card key={p.id}>
                <div className="flex flex-col gap-4 sm:flex-row">
                  <a href={p.item.url} target="_blank" rel="noreferrer noopener" className="block aspect-[3/4] w-full shrink-0 overflow-hidden rounded-xl bg-ink/5 sm:w-[190px]"><ItemPhoto item={p.item} /></a>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">
                      {p.item.store.brand} · {GEO_LABELS[p.item.store.geo] ?? p.item.store.geo} · {SEGMENT_LABELS[p.item.store.segment] ?? ""} · {CATEGORY_LABELS[p.item.category] ?? ""}
                    </div>
                    <div className="text-[16px] font-semibold leading-snug">{p.item.name}</div>
                    <div className="text-[13px] text-muted">
                      {p.item.sku && <>Артикул: <span className="select-all font-mono text-ink">{p.item.sku}</span> · </>}
                      наличие в интернет-магазине проверено {fmtDate(p.item.sizesAt ?? p.item.lastSeenAt)}
                    </div>
                    {(p.item.season || p.item.composition || p.item.madeIn || p.item.storeDate) && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-2">
                        {p.item.season && <span>Сезон: {seasonLabel(p.item.season)}</span>}
                        {p.item.storeDate && <span>На сайте с {fmtDate(p.item.storeDate)}</span>}
                        {p.item.composition && <span>Состав: {p.item.composition}</span>}
                        {p.item.madeIn && <span>Сделано: {p.item.madeIn}</span>}
                      </div>
                    )}
                    {p.item.description && (
                      <details className="text-[13px]">
                        <summary className="cursor-pointer text-muted">Описание магазина</summary>
                        <p className="mt-1 leading-relaxed text-ink-2">{p.item.description}</p>
                      </details>
                    )}
                    <Price item={p.item} />
                    <PriceChange piece={p} />
                    <SpiritChips item={p.item} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <span className="flex items-center gap-1.5"><ColorDot color={p.item.color} hex={p.item.colorHex} /> {p.item.colorName || "—"}</span>
                      <Sizes piece={p} />
                      {!p.item.inStock && <span className="font-medium text-danger">нет в наличии</span>}
                    </div>
                    <WantedSize piece={p} />
                    {client && <Fit client={client} piece={p} />}
                    <InStore piece={p} />
                    <StoreStock piece={p} />
                    <PieceActions piece={p} />
                    {branchCount(p.item.store.contacts) > 0 && (
                      <details className="rounded-lg border border-line px-3 py-2">
                        <summary className="cursor-pointer text-[13px] font-medium">Уточнить наличие в магазине: {branchCount(p.item.store.contacts)} адр.</summary>
                        <p className="help my-2">Назовите артикул{p.item.sku ? ` ${p.item.sku}` : ""} и размер. Письмо по нажатию на почту уже заполнено — останется вписать размер.</p>
                        <StoreContacts contacts={p.item.store.contacts} ask={{ brand: p.item.store.brand, name: p.item.name, sku: p.item.sku, color: p.item.colorName, url: p.item.url }} />
                      </details>
                    )}
                    <div className="mt-2 border-t border-line pt-3">
                      <div className="mb-2 flex flex-wrap items-center gap-3">
                        <span className="text-[13px] font-semibold">Аналоги{analogs.length ? `: ${analogs.length}` : ""}</span>
                        <Link href={catalogFor(p)} className="btn-ghost btn-sm">+ Подобрать аналог</Link>
                      </div>
                      {analogs.length === 0 ? <p className="help">Аналог — похожая вещь на замену: дешевле, из другого магазина или другого цвета.</p> : (
                        <div className="flex flex-col gap-3">
                          {analogs.map((a) => (
                            <div key={a.id} className="flex gap-3">
                              <a href={a.item.url} target="_blank" rel="noreferrer noopener" className="block aspect-[3/4] w-[84px] shrink-0 overflow-hidden rounded-lg bg-ink/5"><ItemPhoto item={a.item} /></a>
                              <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">{a.item.store.brand} · {GEO_LABELS[a.item.store.geo] ?? a.item.store.geo}</div>
                                <div className="text-[14px] leading-snug">{a.item.name}</div>
                                {a.item.sku && <div className="text-[12px] text-muted">Артикул: <span className="select-all font-mono text-ink">{a.item.sku}</span></div>}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                                  <Price item={a.item} />
                                  {a.item.priceEur > 0 && p.item.priceEur > 0 && a.item.priceEur !== p.item.priceEur && (
                                    <span className={a.item.priceEur < p.item.priceEur ? "text-ok" : "text-muted"}>{a.item.priceEur < p.item.priceEur ? "дешевле" : "дороже"} на {diff(a.item.priceEur, p.item.priceEur)}</span>
                                  )}
                                  <span className="flex items-center gap-1.5"><ColorDot color={a.item.color} hex={a.item.colorHex} /> {a.item.colorName}</span>
                                  {!a.item.inStock && <span className="font-medium text-danger">нет в наличии</span>}
                                </div>
                                <SpiritChips item={a.item} />
                                <div className="text-[13px]"><Sizes piece={a} /></div>
                                <PieceActions piece={a} analog />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {new Set(main.map((p) => p.item.currency)).size > 1 && (
        <div className="mt-4"><Alert>В образе вещи с ценами в разных валютах — сумма посчитана в евро по курсу дня, когда собирался каталог.</Alert></div>
      )}

      <Card className="mt-5" title="Название, коллекция и заметка">
        <ActionForm action={saveLook} hidden={{ look: look.id }}>
          <input name="name" defaultValue={look.name} className="input" maxLength={200} />
          <select name="collection" defaultValue={look.collectionId ?? ""} className="input">
            <option value="">Без коллекции</option>
            {collections.map((c) => <option key={c.id} value={c.id}>Коллекция: {c.name}</option>)}
          </select>
          <select name="clientId" defaultValue={look.clientId ?? ""} className="input">
            <option value="">Клиент: {look.collection?.client ? `как у коллекции (${look.collection.client.name})` : "не выбран"}</option>
            {clients.map((c) => <option key={c.id} value={c.id}>Клиент: {c.name}</option>)}
          </select>
          <textarea name="note" defaultValue={look.note ?? ""} rows={3} placeholder="Для кого образ, повод, что учесть" className="input" />
          <SubmitButton>Сохранить</SubmitButton>
        </ActionForm>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <ActionForm action={copyLook} className="" hidden={{ look: look.id }}>
            <SubmitButton className="btn-ghost btn-sm" pendingText="Копирую…">Сделать копию образа</SubmitButton>
          </ActionForm>
          <ActionForm action={deleteLook} className="" hidden={{ look: look.id }}>
            <SubmitButton className="btn-danger btn-sm" confirm="Удалить образ? Вещи в каталоге останутся.">Удалить образ</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
