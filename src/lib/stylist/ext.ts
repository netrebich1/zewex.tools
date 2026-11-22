/**
 * «Стилист»: приём данных от расширения Chrome «Zewex Стилист» (папка `extension/stylist`).
 * Расширение работает в браузере стилиста на страницах магазинов: читает то, что она сама открыла
 * (название, цена, артикул, размеры, результат проверки «есть ли в магазинах»), и шлёт сюда.
 * Вход — токен расширения (Authorization: Bearer zxs_…), сессия портала не нужна.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { pack } from "./consts";
import { classifyCategory, classifyColor, classifyTags } from "./classify";
import { discountOf, eurRate } from "./scan";
import { TEAM_SLUG } from "./consts";

export const EXT_DIR = join(process.cwd(), "extension", "stylist");

let version: string | null = null;
export async function extVersion(): Promise<string> {
  if (version) return version;
  try {
    version = (JSON.parse(await readFile(join(EXT_DIR, "manifest.json"), "utf8")) as { version?: string }).version || "0";
  } catch {
    version = "0";
  }
  return version;
}

export class ExtError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Новый токен: показывается один раз, в базе — только sha256. Прежние токены этого человека отзываются. */
export async function issueToken(userId: string): Promise<string> {
  const token = `zxs_${randomBytes(24).toString("base64url")}`;
  await prisma.$transaction([
    prisma.stExtToken.deleteMany({ where: { userId } }),
    prisma.stExtToken.create({ data: { userId, tokenHash: hash(token), hint: token.slice(0, 9) } }),
  ]);
  return token;
}

export type ExtCtx = { userId: string; userName: string; teamId: string | null };

export async function authExt(req: Request): Promise<ExtCtx> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new ExtError("Нет токена. Вставьте токен со страницы «Расширение» в окно расширения.", 401);
  const row = await prisma.stExtToken.findUnique({ where: { tokenHash: hash(m[1]) } });
  if (!row) throw new ExtError("Токен не найден или заменён новым. Выдайте токен заново на странице «Расширение».", 401);
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, name: true, role: true, isActive: true, memberships: { select: { team: { select: { slug: true } } } } } });
  if (!user?.isActive) throw new ExtError("Пользователь отключён.", 403);
  const team = await prisma.team.findUnique({ where: { slug: TEAM_SLUG }, select: { id: true } });
  if (user.role !== "ADMIN" && !user.memberships.some((t) => t.team.slug === TEAM_SLUG)) throw new ExtError("«Стилист» открыт команде Zewex.", 403);
  void prisma.stExtToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: user.id, userName: user.name, teamId: team?.id ?? null };
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^(www2?|shop|m)\./, "").toLowerCase();
  } catch {
    return "";
  }
};
/** Страна по адресу страницы: код в пути («/mt/en/», «/it/», «en_mt», «uk_ua») или домен страны; не нашли — Мальта. */
function geoOf(url: string): string {
  const u = new URL(url);
  const tld = u.hostname.split(".").pop() ?? "";
  const inPath = /^\/(?:[a-z]{2}[_-])?([a-z]{2})(?:[\/_-]|$)/i.exec(u.pathname)?.[1] ?? "";
  const lang = new Set(["en", "uk", "ru", "es", "fr", "de"]);
  const code = /^(ua|mt|it|pl|de|fr|es|gb)$/i.test(tld) ? tld : inPath && !lang.has(inPath.toLowerCase()) ? inPath : /uk_ua|\/ua\//i.test(url) ? "ua" : "mt";
  return code.toUpperCase().slice(0, 4);
}

/** Магазин страницы: по домену и стране в адресе; незнакомый домен — новый магазин «по ссылке». */
async function storeFor(url: string, brandHint: string) {
  const h = host(url);
  if (!h) throw new ExtError("Не удалось понять адрес страницы");
  const geo = geoOf(url);
  const all = await prisma.stStore.findMany({ where: { baseUrl: { contains: h.split(".").slice(-2).join(".") } } });
  const same = all.filter((s) => host(s.baseUrl) === h || host(s.baseUrl).endsWith(h) || h.endsWith(host(s.baseUrl)));
  // На одном домене бывает несколько брендов (hudsonstore.com, retail.com.mt): тогда берём по названию бренда со страницы.
  const byBrand = brandHint ? same.find((s) => s.brand.toLowerCase() === brandHint.toLowerCase()) : undefined;
  const found = byBrand ?? same.find((s) => s.geo === geo) ?? same[0];
  if (found) return found;
  const name = brandHint || h.split(".")[0].replace(/^\w/, (c) => c.toUpperCase());
  const slug = `${h.replace(/[^a-z0-9]+/g, "-")}-${geo.toLowerCase()}`.slice(0, 60);
  return prisma.stStore.upsert({ where: { slug }, update: {}, create: { slug, name, brand: name, segment: "mid", geo, adapter: "manual", baseUrl: `https://${h}/`, currency: geo === "UA" ? "UAH" : "EUR", isActive: false } });
}

/** Вещь уже есть в каталоге (магазин собирается сам)? Ищем по номеру товара из адреса страницы. */
async function findScanned(storeId: string, url: string, colorName: string) {
  const u = new URL(url);
  const pid = u.searchParams.get("v1") ?? u.searchParams.get("pelement");
  if (!pid) return null;
  const color = u.searchParams.get("colorId");
  const rows = await prisma.stItem.findMany({ where: { storeId, extId: color ? `${pid}-${color}` : { startsWith: `${pid}-` } }, take: 20 });
  return rows.find((r) => colorName && r.colorName.toLowerCase() === colorName.toLowerCase()) ?? rows[0] ?? null;
}

export type ExtProduct = { url: string; name?: string; brand?: string; price?: number; oldPrice?: number; currency?: string; image?: string; images?: string[]; color?: string; sku?: string; sizes?: string[]; sizesAll?: string[]; description?: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim().toUpperCase()).filter((x) => x && x.length <= 12))].slice(0, 40) : []);

/** Вещь со страницы магазина — в каталог (или обновить ту, что уже есть). Возвращает id вещи. */
export async function upsertFromPage(p: ExtProduct): Promise<{ id: string; name: string; store: string; created: boolean }> {
  const url = str(p.url, 700);
  if (!/^https?:\/\//i.test(url)) throw new ExtError("Нет адреса страницы");
  const store = await storeFor(url, str(p.brand, 60));
  const colorName = str(p.color, 80);
  const sizes = list(p.sizes);
  const sizesAll = list(p.sizesAll).length ? list(p.sizesAll) : sizes;
  const scanned = store.adapter !== "manual" ? await findScanned(store.id, url, colorName).catch(() => null) : null;
  const price = Number(p.price) > 0 ? Number(p.price) : 0;
  const old = Number(p.oldPrice) > price ? Number(p.oldPrice) : null;
  const priceOk = price > 0 && (!p.currency || str(p.currency, 4).toUpperCase() === store.currency);
  const fresh = {
    ...(priceOk ? { price, oldPrice: old, discount: discountOf(price, old), priceEur: Math.round(price * (await eurRate(store.currency)) * 100) / 100 } : {}),
    ...(sizesAll.length ? { sizes: pack(sizes).slice(0, 400), sizesAll: pack(sizesAll).slice(0, 400), sizesCount: sizes.length, sizesAt: new Date(), inStock: sizes.length > 0 } : {}),
    ...(str(p.sku, 60) ? { sku: str(p.sku, 60) } : {}),
    lastSeenAt: new Date(),
  };
  if (scanned) {
    await prisma.stItem.update({ where: { id: scanned.id }, data: fresh });
    return { id: scanned.id, name: scanned.name, store: store.name, created: false };
  }
  const name = str(p.name, 300);
  const imageUrl = str(p.image, 700);
  if (!name || !/^https?:\/\//i.test(imageUrl)) throw new ExtError("На странице не нашлось названия или фото вещи — откройте страницу самой вещи, а не списка");
  if (!priceOk) throw new ExtError(`На странице не нашлось цены в ${store.currency} — добавьте вещь вручную на вкладке «Добавить вещь»`);
  const category = classifyCategory(name, "");
  const extId = `m-${Buffer.from(url.split("#")[0]).toString("base64url").slice(-100)}`;
  const data = {
    name, url, imageUrl, images: (Array.isArray(p.images) ? p.images.filter((u) => typeof u === "string" && /^https?:\/\//.test(u) && u.length <= 700).slice(0, 3) : []) as Prisma.InputJsonValue,
    currency: store.currency, gender: "woman", category, rawCategory: "", colorName, color: classifyColor(colorName || name), colorHex: "",
    tags: pack(classifyTags(name)), source: "manual", description: str(p.description, 3000) || null, price, priceEur: 0, ...fresh,
  };
  const item = await prisma.stItem.upsert({ where: { storeId_extId: { storeId: store.id, extId } }, update: data, create: { storeId: store.id, extId, ...data } });
  await prisma.stStore.update({ where: { id: store.id }, data: { itemCount: await prisma.stItem.count({ where: { storeId: store.id, inStock: true } }) } });
  return { id: item.id, name, store: store.name, created: true };
}

/** Список «коллекция → образы» для окна расширения. */
export async function looksFor(ctx: ExtCtx): Promise<Array<{ id: string; name: string; collection: string }>> {
  const rows = await prisma.stLook.findMany({ where: ctx.teamId ? { teamId: ctx.teamId } : {}, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, name: true, collection: { select: { name: true } } } });
  return rows.map((r) => ({ id: r.id, name: r.name, collection: r.collection?.name ?? "" }));
}

/**
 * Действие расширения с вещью страницы: add — в каталог; fav — ещё и в избранное; look — ещё и в образ;
 * instore — результат проверки «есть ли в магазинах» со страницы магазина (sizes — какие размеры проверяли, stores — где есть).
 */
export async function handleItem(ctx: ExtCtx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const to = str(body.to, 10) || "add";
  const item = await upsertFromPage((body.product ?? {}) as ExtProduct);
  const out: Record<string, unknown> = { ok: true, itemId: item.id, message: `${item.created ? "Добавлено в каталог" : "Обновлено в каталоге"}: ${item.store}` };
  if (to === "fav") {
    await prisma.stFav.upsert({ where: { itemId: item.id }, update: {}, create: { itemId: item.id, createdById: ctx.userId } });
    out.message = "В избранном";
  }
  if (to === "look") {
    const look = await prisma.stLook.findFirst({ where: { id: str(body.lookId, 40), ...(ctx.teamId ? { teamId: ctx.teamId } : {}) }, include: { items: { select: { itemId: true, parentId: true } } } });
    if (!look) throw new ExtError("Образ не найден — обновите список образов");
    if (!look.items.some((x) => !x.parentId && x.itemId === item.id)) {
      const row = await prisma.stItem.findUnique({ where: { id: item.id }, select: { price: true } });
      await prisma.stLookItem.create({ data: { lookId: look.id, itemId: item.id, order: look.items.length, addedPrice: row?.price ?? null, size: str(body.size, 20).toUpperCase() } });
      await prisma.stLook.update({ where: { id: look.id }, data: { updatedAt: new Date() } });
    }
    out.message = `В образе «${look.name}»`;
  }
  if (to === "instore") {
    const stores = Array.isArray(body.stores) ? body.stores.map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 160)).filter(Boolean).slice(0, 20) : [];
    const sizes = list(body.sizes);
    const city = str(body.city, 80);
    const stock = { at: new Date().toISOString(), city, sizes, stores, none: stores.length === 0 };
    await prisma.stItem.update({ where: { id: item.id }, data: { storeStock: stock as unknown as Prisma.InputJsonValue } });
    // Отметка «в магазине на острове» у вещи в образах: если проверяли нужный размер этой вещи (или размер не выбран).
    const pieces = await prisma.stLookItem.findMany({ where: { itemId: item.id }, select: { id: true, size: true } });
    const hit = pieces.filter((x) => !x.size || !sizes.length || sizes.includes(x.size.toUpperCase())).map((x) => x.id);
    if (hit.length) await prisma.stLookItem.updateMany({ where: { id: { in: hit } }, data: { inStore: stores.length ? "yes" : "no", inStoreAt: new Date() } });
    out.message = stores.length ? `Записано${city ? ` (${city})` : ""}: есть в магазинах (${stores.length})${sizes.length ? `, размеры ${sizes.join(", ")}` : ""}` : `Записано${city ? ` (${city})` : ""}: в магазинах поблизости нет${sizes.length ? ` (размеры ${sizes.join(", ")})` : ""}`;
  }
  return out;
}
