"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { BASE_PATH, CATEGORIES, COLORS, GENDERS, GEOS, SEGMENTS, pack } from "@/lib/stylist/consts";
import { classifyCategory, classifyColor, classifyTags } from "@/lib/stylist/classify";
import { parseProductPage } from "@/lib/stylist/adapters/link";
import { BlockedError, shopGet } from "@/lib/stylist/net";
import { ADAPTERS, eurRate, refreshSizes } from "@/lib/stylist/scan";
import { LOOK_COOKIE, assertSee, getLook, teamId } from "@/lib/stylist/queries";
import { BRAND_NAMES, aiSpirit } from "@/lib/stylist/dna";

export type FormState = { error?: string; ok?: string; link?: { href: string; label: string } };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const has = (list: readonly { id: string }[], v: string) => list.some((x) => x.id === v);

async function setActive(id: string) {
  (await cookies()).set(LOOK_COOKIE, id, { path: "/", maxAge: 60 * 60 * 24 * 90, sameSite: "lax", httpOnly: true });
}

/* ---------- Образы ---------- */

export async function createLook(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let id: string;
  try {
    await assertSee(me);
    const col = str(f, "collection") ? await prisma.stCollection.findUnique({ where: { id: str(f, "collection") }, select: { id: true } }) : null;
    const look = await prisma.stLook.create({ data: { name: str(f, "name").slice(0, 200) || `Образ от ${new Date().toLocaleDateString("ru-RU")}`, teamId: await teamId(), createdById: me.id, collectionId: col?.id ?? null } });
    await setActive(look.id);
    id = look.id;
  } catch (e) {
    return fail(e);
  }
  redirect(`${BASE_PATH}/looks/${id}`);
}

export async function saveLook(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const look = await getLook(me, str(f, "look"));
    if (!look) throw new Error("Образ не найден");
    const name = str(f, "name").slice(0, 200);
    if (!name) throw new Error("Дайте образу название");
    const col = str(f, "collection") ? await prisma.stCollection.findUnique({ where: { id: str(f, "collection") }, select: { id: true } }) : null;
    await prisma.stLook.update({ where: { id: look.id }, data: { name, note: str(f, "note").slice(0, 5000) || null, collectionId: col?.id ?? null } });
    revalidatePath(BASE_PATH, "layout");
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteLook(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const look = await getLook(me, str(f, "look"));
    if (!look) throw new Error("Образ не найден");
    await prisma.stLook.delete({ where: { id: look.id } });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(BASE_PATH, "layout");
  redirect(`${BASE_PATH}/looks`);
}

/** «Собирать этот образ»: вещи из каталога пойдут в него. */
export async function activateLook(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const look = await getLook(me, str(f, "look"));
    if (!look) throw new Error("Образ не найден");
    await setActive(look.id);
  } catch (e) {
    return fail(e);
  }
  redirect(`${BASE_PATH}`);
}

/**
 * Вещь из каталога — в образ. Без `analog` — основной вещью в образ `look` (или в собираемый; нет его — создаётся новый).
 * С `analog` (id основной вещи образа) — аналогом к ней. Вызывается кнопкой карточки, поэтому возвращает итог, а не редирект.
 */
export async function addToLook(itemId: string, opts: { analog?: string; look?: string; fresh?: boolean } = {}): Promise<{ ok?: string; error?: string; lookId?: string }> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const item = await prisma.stItem.findUnique({ where: { id: itemId }, select: { id: true } });
    if (!item) throw new Error("Вещь не найдена");
    if (opts.analog) {
      const parent = await prisma.stLookItem.findUnique({ where: { id: opts.analog }, select: { id: true, lookId: true, parentId: true, itemId: true } });
      const look = parent && !parent.parentId ? await getLook(me, parent.lookId) : null;
      if (!parent || !look) throw new Error("Основная вещь образа не найдена");
      if (parent.itemId === itemId || look.items.some((p) => p.parentId === parent.id && p.itemId === itemId)) return { ok: "Уже добавлено", lookId: look.id };
      await prisma.stLookItem.create({ data: { lookId: look.id, itemId, parentId: parent.id, order: look.items.length } });
      await prisma.stLook.update({ where: { id: look.id }, data: { updatedAt: new Date() } });
      void refreshSizes(itemId).catch(() => {});
      revalidatePath(BASE_PATH, "layout");
      return { ok: "Добавлено как аналог", lookId: look.id };
    }
    const cookieId = (await cookies()).get(LOOK_COOKIE)?.value;
    // fresh — новый образ; look — выбранный в списке (собираемый образ при этом не меняется); иначе — собираемый.
    let look = opts.fresh ? null : ((opts.look ? await getLook(me, opts.look) : null) ?? (cookieId ? await getLook(me, cookieId) : null));
    const picked = !!opts.look && look?.id === opts.look && look.id !== cookieId;
    if (!look) {
      const made = await prisma.stLook.create({ data: { name: `Образ от ${new Date().toLocaleDateString("ru-RU")}`, teamId: await teamId(), createdById: me.id } });
      look = await getLook(me, made.id);
      if (!look) throw new Error("Не удалось создать образ");
    }
    if (!picked) await setActive(look.id);
    if (look.items.some((p) => !p.parentId && p.itemId === itemId)) return { ok: "Уже в образе", lookId: look.id };
    await prisma.stLookItem.create({ data: { lookId: look.id, itemId, order: look.items.length } });
    await prisma.stLook.update({ where: { id: look.id }, data: { updatedAt: new Date() } });
    // Размеры в наличии подтягиваем в фоне: в списке каталога магазин их не отдаёт.
    void refreshSizes(itemId).catch(() => {});
    revalidatePath(BASE_PATH, "layout");
    return { ok: `В образе «${look.name}»`, lookId: look.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Действия с вещью образа: remove — убрать (аналоги уходят вместе с основной), main — сделать аналог основной вещью, sizes — обновить размеры. */
export async function lookPieceAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const piece = await prisma.stLookItem.findUnique({ where: { id: str(f, "piece") } });
    const look = piece ? await getLook(me, piece.lookId) : null;
    if (!piece || !look) throw new Error("Вещь образа не найдена");
    const op = str(f, "op");
    if (op === "remove") {
      await prisma.stLookItem.delete({ where: { id: piece.id } });
    } else if (op === "main") {
      if (!piece.parentId) throw new Error("Это уже основная вещь");
      const parent = look.items.find((p) => p.id === piece.parentId);
      if (!parent) throw new Error("Основная вещь не найдена");
      // Меняем местами сами вещи: позиция в образе и остальные аналоги остаются на месте.
      await prisma.$transaction([
        prisma.stLookItem.update({ where: { id: parent.id }, data: { itemId: piece.itemId } }),
        prisma.stLookItem.update({ where: { id: piece.id }, data: { itemId: parent.itemId } }),
      ]);
    } else if (op === "sizes") {
      const done = await refreshSizes(piece.itemId, true);
      revalidatePath(`${BASE_PATH}/looks/${look.id}`);
      return done ? { ok: "Размеры обновлены" } : { error: "Этот магазин не отдаёт размеры автоматически — смотрите на сайте магазина" };
    } else throw new Error("Неизвестное действие");
    await prisma.stLook.update({ where: { id: look.id }, data: { updatedAt: new Date() } });
    revalidatePath(BASE_PATH, "layout");
    return {};
  } catch (e) {
    if (e instanceof BlockedError) return { error: "Магазин сейчас не отвечает на запрос размеров — попробуйте позже" };
    return fail(e);
  }
}

/* ---------- Коллекции образов ---------- */

export async function saveCollection(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const name = str(f, "name").slice(0, 200);
    if (!name) throw new Error("Дайте коллекции название");
    const note = str(f, "note").slice(0, 2000) || null;
    const id = str(f, "collection");
    if (id) await prisma.stCollection.update({ where: { id }, data: { name, note } });
    else await prisma.stCollection.create({ data: { name, note, teamId: await teamId(), createdById: me.id } });
    revalidatePath(BASE_PATH, "layout");
    return { ok: id ? "Сохранено" : `Коллекция «${name}» создана` };
  } catch (e) {
    return fail(e);
  }
}

/** Удаляется только коллекция: её образы остаются и переходят в «Без коллекции». */
export async function deleteCollection(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    await prisma.stCollection.delete({ where: { id: str(f, "collection") } });
    revalidatePath(BASE_PATH, "layout");
    return { ok: "Коллекция удалена, образы остались в «Без коллекции»" };
  } catch (e) {
    return fail(e);
  }
}

/** Копия образа (со всеми вещами и аналогами) — чтобы сделать вариант, не трогая исходный. */
export async function copyLook(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let id: string;
  try {
    await assertSee(me);
    const look = await getLook(me, str(f, "look"));
    if (!look) throw new Error("Образ не найден");
    const made = await prisma.stLook.create({ data: { name: `${look.name} — копия`.slice(0, 200), note: look.note, teamId: look.teamId, collectionId: look.collectionId, createdById: me.id } });
    const map = new Map<string, string>();
    for (const p of look.items.filter((x) => !x.parentId)) {
      map.set(p.id, (await prisma.stLookItem.create({ data: { lookId: made.id, itemId: p.itemId, order: p.order } })).id);
    }
    for (const a of look.items.filter((x) => x.parentId && map.has(x.parentId))) {
      await prisma.stLookItem.create({ data: { lookId: made.id, itemId: a.itemId, parentId: map.get(a.parentId!)!, order: a.order } });
    }
    id = made.id;
  } catch (e) {
    return fail(e);
  }
  revalidatePath(BASE_PATH, "layout");
  redirect(`${BASE_PATH}/looks/${id}`);
}

/* ---------- «В духе бренда» (ИИ по фото) ---------- */

/** Одна вещь сразу (кнопка в образе): ответ через несколько секунд. */
export async function checkSpirit(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const r = await aiSpirit(me.id, await teamId(), str(f, "item"));
    if (!r.ok) throw new Error(r.error);
    revalidatePath(BASE_PATH, "layout");
    return { ok: r.spirits.length ? r.spirits.map((s) => `${s.level === "lookalike" ? "Очень похоже на" : "В духе"} ${BRAND_NAMES[s.brand]} (${s.score}%)`).join("; ") : "ИИ посмотрел фото: вещь нейтральная, явных кодов люксовых домов нет." };
  } catch (e) {
    return fail(e);
  }
}

/** Пачка вещей со страницы каталога — в очередь воркера (до 60 за раз; уже проверенные ИИ пропускаются). */
export async function queueSpirit(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const ids = str(f, "items").split(",").filter(Boolean).slice(0, 60);
    const r = await prisma.stItem.updateMany({ where: { id: { in: ids }, spiritAt: null, spiritAsked: null, imageUrl: { startsWith: "https://" } }, data: { spiritAsked: new Date(), spiritById: me.id } });
    return { ok: r.count ? `ИИ проверит вещей: ${r.count}. Это занимает около 5 секунд на вещь — обновите страницу через пару минут.` : "Все показанные вещи уже проверены или стоят в очереди." };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Магазины ---------- */

export async function scanStoreNow(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const store = await prisma.stStore.findUnique({ where: { id: str(f, "store") } });
    if (!store) throw new Error("Магазин не найден");
    if (!ADAPTERS[store.adapter]?.auto) throw new Error("У этого магазина нет автоматического сбора — вещи добавляются по ссылке");
    if (store.scanStatus === "running") return { ok: "Сбор уже идёт" };
    await prisma.stStore.update({ where: { id: store.id }, data: { scanAsked: new Date() } });
    revalidatePath(`${BASE_PATH}/stores`);
    return { ok: "Сбор запущен: обычно 2–5 минут, обновите страницу." };
  } catch (e) {
    return fail(e);
  }
}

export async function saveStore(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const id = str(f, "store");
    const name = str(f, "name").slice(0, 100);
    const brand = str(f, "brand").slice(0, 60) || name;
    const segment = str(f, "segment");
    const geo = str(f, "geo");
    if (!name) throw new Error("Укажите название магазина");
    if (!has(SEGMENTS, segment)) throw new Error("Выберите сегмент");
    if (id) {
      await prisma.stStore.update({ where: { id }, data: { name, brand, segment, isActive: f.get("isActive") === "on", baseUrl: str(f, "baseUrl").slice(0, 300) } });
    } else {
      if (!has(GEOS, geo)) throw new Error("Выберите страну");
      const currency = (str(f, "currency") || (geo === "UA" ? "UAH" : "EUR")).toUpperCase().slice(0, 4);
      const slug = `${brand}-${geo}`.toLowerCase().replace(/[^a-z0-9а-яіїє]+/gi, "-").replace(/^-|-$/g, "").slice(0, 55) || `store-${Date.now()}`;
      if (await prisma.stStore.findUnique({ where: { slug } })) throw new Error("Такой магазин в этой стране уже есть");
      await prisma.stStore.create({ data: { slug, name, brand, segment, geo, adapter: "manual", currency, baseUrl: str(f, "baseUrl").slice(0, 300), isActive: false } });
    }
    revalidatePath(BASE_PATH, "layout");
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Вещь по ссылке и вручную ---------- */

/**
 * Шаг 1 — только ссылка: читаем страницу товара и сохраняем, что нашли. Не нашли название, фото или цену —
 * просим дополнить поля руками (шаг 2: те же поля приходят заполненными).
 */
export async function addItemByLink(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const store = await prisma.stStore.findUnique({ where: { id: str(f, "store") } });
    if (!store) throw new Error("Выберите магазин");
    const url = str(f, "url");
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 700) throw new Error("Вставьте ссылку на страницу вещи (начинается с https://)");
    let name = str(f, "name").slice(0, 300);
    let imageUrl = str(f, "imageUrl");
    let price = Number(str(f, "price").replace(/\s/g, "").replace(",", "."));
    let colorName = str(f, "colorName").slice(0, 80);
    let images: string[] = [];
    let inStock = true;
    let note = "";
    if (!name || !imageUrl || !(price > 0)) {
      try {
        const page = parseProductPage(await shopGet(url, { accept: "text/html,*/*;q=0.8", proxy: true }));
        if (page) {
          name ||= page.name;
          imageUrl ||= page.imageUrl;
          if (!(price > 0) && page.price && (!page.currency || page.currency === store.currency)) price = page.price;
          colorName ||= page.colorName;
          images = page.images;
          inStock = page.inStock;
        }
      } catch (e) {
        note = e instanceof BlockedError ? "Магазин не отдаёт страницу автоматически. " : "Страницу прочитать не удалось. ";
      }
    }
    const missing = [!name && "название", !/^https?:\/\//i.test(imageUrl) && "ссылку на фото", !(price > 0) && `цену в ${store.currency}`].filter(Boolean);
    if (missing.length) throw new Error(`${note}Впишите ниже ${missing.join(", ")} — и нажмите «Добавить» ещё раз. Ссылку на фото можно взять правой кнопкой по картинке → «Копировать адрес изображения».`);
    if (imageUrl.length > 700) throw new Error("Ссылка на фото слишком длинная — скопируйте адрес самой картинки");
    const category = has(CATEGORIES, str(f, "category")) ? str(f, "category") : classifyCategory(name, "");
    const gender = has(GENDERS, str(f, "gender")) ? str(f, "gender") : "woman";
    const color = has(COLORS, str(f, "color")) ? str(f, "color") : classifyColor(colorName || name);
    const sizes = str(f, "sizes").toUpperCase().split(/[\s,;]+/).filter(Boolean).slice(0, 30);
    const extId = `m-${Buffer.from(url).toString("base64url").slice(-100)}`;
    const data = {
      name, url, imageUrl, images, price, currency: store.currency, priceEur: Math.round(price * (await eurRate(store.currency)) * 100) / 100,
      gender, category, rawCategory: "", colorName, color, colorHex: "", tags: pack(classifyTags(name)), inStock, source: "manual", lastSeenAt: new Date(),
      ...(sizes.length ? { sizes: pack(sizes), sizesAt: new Date() } : {}),
    };
    const item = await prisma.stItem.upsert({ where: { storeId_extId: { storeId: store.id, extId } }, update: data, create: { storeId: store.id, extId, ...data } });
    await prisma.stStore.update({ where: { id: store.id }, data: { itemCount: await prisma.stItem.count({ where: { storeId: store.id, inStock: true } }) } });
    revalidatePath(BASE_PATH, "layout");
    if (f.get("toLook") === "on") {
      const r = await addToLook(item.id);
      return r.error ? { error: r.error } : { ok: `Вещь «${name}» добавлена в каталог. ${r.ok}.`, link: r.lookId ? { href: `${BASE_PATH}/looks/${r.lookId}`, label: "Открыть образ" } : undefined };
    }
    return { ok: `Вещь «${name}» добавлена в каталог (${store.name}).` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteManualItem(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    const item = await prisma.stItem.findUnique({ where: { id: str(f, "item") }, select: { id: true, source: true } });
    if (!item || item.source !== "manual") throw new Error("Удалять можно только вещи, добавленные вручную");
    await prisma.stItem.delete({ where: { id: item.id } });
    revalidatePath(BASE_PATH, "layout");
    return { ok: "Удалено" };
  } catch (e) {
    return fail(e);
  }
}
