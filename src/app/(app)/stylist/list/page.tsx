import Link from "next/link";
import QRCode from "qrcode";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Empty, type SearchParams } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ItemPhoto } from "@/components/stylist/ItemCard";
import { PrintButton } from "@/components/stylist/PrintButton";
import { checkStock } from "@/actions/stylist";
import { BASE_PATH, GEO_LABELS, money, unpack, type StoreBranch, type StoreContacts } from "@/lib/stylist/consts";
import { canSee, getLook, listLooks, lookTotals, type LookFull, type LookPiece } from "@/lib/stylist/queries";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const maps = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const round = (n: number) => Math.round(n * 100) / 100;

/** QR-коды ссылок (вещь на сайте магазина, магазин на карте): на бумаге и в PDF ссылку не нажать, а сканировать можно. */
type Qr = Record<string, string>;
async function makeQr(urls: string[]): Promise<Qr> {
  const out: Qr = {};
  await Promise.all([...new Set(urls)].map(async (u) => {
    try {
      out[u] = `data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(u, { type: "svg", margin: 0, errorCorrectionLevel: "L" }))}`;
    } catch {
      /* слишком длинная ссылка — остаётся обычная */
    }
  }));
  return out;
}
function QrImg({ qr, url, size = 54 }: { qr: Qr; url: string; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return qr[url] ? <a href={url} target="_blank" rel="noreferrer noopener" className="block shrink-0 bg-white p-0.5"><img src={qr[url]} alt="QR-код ссылки" width={size} height={size} /></a> : null;
}

/** Есть ли нужный размер: null — размер не выбран или магазин размеры не отдаёт. */
function sizeState(p: LookPiece): { label: string; tone: "ok" | "warn" | "danger" | "muted" } {
  if (!p.item.inStock) return { label: "нет в наличии", tone: "danger" };
  if (!p.size) return { label: "размер не выбран", tone: "muted" };
  if (!p.item.sizesAt) return { label: "наличие размера не проверено", tone: "muted" };
  if (!unpack(p.item.sizes).includes(p.size)) return { label: `размера ${p.size} нет`, tone: "danger" };
  return unpack(p.item.sizesLow).includes(p.size) ? { label: `${p.size} — осталось мало`, tone: "warn" } : { label: `${p.size} — в наличии`, tone: "ok" };
}
const TONE = { ok: "text-ok", warn: "text-warn", danger: "text-danger", muted: "text-muted" };

/**
 * Размерная сетка в выгрузке: выбранный размер — зелёный, остальные в наличии — жёлтые, которых нет — серые зачёркнутые.
 * Выбранный размер, которого нет в наличии, — красный. Магазин сетку не отдаёт — показываем только выбранный.
 */
function SizeRow({ p }: { p: LookPiece }) {
  const have = unpack(p.item.sizes);
  const base = unpack(p.item.sizesAll).length ? unpack(p.item.sizesAll) : have;
  const all = p.size && !base.includes(p.size) ? [...base, p.size] : base;
  if (!all.length) return <b>{p.size || "—"}</b>;
  const known = !!p.item.sizesAt;
  return (
    <span className="flex max-w-[190px] flex-wrap gap-1">
      {all.map((s) => {
        const ok = !known || have.includes(s);
        const chosen = s === p.size;
        const cls = chosen ? (ok ? "bg-[#1f9d55] text-white font-bold" : "bg-[#d1283a] text-white font-bold line-through") : ok ? "bg-[#fde68a] text-[#5b4300]" : "bg-[#e5e7eb] text-[#9aa0aa] line-through";
        return <span key={s} className={`rounded px-1.5 py-0.5 text-[12px] ${cls}`}>{s}</span>;
      })}
    </span>
  );
}

function Row({ p, lookName, qr }: { p: LookPiece; lookName?: string; qr: Qr }) {
  const st = sizeState(p);
  return (
    <tr className="break-inside-avoid border-b border-line align-top">
      <td className="w-[18px] py-2 pr-2"><span className="inline-block h-4 w-4 rounded border border-line-2" /></td>
      <td className="w-[58px] py-2 pr-3"><div className="aspect-[3/4] w-[52px] overflow-hidden rounded bg-ink/5"><ItemPhoto item={p.item} /></div></td>
      <td className="py-2 pr-3">
        <div className="font-medium leading-snug">{p.item.name}</div>
        <div className="text-[12px] text-muted">{p.item.store.brand}{lookName ? ` · ${lookName}` : ""} · {p.item.colorName || "—"}</div>
        <a href={p.item.url} target="_blank" rel="noreferrer noopener" className="break-all text-[11px] text-muted underline">{p.item.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}</a>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-[14px] font-semibold">{p.item.sku || "—"}</td>
      <td className="py-2 pr-3 text-[13px]">
        <SizeRow p={p} />
        <div className={`mt-0.5 text-[12px] ${TONE[st.tone]}`}>{st.label}</div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-semibold">{money(p.item.price, p.item.currency)}</td>
      <td className="w-[58px] py-2"><QrImg qr={qr} url={p.item.url} /></td>
    </tr>
  );
}

function Table({ rows, qr }: { rows: Array<{ p: LookPiece; lookName?: string }>; qr: Qr }) {
  return (
    <table className="w-full text-[14px]">
      <thead>
        <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
          <th className="py-1.5" /><th /><th className="font-semibold">Вещь</th><th className="font-semibold">Артикул</th><th className="font-semibold">Размер</th><th className="pr-3 text-right font-semibold">Цена</th><th className="font-semibold">QR</th>
        </tr>
      </thead>
      <tbody>{rows.map((r) => <Row key={`${r.p.id}`} p={r.p} lookName={r.lookName} qr={qr} />)}</tbody>
    </table>
  );
}

export default async function StylistList({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const q = await searchParams;
  const lookId = typeof q.look === "string" ? q.look : "";
  const colId = typeof q.collection === "string" ? q.collection : "";
  let title = "";
  let note: string | null = null;
  let looks: LookFull[] = [];
  if (lookId) {
    const look = await getLook(me, lookId);
    if (!look) notFound();
    looks = [look];
    title = look.name;
    note = look.note;
  } else if (colId) {
    const col = await prisma.stCollection.findUnique({ where: { id: colId } });
    if (!col) notFound();
    looks = (await listLooks(me)).filter((l) => l.collectionId === col.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    title = col.name;
    note = col.note;
  } else notFound();

  const pieces = looks.flatMap((l) => l.items.filter((p) => !p.parentId).map((p) => ({ p, look: l })));
  const totalEur = round(looks.reduce((s, l) => s + lookTotals(l).eur, 0));
  // По магазинам: одна вещь в нескольких образах покупается один раз на каждый нужный размер.
  const byStore = new Map<string, { brand: string; geo: string; contacts: StoreContacts | null; rows: Array<{ p: LookPiece; lookName: string }> }>();
  for (const { p, look } of pieces) {
    const k = p.item.store.id;
    if (!byStore.has(k)) byStore.set(k, { brand: p.item.store.brand, geo: p.item.store.geo, contacts: (p.item.store.contacts as StoreContacts | null) ?? null, rows: [] });
    const g = byStore.get(k)!;
    const same = g.rows.find((r) => r.p.itemId === p.itemId && r.p.size === p.size);
    if (same) same.lookName = `${same.lookName}, ${look.name}`;
    else g.rows.push({ p, lookName: look.name });
  }
  const stores = [...byStore.values()].sort((a, b) => a.brand.localeCompare(b.brand));
  const uniqueEur = round(stores.reduce((s, g) => s + g.rows.reduce((x, r) => x + r.p.item.priceEur, 0), 0));
  const problems = pieces.filter(({ p }) => sizeState(p).tone === "danger").length;
  const noSize = pieces.filter(({ p }) => !p.size).length;
  const checked = pieces.map(({ p }) => p.item.sizesAt ?? p.item.lastSeenAt).sort((a, b) => a.getTime() - b.getTime())[0];
  const mapUrl = (brand: string, b: StoreBranch) => maps(`${brand} ${b.name ?? ""} ${b.address ?? ""} Malta`);
  const qr = await makeQr([
    ...pieces.map(({ p }) => p.item.url),
    ...stores.flatMap((g) => (g.contacts?.branches ?? []).filter((b) => b && (b.name || b.address)).map((b) => mapUrl(g.brand, b))),
  ]);
  const back = lookId ? `${BASE_PATH}/looks/${lookId}` : `${BASE_PATH}/looks`;

  return (
    <>
      <style>{`* { -webkit-print-color-adjust: exact; print-color-adjust: exact; } @media print { .view-header, .no-print { display: none !important; } body { background: #fff !important; } .sheet { border: 0 !important; box-shadow: none !important; padding: 0 !important; max-width: none !important; } a { text-decoration: none !important; } }`}</style>
      <div className="no-print"><StNav /></div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={back} className="btn-ghost">← Назад</Link>
        <PrintButton />
        <ActionForm action={checkStock} className="flex flex-wrap items-center gap-2" hidden={lookId ? { look: lookId } : { collection: colId }}>
          <SubmitButton className="btn-ghost" pendingText="Проверяю наличие… до минуты">Проверить наличие сейчас</SubmitButton>
        </ActionForm>
      </div>

      <div className="sheet mx-auto max-w-[900px] rounded-2xl border border-line bg-surface p-5 sm:p-8">
        <div className="mb-5 border-b border-line pb-4">
          <div className="text-[12px] uppercase tracking-wide text-muted">Шопинг-лист{colId ? " · коллекция" : " · образ"}</div>
          <h1 className="h1">{title}</h1>
          {note && <p className="mt-1 text-[14px] text-ink-2">{note}</p>}
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[14px]">
            <span>Образов: <b>{looks.length}</b></span>
            <span>Вещей: <b>{pieces.length}</b></span>
            <span>Итого по образам: <b>{money(totalEur, "EUR")}</b></span>
            {uniqueEur !== totalEur && <span>К покупке (без повторов): <b>{money(uniqueEur, "EUR")}</b></span>}
            {checked && <span className="text-muted">наличие на {fmtDate(checked)}</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
            <span>Размеры:</span>
            <span className="rounded bg-[#1f9d55] px-1.5 py-0.5 font-bold text-white">M</span> нужный
            <span className="rounded bg-[#fde68a] px-1.5 py-0.5 text-[#5b4300]">L</span> есть в наличии
            <span className="rounded bg-[#e5e7eb] px-1.5 py-0.5 text-[#9aa0aa] line-through">XL</span> нет
            <span className="rounded bg-[#d1283a] px-1.5 py-0.5 font-bold text-white line-through">S</span> нужного нет
          </div>
          {(problems > 0 || noSize > 0) && (
            <div className="mt-2 text-[13px]">
              {problems > 0 && <span className="mr-4 font-medium text-danger">Нет в наличии или нет нужного размера: {problems}</span>}
              {noSize > 0 && <span className="text-muted">Размер не выбран у {noSize} вещ. — выберите его на странице образа</span>}
            </div>
          )}
        </div>

        {pieces.length === 0 ? <p className="help">В образах пока нет вещей.</p> : (
          <>
            <h2 className="h2 mb-2">1. По образам</h2>
            {looks.map((l) => {
              const t = lookTotals(l);
              const main = l.items.filter((p) => !p.parentId);
              if (!main.length) return null;
              return (
                <section key={l.id} className="mb-6 break-inside-avoid-page">
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-1">
                    <h3 className="text-[16px] font-bold">{l.name}</h3>
                    <span className="text-[14px]">{t.pieces} вещ. · <b>{t.native ? `${money(t.native.sum, t.native.currency)} ≈ ` : ""}{money(t.eur, "EUR")}</b></span>
                  </div>
                  {l.note && <p className="mb-1 text-[13px] text-ink-2">{l.note}</p>}
                  <Table rows={main.map((p) => ({ p }))} qr={qr} />
                  {main.some((p) => l.items.some((a) => a.parentId === p.id)) && (
                    <div className="mt-2 text-[12px] text-muted">
                      Аналоги на замену: {main.flatMap((p) => l.items.filter((a) => a.parentId === p.id).map((a) => `${a.item.store.brand} «${a.item.name}»${a.item.sku ? ` арт. ${a.item.sku}` : ""} ${money(a.item.price, a.item.currency)} (вместо «${p.item.name}»)`)).join("; ")}
                    </div>
                  )}
                </section>
              );
            })}

            <h2 className="h2 mb-2 mt-8 break-before-page">2. По магазинам</h2>
            {stores.map((g) => {
              const branches: StoreBranch[] = (g.contacts?.branches ?? []).filter((b) => b && (b.name || b.address));
              return (
                <section key={g.brand + g.geo} className="mb-6 break-inside-avoid-page">
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-1">
                    <h3 className="text-[16px] font-bold">{g.brand} <span className="text-[13px] font-normal text-muted">{GEO_LABELS[g.geo] ?? g.geo}</span></h3>
                    <span className="text-[14px]">{g.rows.length} вещ. · <b>{money(round(g.rows.reduce((s, r) => s + r.p.item.priceEur, 0)), "EUR")}</b></span>
                  </div>
                  <Table rows={g.rows} qr={qr} />
                  <div className="mt-2 text-[12.5px]">
                    <span className="font-semibold">Артикулы для продавца:</span> {g.rows.map((r) => `${r.p.item.sku || r.p.item.name}${r.p.size ? ` (${r.p.size})` : ""}`).join(" · ")}
                  </div>
                  {branches.length > 0 && <div className="mt-3 text-[12.5px] font-semibold">Магазины {g.brand} на острове — наличие в конкретном магазине уточняйте по телефону, называя артикул и размер:</div>}
                  {branches.length > 0 ? (
                    <ul className="mt-2 grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
                      {branches.map((b, i) => (
                        <li key={i} className="flex break-inside-avoid gap-2.5">
                          <QrImg qr={qr} url={mapUrl(g.brand, b)} size={60} />
                          <div className="min-w-0">
                            <a href={mapUrl(g.brand, b)} target="_blank" rel="noreferrer noopener" className="font-semibold underline">📍 {b.name || b.address}</a>
                            {b.name && b.address && <div>{b.address}</div>}
                            {(b.phone || b.email) && <div>{[b.phone, b.email].filter(Boolean).join(" · ")}</div>}
                            {b.hours && <div className="text-muted">{b.hours}</div>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-2 text-[12.5px] text-muted"><a href={maps(`${g.brand} ${GEO_LABELS[g.geo] === "Мальта" ? "Malta" : "Ukraine"}`)} target="_blank" rel="noreferrer noopener" className="underline">📍 Найти магазины {g.brand} на карте</a></div>
                  )}
                </section>
              );
            })}
            <p className="mt-6 text-[11.5px] text-muted">Цены и наличие — по данным интернет-магазинов на указанное время; наличие в конкретном магазине уточняйте по телефону или почте, называя артикул и размер. QR-код у вещи ведёт на её страницу в магазине, QR-код у адреса и ссылка «📍» — на Google Maps.</p>
          </>
        )}
      </div>
    </>
  );
}
