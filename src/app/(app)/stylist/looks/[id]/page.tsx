import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ColorDot, ItemPhoto, Price, SpiritChips } from "@/components/stylist/ItemCard";
import { activateLook, checkSpirit, deleteLook, lookPieceAction, saveLook } from "@/actions/stylist";
import { BASE_PATH, CATEGORY_LABELS, GEO_LABELS, SEGMENT_LABELS, money, unpack } from "@/lib/stylist/consts";
import { activeLook, canSee, getLook, lookTotals, type LookPiece } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

function Sizes({ piece }: { piece: LookPiece }) {
  const sizes = unpack(piece.item.sizes);
  if (!piece.item.sizesAt) return <span className="text-muted">размеры ещё не загружены</span>;
  return sizes.length ? <span>Размеры в наличии: <b>{sizes.join(" · ")}</b></span> : <span className="text-danger">размеров в наличии нет</span>;
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
      {piece.item.store.adapter === "zara" && (
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
  const [look, active] = await Promise.all([getLook(me, id), activeLook(me)]);
  if (!look) notFound();
  const t = lookTotals(look);
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
        back={{ href: `${BASE_PATH}/looks`, label: "Все образы" }}
        actions={isActive ? <Link href={BASE_PATH} className="btn-primary">Добавить вещи из каталога</Link> : (
          <ActionForm action={activateLook} className="" hidden={{ look: look.id }}><SubmitButton>Собирать этот образ</SubmitButton></ActionForm>
        )}
      />

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
                    <Price item={p.item} />
                    <SpiritChips item={p.item} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <span className="flex items-center gap-1.5"><ColorDot color={p.item.color} hex={p.item.colorHex} /> {p.item.colorName || "—"}</span>
                      <Sizes piece={p} />
                      {!p.item.inStock && <span className="font-medium text-danger">нет в наличии</span>}
                    </div>
                    <PieceActions piece={p} />
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

      <Card className="mt-5" title="Название и заметка">
        <ActionForm action={saveLook} hidden={{ look: look.id }}>
          <input name="name" defaultValue={look.name} className="input" maxLength={200} />
          <textarea name="note" defaultValue={look.note ?? ""} rows={3} placeholder="Для кого образ, повод, что учесть" className="input" />
          <SubmitButton>Сохранить</SubmitButton>
        </ActionForm>
        <div className="mt-4 border-t border-line pt-4">
          <ActionForm action={deleteLook} className="" hidden={{ look: look.id }}>
            <SubmitButton className="btn-danger btn-sm" confirm="Удалить образ? Вещи в каталоге останутся.">Удалить образ</SubmitButton>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
