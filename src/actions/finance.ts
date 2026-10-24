"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { rateToEur } from "@/lib/finance/rates";
import { BASE, normCur, todayYmd } from "@/lib/finance/currency";
import { MAX_PARTNERS } from "@/lib/finance/limits";
import { isPnlLine, pnlLine } from "@/lib/finance/pnl";

export type FinState = { error?: string; ok?: string; at?: number };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (raw: string) => Number(raw.replace(/\s/g, "").replace(",", "."));
const fail = (e: unknown): FinState => ({ error: e instanceof Error ? e.message : String(e) });
const done = (ok: string): FinState => { revalidatePath("/finance", "layout"); return { ok, at: Date.now() }; };
const TYPES = ["EXPENSE", "INCOME", "SETTLEMENT"] as const;

/** Создать или изменить операцию. Курс: вписанный вручную («1 EUR = N валюты») или рыночный на дату. */
export async function saveOp(_p: FinState, f: FormData): Promise<FinState> {
  const me = await requireFinance();
  try {
    const id = str(f, "id");
    const type = str(f, "type") as (typeof TYPES)[number];
    if (!TYPES.includes(type)) throw new Error("Выберите тип операции");
    const amount = num(str(f, "amount"));
    if (!(amount > 0)) throw new Error("Сумма должна быть больше нуля");
    const currency = normCur(str(f, "currency")) || BASE;
    const date = str(f, "date") || todayYmd();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Неверная дата");
    const partnerId = str(f, "partnerId");
    const partners = await prisma.finPartner.findMany({ select: { id: true } });
    if (!partners.some((p) => p.id === partnerId)) throw new Error("Укажите, кто платил или получил");
    const toPartnerId = type === "SETTLEMENT" ? str(f, "toPartnerId") : "";
    if (type === "SETTLEMENT" && (!partners.some((p) => p.id === toPartnerId) || toPartnerId === partnerId)) throw new Error("Возврат: выберите, кто кому отдал (два разных человека)");

    const manualRaw = str(f, "manualRate");
    let rate: number;
    let rateManual = false;
    if (currency === BASE) rate = 1;
    else if (manualRaw) {
      const per = num(manualRaw);
      if (!(per > 0)) throw new Error("Курс вручную: «1 EUR = сколько валюты», число больше нуля");
      rate = 1 / per;
      rateManual = true;
    } else {
      const r = await rateToEur(currency, date);
      if (!r) throw new Error(`Нет курса ${currency} на ${date}. Впишите курс вручную.`);
      rate = r.rate;
    }
    const categoryId = type === "SETTLEMENT" ? null : str(f, "categoryId") || null;
    const counterpartyId = type === "SETTLEMENT" ? null : await resolveCounterparty(str(f, "counterparty"), categoryId, f.get("cpConfirm") === "1", me.id);
    const data = {
      type, date: new Date(`${date}T00:00:00Z`), amount, currency, rate, rateManual,
      amountEur: Math.round(amount * rate * 100) / 100,
      directionId: type === "SETTLEMENT" ? null : str(f, "directionId") || null,
      categoryId, counterpartyId,
      partnerId, toPartnerId: toPartnerId || null,
      account: str(f, "account").slice(0, 120) || null,
      note: str(f, "note").slice(0, 2000) || null,
    };
    if (id) {
      const old = await prisma.finOp.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!old || old.deletedAt) throw new Error("Операция удалена или не найдена");
      await prisma.finOp.update({ where: { id }, data: { ...data, updatedById: me.id } });
      return done("Операция сохранена");
    }
    await prisma.finOp.create({ data: { ...data, createdById: me.id } });
    return done("Записано");
  } catch (e) {
    return fail(e);
  }
}

/**
 * Контрагент по имени. Новый создаётся, а существующий привязывается к категории только с подтверждением
 * пользователя (`cpConfirm`, форма спрашивает); без подтверждения новое имя — ошибка, привязка — пропускается.
 */
async function resolveCounterparty(raw: string, categoryId: string | null, confirmed: boolean, userId: string): Promise<string | null> {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) return null;
  let cp = await prisma.finCounterparty.findUnique({ where: { name }, include: { categories: { select: { categoryId: true } } } });
  if (!cp) {
    if (!confirmed) throw new Error(`Контрагента «${name}» нет в системе — подтвердите добавление`);
    cp = await prisma.finCounterparty.create({ data: { name, createdById: userId }, include: { categories: { select: { categoryId: true } } } });
  } else if (cp.archived) {
    await prisma.finCounterparty.update({ where: { id: cp.id }, data: { archived: false } });
  }
  if (categoryId && confirmed && !cp.categories.some((c) => c.categoryId === categoryId)) {
    await prisma.finCounterpartyCategory.create({ data: { counterpartyId: cp.id, categoryId } });
  }
  return cp.id;
}

/** Удаление мягкое: операция пропадает из итогов и журнала, но остаётся в базе (кто и когда удалил). */
export async function deleteOp(_p: FinState, f: FormData): Promise<FinState> {
  const me = await requireFinance();
  try {
    await prisma.finOp.update({ where: { id: str(f, "id") }, data: { deletedAt: new Date(), deletedById: me.id } });
    return done("Операция удалена");
  } catch (e) {
    return fail(e);
  }
}

/** Повторить операцию сегодняшней датой (подписки, регулярные платежи). Ручной курс сохраняется, рыночный берётся на сегодня. */
export async function repeatOp(_p: FinState, f: FormData): Promise<FinState> {
  const me = await requireFinance();
  try {
    const o = await prisma.finOp.findUnique({ where: { id: str(f, "id") } });
    if (!o || o.deletedAt) throw new Error("Операция не найдена");
    const date = todayYmd();
    let rate = Number(o.rate);
    if (!o.rateManual && o.currency !== BASE) {
      const r = await rateToEur(o.currency, date);
      if (!r) throw new Error(`Нет курса ${o.currency} на сегодня`);
      rate = r.rate;
    }
    const { id: _id, createdAt: _c, updatedAt: _u, updatedById: _ub, deletedAt: _d, deletedById: _db, ...rest } = o;
    await prisma.finOp.create({ data: { ...rest, date: new Date(`${date}T00:00:00Z`), rate, amountEur: Math.round(Number(o.amount) * rate * 100) / 100, createdById: me.id } });
    return done("Повторено сегодняшней датой");
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Настройки ---------- */

/** Направление: добавить (name + parentId?), переименовать (id + name), скрыть/вернуть (id + archived). */
export async function saveDirection(_p: FinState, f: FormData): Promise<FinState> {
  await requireFinance();
  try {
    const id = str(f, "id");
    const name = str(f, "name").slice(0, 80);
    if (f.has("archived")) {
      await prisma.finDirection.update({ where: { id }, data: { archived: str(f, "archived") === "1" } });
      return done("Сохранено");
    }
    if (!name) throw new Error("Впишите название");
    if (id) {
      await prisma.finDirection.update({ where: { id }, data: { name } });
      return done("Переименовано");
    }
    const parentId = str(f, "parentId") || null;
    if (parentId) {
      const parent = await prisma.finDirection.findUnique({ where: { id: parentId } });
      if (!parent || parent.parentId) throw new Error("Подраздел можно добавить только к направлению верхнего уровня");
    }
    const order = (await prisma.finDirection.count({ where: { parentId } })) + 1;
    await prisma.finDirection.create({ data: { name, parentId, order } });
    return done(parentId ? "Подраздел добавлен" : "Направление добавлено");
  } catch (e) {
    return fail(e);
  }
}

export async function saveCategory(_p: FinState, f: FormData): Promise<FinState> {
  await requireFinance();
  try {
    const id = str(f, "id");
    if (f.has("archived")) {
      await prisma.finCategory.update({ where: { id }, data: { archived: str(f, "archived") === "1" } });
      return done("Сохранено");
    }
    const name = str(f, "name").slice(0, 80);
    if (!name) throw new Error("Впишите название");
    const pnl = isPnlLine(str(f, "pnl")) ? (str(f, "pnl") as ReturnType<typeof pnlLine>["key"]) : "OPEX";
    const kind = pnlLine(pnl).kind;
    if (id) await prisma.finCategory.update({ where: { id }, data: { name, pnl, kind } });
    else await prisma.finCategory.create({ data: { name, pnl, kind, order: (await prisma.finCategory.count()) + 1 } });
    return done("Категория сохранена");
  } catch (e) {
    return fail(e);
  }
}

/** Партнёр: имя, привязка к пользователю портала, доля в %. */
export async function savePartner(_p: FinState, f: FormData): Promise<FinState> {
  await requireFinance();
  try {
    const id = str(f, "id");
    const name = str(f, "name").slice(0, 60);
    if (!name) throw new Error("Впишите имя");
    const sharePct = num(str(f, "sharePct") || "50");
    if (!(sharePct >= 0 && sharePct <= 100)) throw new Error("Доля — от 0 до 100 %");
    const userId = str(f, "userId") || null;
    if (userId) {
      const taken = await prisma.finPartner.findFirst({ where: { userId, ...(id ? { id: { not: id } } : {}) } });
      if (taken) throw new Error(`Этот пользователь уже привязан к партнёру «${taken.name}»`);
    }
    if (id) await prisma.finPartner.update({ where: { id }, data: { name, sharePct, userId } });
    else {
      const n = await prisma.finPartner.count();
      if (n >= MAX_PARTNERS) throw new Error(`Не больше ${MAX_PARTNERS} партнёров`);
      await prisma.finPartner.create({ data: { name, sharePct, userId, order: n + 1 } });
    }
    return done("Партнёр сохранён");
  } catch (e) {
    return fail(e);
  }
}

export async function deletePartner(_p: FinState, f: FormData): Promise<FinState> {
  await requireFinance();
  try {
    const id = str(f, "id");
    const used = await prisma.finOp.count({ where: { OR: [{ partnerId: id }, { toPartnerId: id }] } });
    if (used) throw new Error(`У партнёра ${used} операций — удалить нельзя`);
    await prisma.finPartner.delete({ where: { id } });
    return done("Партнёр удалён");
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Контрагенты ---------- */

/** Добавить или изменить контрагента: имя и категории (галочки `cats`). Скрыть/вернуть — поле `archived`. */
export async function saveCounterparty(_p: FinState, f: FormData): Promise<FinState> {
  const me = await requireFinance();
  try {
    const id = str(f, "id");
    if (f.has("archived")) {
      await prisma.finCounterparty.update({ where: { id }, data: { archived: str(f, "archived") === "1" } });
      return done("Сохранено");
    }
    const name = str(f, "name").replace(/\s+/g, " ").slice(0, 120);
    if (!name) throw new Error("Впишите название");
    const same = await prisma.finCounterparty.findUnique({ where: { name } });
    if (same && same.id !== id) throw new Error(`«${same.name}» уже есть. Чтобы свести двух в одного, используйте «Объединить».`);
    const cats = f.getAll("cats").map(String).filter(Boolean);
    await prisma.$transaction(async (tx) => {
      const cp = id ? await tx.finCounterparty.update({ where: { id }, data: { name } }) : await tx.finCounterparty.create({ data: { name, createdById: me.id } });
      if (f.has("catsPresent")) {
        await tx.finCounterpartyCategory.deleteMany({ where: { counterpartyId: cp.id, categoryId: { notIn: cats } } });
        for (const categoryId of cats) await tx.finCounterpartyCategory.upsert({ where: { counterpartyId_categoryId: { counterpartyId: cp.id, categoryId } }, update: {}, create: { counterpartyId: cp.id, categoryId } });
      }
    });
    return done(id ? "Контрагент сохранён" : "Контрагент добавлен");
  } catch (e) {
    return fail(e);
  }
}

/** Объединить дубль (`id`) в основного (`intoId`): операции и категории переходят, дубль удаляется. */
export async function mergeCounterparty(_p: FinState, f: FormData): Promise<FinState> {
  await requireFinance();
  try {
    const id = str(f, "id"), intoId = str(f, "intoId");
    if (!intoId || id === intoId) throw new Error("Выберите, с кем объединить");
    const [from, into] = await Promise.all([
      prisma.finCounterparty.findUnique({ where: { id }, include: { categories: true } }),
      prisma.finCounterparty.findUnique({ where: { id: intoId } }),
    ]);
    if (!from || !into) throw new Error("Контрагент не найден");
    await prisma.$transaction(async (tx) => {
      await tx.finOp.updateMany({ where: { counterpartyId: id }, data: { counterpartyId: intoId } });
      for (const c of from.categories) await tx.finCounterpartyCategory.upsert({ where: { counterpartyId_categoryId: { counterpartyId: intoId, categoryId: c.categoryId } }, update: {}, create: { counterpartyId: intoId, categoryId: c.categoryId } });
      await tx.finCounterparty.delete({ where: { id } });
    });
    return done(`«${from.name}» объединён с «${into.name}»`);
  } catch (e) {
    return fail(e);
  }
}
