"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import type { FormState } from "@/components/ActionForm";
import { accountWhere, groupWhere, propertyWhere, requireAnalytics } from "@/lib/analytics/access";
import { parseServiceKey } from "@/lib/analytics/google";
import { refreshAccountProperties } from "@/lib/analytics/sync";
import { GROUP_COLORS } from "@/lib/analytics/types";

/** Действия кабинета «Трафик сайтов»: аккаунты Google, какие сайты тянем, группы. OAuth-подключение — /api/analytics/oauth/start. */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const touch = () => {
  revalidatePath("/analytics");
  revalidatePath("/analytics/settings");
  revalidatePath("/analytics/pages");
};

/** Сервисный аккаунт: вставить JSON-ключ. Его почту нужно добавить в GA с ролью «Читатель». */
export async function addServiceAccount(_: FormState, form: FormData): Promise<FormState> {
  const me = await requireAnalytics();
  try {
    const key = parseServiceKey(String(form.get("json") ?? ""));
    const label = String(form.get("label") ?? "").trim();
    const existing = await prisma.gaAccount.findFirst({ where: { email: key.client_email, kind: "service", userId: me.id }, select: { id: true } });
    const data = { saKeyEnc: encryptSecret(JSON.stringify(key)), status: "OK", lastError: null, label };
    const acc = existing ? await prisma.gaAccount.update({ where: { id: existing.id }, data }) : await prisma.gaAccount.create({ data: { userId: me.id, kind: "service", email: key.client_email, ...data } });
    const r = await refreshAccountProperties(acc.id);
    touch();
    return { ok: r.total ? `Подключено. Найдено сайтов: ${r.total}. Отметьте ниже, какие показывать.` : `Ключ принят, но этому аккаунту (${key.client_email}) пока не открыт ни один ресурс GA. Добавьте его в Google Analytics: Администратор → Управление доступом к аккаунту → + → роль «Читатель».` };
  } catch (e) {
    return { error: msg(e) };
  }
}

export async function removeAccountAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const id = String(form.get("id") ?? "");
  await prisma.gaAccount.deleteMany({ where: { id, ...accountWhere(me) } });
  touch();
}

export async function refreshAccountAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const id = String(form.get("id") ?? "");
  const acc = await prisma.gaAccount.findFirst({ where: { id, ...accountWhere(me) }, select: { id: true } });
  if (acc) await refreshAccountProperties(acc.id).catch(() => {});
  touch();
}

/** Включить/выключить сайт. При включении история грузится с нуля, если данных ещё не было. */
export async function setPropertyEnabled(id: string, enabled: boolean): Promise<{ error?: string }> {
  const me = await requireAnalytics();
  const p = await prisma.gaProperty.findFirst({ where: { id, ...propertyWhere(me) }, select: { id: true } });
  if (!p) return { error: "Сайт не найден" };
  await prisma.gaProperty.update({ where: { id }, data: enabled ? { enabled: true, nextSyncAt: new Date(), lastSyncError: null } : { enabled: false } });
  touch();
  return {};
}

/** Все сайты аккаунта разом. */
export async function setAllPropertiesAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const accountId = String(form.get("accountId") ?? "");
  const enabled = form.get("enabled") === "1";
  const acc = await prisma.gaAccount.findFirst({ where: { id: accountId, ...accountWhere(me) }, select: { id: true } });
  if (!acc) return;
  await prisma.gaProperty.updateMany({ where: { accountId, removed: false }, data: enabled ? { enabled: true, nextSyncAt: new Date(), lastSyncError: null } : { enabled: false } });
  touch();
}

/** Перечитать всю историю сайта заново (например, после смены настроек в GA). */
export async function resyncPropertyAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const id = String(form.get("id") ?? "");
  const p = await prisma.gaProperty.findFirst({ where: { id, ...propertyWhere(me) }, select: { id: true } });
  if (!p) return;
  await prisma.gaProperty.update({ where: { id }, data: { syncState: {}, nextSyncAt: new Date(), lastSyncError: null, enabled: true } });
  touch();
}

/* ---------- Группы ---------- */

export async function createGroup(_: FormState, form: FormData): Promise<FormState> {
  const me = await requireAnalytics();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Введите название группы" };
  const count = await prisma.gaGroup.count({ where: { userId: me.id } });
  const color = String(form.get("color") ?? "") || GROUP_COLORS[count % GROUP_COLORS.length];
  await prisma.gaGroup.create({ data: { userId: me.id, name, color, order: count } });
  touch();
  return { ok: `Группа «${name}» создана` };
}

export async function renameGroupAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const color = String(form.get("color") ?? "").trim();
  if (!name) return;
  await prisma.gaGroup.updateMany({ where: { id, ...groupWhere(me) }, data: { name, ...(color ? { color } : {}) } });
  touch();
}

export async function deleteGroupAction(form: FormData): Promise<void> {
  const me = await requireAnalytics();
  const id = String(form.get("id") ?? "");
  await prisma.gaGroup.deleteMany({ where: { id, ...groupWhere(me) } });
  touch();
}

/** Группы сайта: заменить набор. */
export async function setPropertyGroups(propertyId: string, groupIds: string[]): Promise<{ error?: string }> {
  const me = await requireAnalytics();
  const [p, groups] = await Promise.all([
    prisma.gaProperty.findFirst({ where: { id: propertyId, ...propertyWhere(me) }, select: { id: true } }),
    prisma.gaGroup.findMany({ where: { id: { in: groupIds }, ...groupWhere(me) }, select: { id: true } }),
  ]);
  if (!p) return { error: "Сайт не найден" };
  await prisma.$transaction([
    prisma.gaGroupProperty.deleteMany({ where: { propertyId } }),
    ...(groups.length ? [prisma.gaGroupProperty.createMany({ data: groups.map((g) => ({ groupId: g.id, propertyId })) })] : []),
  ]);
  touch();
  return {};
}

/** Порядок сайтов в списке (перетаскивание в настройках). */
export async function reorderProperties(ids: string[]): Promise<void> {
  const me = await requireAnalytics();
  const own = await prisma.gaProperty.findMany({ where: { id: { in: ids }, ...propertyWhere(me) }, select: { id: true } });
  const allowed = new Set(own.map((p) => p.id));
  await prisma.$transaction(ids.filter((id) => allowed.has(id)).map((id, i) => prisma.gaProperty.update({ where: { id }, data: { order: i } })));
  touch();
}
