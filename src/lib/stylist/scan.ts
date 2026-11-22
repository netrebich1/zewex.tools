/**
 * «Стилист»: сбор каталога магазина. Адаптер отдаёт вещи в общем виде, здесь — тип/цвет/теги, цена в евро и запись в базу.
 * Вещь, которой нет в свежем сборе, не удаляется (она может стоять в образе), а помечается «нет в наличии».
 */
import type { Prisma, StStore } from "@prisma/client";
import { prisma } from "@/lib/db";
import { rateToEur } from "@/lib/finance/rates";
import { todayYmd } from "@/lib/tasks/consts";
import { pack, type RawItem } from "./consts";
import { classifyCategory, classifyColor, classifyTags } from "./classify";
import { mergeSpirits, ruleSpirit } from "./dna";
import { shopGet } from "./net";
import { scanZara, zaraSizes, type ZaraConfig } from "./adapters/zara";
import { scanParfois, type ParfoisConfig } from "./adapters/parfois";
import { fetchItxProduct, fetchItxStores, scanItx, type ItxConfig } from "./adapters/itx";

/** Автообновление магазина — раз в сутки. */
export const SCAN_EVERY_MS = 24 * 3600_000;
/** Сбор, который молчит дольше, считается оборванным. */
const STALE_MS = 45 * 60_000;

export const ADAPTERS: Record<string, { label: string; auto: boolean }> = {
  zara: { label: "Zara — каталог сайта", auto: true },
  itx: { label: "Inditex — каталог сайта", auto: true },
  parfois: { label: "Parfois — каталог сайта", auto: true },
  manual: { label: "Вручную и по ссылке", auto: false },
};

/** Скидка в процентах от старой цены. */
export const discountOf = (price: number, oldPrice?: number | null) => (oldPrice && oldPrice > price && price > 0 ? Math.round((1 - price / oldPrice) * 100) : 0);

export async function eurRate(currency: string): Promise<number> {
  if (currency === "EUR") return 1;
  return (await rateToEur(currency, todayYmd()).catch(() => null))?.rate ?? 0;
}

async function collect(store: StStore, onProgress: (d: number, t: number) => void): Promise<RawItem[]> {
  const cfg = (store.config ?? {}) as Record<string, string>;
  if (store.adapter === "zara") {
    return scanZara((url) => shopGet(url, { proxy: true, accept: "application/json" }), cfg as ZaraConfig, onProgress);
  }
  if (store.adapter === "itx") {
    // Заодно обновляем адреса, телефоны и часы магазинов бренда — официальный список с сайта.
    const contacts = await fetchItxStores((url) => shopGet(url, { proxy: true, accept: "application/json" }), cfg as unknown as ItxConfig, store.geo);
    if (contacts) await prisma.stStore.update({ where: { id: store.id }, data: { contacts: contacts as unknown as Prisma.InputJsonValue } }).catch(() => {});
    return scanItx((url) => shopGet(url, { proxy: true, accept: "application/json" }), cfg as unknown as ItxConfig, onProgress);
  }
  if (store.adapter === "parfois") {
    return scanParfois((url) => shopGet(url, { accept: "text/html,*/*;q=0.8" }), cfg as ParfoisConfig, onProgress);
  }
  throw new Error(`У магазина «${store.name}» нет автоматического сбора`);
}

/** Берёт магазин в работу: нажата «Обновить сейчас» или прошли сутки. Захват — одним UPDATE, чтобы два воркера не взяли один магазин. */
export async function claimStore(workerId: string): Promise<StStore | null> {
  const due = new Date(Date.now() - SCAN_EVERY_MS);
  const rows = await prisma.stStore.findMany({
    where: {
      adapter: { in: Object.entries(ADAPTERS).filter(([, a]) => a.auto).map(([k]) => k) },
      scanStatus: { not: "running" },
      OR: [{ scanAsked: { not: null } }, { isActive: true, OR: [{ lastScanAt: null }, { lastScanAt: { lt: due } }] }],
    },
    orderBy: [{ scanAsked: "desc" }, { lastScanAt: "asc" }],
    take: 5,
  });
  // Неудачный сбор не повторяем чаще раза в час — магазин мог закрыться от нас на время.
  const row = rows.find((r) => r.scanAsked || r.scanStatus !== "error" || !r.scanStartedAt || Date.now() - r.scanStartedAt.getTime() > 3600_000);
  if (!row) return null;
  const got = await prisma.stStore.updateMany({ where: { id: row.id, scanStatus: { not: "running" } }, data: { scanStatus: "running", scanStartedAt: new Date(), scanAsked: null, lockedBy: workerId, scanNote: "Собираю каталог…" } });
  return got.count ? prisma.stStore.findUnique({ where: { id: row.id } }) : null;
}

export async function requeueStale(hostPrefix: string): Promise<number> {
  const r = await prisma.stStore.updateMany({
    where: { scanStatus: "running", OR: [{ lockedBy: { startsWith: `${hostPrefix}-` } }, { scanStartedAt: { lt: new Date(Date.now() - STALE_MS) } }] },
    data: { scanStatus: "idle", lockedBy: null, scanAsked: new Date(), scanNote: "Сбор был прерван — запущен заново" },
  });
  return r.count;
}

export async function scanStore(store: StStore): Promise<{ total: number; fresh: number; gone: number }> {
  const startedAt = new Date();
  try {
    let lastNote = 0;
    const raw = await collect(store, (d, t) => {
      if (Date.now() - lastNote < 10_000) return;
      lastNote = Date.now();
      void prisma.stStore.update({ where: { id: store.id }, data: { scanNote: `Собираю каталог: ${d} из ${t}` } }).catch(() => {});
    });
    if (!raw.length) throw new Error("магазин не отдал ни одной вещи");
    const rate = await eurRate(store.currency);
    const known = new Map((await prisma.stItem.findMany({ where: { storeId: store.id }, select: { id: true, extId: true, spiritAt: true, spiritData: true } })).map((r) => [r.extId, r]));
    let fresh = 0;
    const fields = (it: RawItem) => {
      const category = classifyCategory(it.name, it.rawCategory);
      const color = classifyColor(it.colorName ?? "", it.colorHex ?? "");
      const old = known.get(it.extId);
      return {
      ...mergeSpirits(ruleSpirit(it.name, category, color), old?.spiritData, !!old?.spiritAt),
      name: it.name.slice(0, 300),
      sku: (it.sku ?? "").slice(0, 60),
      season: (it.season ?? "").slice(0, 12),
      composition: (it.composition ?? "").slice(0, 500),
      ...(it.description ? { description: it.description.slice(0, 3000) } : {}),
      madeIn: (it.madeIn ?? "").slice(0, 60),
      ...(it.storeDate ? { storeDate: it.storeDate } : {}),
      url: it.url.slice(0, 700),
      imageUrl: it.imageUrl.slice(0, 700),
      images: (it.images ?? []).filter((u) => u.length <= 700) as Prisma.InputJsonValue,
      price: it.price,
      oldPrice: it.oldPrice && it.oldPrice > it.price ? it.oldPrice : null,
      discount: discountOf(it.price, it.oldPrice),
      currency: store.currency,
      priceEur: Math.round(it.price * rate * 100) / 100,
      gender: it.gender,
      category,
      rawCategory: it.rawCategory.slice(0, 200),
      colorName: (it.colorName ?? "").slice(0, 80),
      color,
      colorHex: (it.colorHex ?? "").slice(0, 8),
      tags: pack(classifyTags(it.name)).slice(0, 400),
      inStock: it.inStock !== false,
      lastSeenAt: startedAt,
      ...(it.sizes ? { sizesCount: new Set(it.sizes).size, sizes: pack(it.sizes).slice(0, 400), sizesAt: startedAt, sizesAll: pack(it.sizesAll ?? it.sizes).slice(0, 400), sizesLow: pack(it.sizesLow ?? []).slice(0, 400) } : {}),
      };
    };
    for (let i = 0; i < raw.length; i += 50) {
      await prisma.$transaction(raw.slice(i, i + 50).map((it) => {
        const id = known.get(it.extId)?.id;
        if (!id) fresh++;
        return id ? prisma.stItem.update({ where: { id }, data: fields(it) }) : prisma.stItem.create({ data: { storeId: store.id, extId: it.extId.slice(0, 120), source: "scan", ...fields(it) } });
      }));
    }
    // Пропала из каталога — «нет в наличии». Если сбор принёс подозрительно мало (меньше половины прошлого), не трогаем: вероятно, сайт отдал не всё.
    let gone = 0;
    const before = await prisma.stItem.count({ where: { storeId: store.id, source: "scan", inStock: true, lastSeenAt: { lt: startedAt } } });
    if (raw.length >= (before + raw.length) / 2 || before < 50) {
      gone = (await prisma.stItem.updateMany({ where: { storeId: store.id, source: "scan", inStock: true, lastSeenAt: { lt: startedAt } }, data: { inStock: false } })).count;
    }
    const itemCount = await prisma.stItem.count({ where: { storeId: store.id, inStock: true } });
    await prisma.stStore.update({ where: { id: store.id }, data: { scanStatus: "ok", lastScanAt: new Date(), lockedBy: null, itemCount, scanNote: `В наличии ${itemCount}: новых ${fresh}, пропало ${gone}` } });
    return { total: raw.length, fresh, gone };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.stStore.update({ where: { id: store.id }, data: { scanStatus: "error", lockedBy: null, scanNote: `Сбор не удался: ${msg}`.slice(0, 1000) } }).catch(() => {});
    throw e;
  }
}

/** Размеры в наличии для одной вещи (карточка товара магазина). Не чаще раза в 6 часов; false — магазин размеры не отдаёт. */
export async function refreshSizes(itemId: string, force = false): Promise<boolean> {
  const item = await prisma.stItem.findUnique({ where: { id: itemId }, include: { store: true } });
  if (!item || item.source !== "scan" || !["zara", "itx"].includes(item.store.adapter)) return false;
  if (!force && item.sizesAt && Date.now() - item.sizesAt.getTime() < 6 * 3600_000) return true;
  if (item.store.adapter === "itx") {
    const fresh = (await fetchItxProduct((url) => shopGet(url, { proxy: true, accept: "application/json" }), item.store.config as unknown as ItxConfig, item.extId.split("-")[0])).find((x) => x.extId === item.extId);
    if (!fresh) return false;
    const old = fresh.oldPrice && fresh.oldPrice > fresh.price ? fresh.oldPrice : null;
    await prisma.stItem.update({ where: { id: item.id }, data: { sizes: pack(fresh.sizes ?? []).slice(0, 400), sizesCount: new Set(fresh.sizes ?? []).size, sizesAll: pack(fresh.sizesAll ?? []).slice(0, 400), sizesLow: pack(fresh.sizesLow ?? []).slice(0, 400), sizesAt: new Date(), inStock: fresh.inStock !== false, price: fresh.price, oldPrice: old, discount: discountOf(fresh.price, old), priceEur: Math.round(fresh.price * (await eurRate(item.currency)) * 100) / 100, ...(fresh.sku ? { sku: fresh.sku.slice(0, 60) } : {}) } });
    return true;
  }
  const json = await shopGet(`${item.url}${item.url.includes("?") ? "&" : "?"}ajax=true`, { proxy: true, accept: "application/json" });
  const got = zaraSizes(json, item.extId);
  if (!got) return false;
  await prisma.stItem.update({ where: { id: item.id }, data: { sizes: pack(got.sizes).slice(0, 400), sizesCount: got.sizes.length, sizesAll: pack(got.all).slice(0, 400), sizesLow: pack(got.low).slice(0, 400), sizesAt: new Date(), inStock: got.inStock, ...(got.price ? { price: got.price, oldPrice: got.oldPrice, discount: discountOf(got.price, got.oldPrice), priceEur: Math.round(got.price * (await eurRate(item.currency)) * 100) / 100 } : {}) } });
  return true;
}
