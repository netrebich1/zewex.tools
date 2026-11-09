"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, isOwnerEmail, realSession } from "@/lib/auth";
import type { FormState } from "./admin";

/**
 * Режимы главного админа. Всё хранится в строке его сессии, поэтому:
 * - сотрудник, в кабинет которого вошли, ничего не замечает и вернуть «чужого» не может;
 * - вернуться из кабинета может только тот главный админ, который в него вошёл.
 * Проверки идут по настоящему вошедшему (`realSession`), а не по подменённому пользователю.
 */
async function requireSuperSession() {
  const s = await realSession();
  if (!s?.superAdmin) redirect("/?denied=1");
  return s;
}

/** Переключатель «Админ / Сотрудник» у аватарки. */
export async function setMemberView(on: boolean): Promise<void> {
  const s = await requireSuperSession();
  await prisma.session.update({ where: { id: s.id }, data: { memberView: on, actAsUserId: null } });
  console.info(`[view-as] ${s.user.email}: ${on ? "member view on" : "admin view"}`);
  revalidatePath("/", "layout");
}

/** Войти в кабинет сотрудника. Нельзя: в свой, в отключённый, в кабинет другого главного админа. */
export async function startImpersonation(userId: string): Promise<FormState> {
  const s = await requireSuperSession();
  if (!userId || userId === s.userId) return { error: "Это ваш собственный кабинет" };
  const t = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true, isActive: true, superAdmin: true } });
  if (!t) return { error: "Пользователь не найден" };
  if (!t.isActive) return { error: "Доступ этого пользователя закрыт: войти в его кабинет нельзя" };
  if (t.role === "ADMIN" && (t.superAdmin || isOwnerEmail(t.email))) return { error: "В кабинет главного админа войти нельзя" };
  await prisma.session.update({ where: { id: s.id }, data: { actAsUserId: t.id, memberView: false } });
  console.info(`[view-as] ${s.user.email} -> ${t.email}`);
  revalidatePath("/", "layout");
  redirect("/");
}

/** Вернуться в свой кабинет. Работает только в сессии главного админа, который вошёл. */
export async function stopImpersonation(): Promise<void> {
  const s = await requireSuperSession();
  const back = s.actAsUserId;
  await prisma.session.update({ where: { id: s.id }, data: { actAsUserId: null } });
  console.info(`[view-as] ${s.user.email} returned${back ? ` from ${back}` : ""}`);
  revalidatePath("/", "layout");
  redirect(back ? `/users/${back}` : "/");
}

/** Список для выбора кабинета: активные пользователи, кроме себя и главных админов. */
export async function impersonationCandidates(): Promise<Array<{ id: string; name: string; email: string; role: string; teams: string[] }>> {
  const s = await realSession();
  if (!s?.superAdmin) return [];
  const users = await prisma.user.findMany({
    where: { isActive: true, id: { not: s.userId } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, role: true, superAdmin: true, memberships: { select: { team: { select: { name: true } } } } },
  });
  return users
    .filter((u) => !(u.role === "ADMIN" && (u.superAdmin || isOwnerEmail(u.email))))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, teams: u.memberships.map((m) => m.team.name) }));
}

/** Отметка «главный админ» у другого админа. Ставит и снимает только владелец портала. */
export async function setSuperAdmin(_p: FormState, f: FormData): Promise<FormState> {
  const s = await realSession();
  if (!s || s.actAsUserId || !isOwnerEmail(s.user.email) || s.user.role !== "ADMIN") return { error: "Главных админов назначает только владелец портала" };
  const id = String(f.get("id") ?? "");
  const on = String(f.get("on") ?? "") === "1";
  const t = await prisma.user.findUnique({ where: { id }, select: { role: true, email: true } });
  if (!t) return { error: "Пользователь не найден" };
  if (isOwnerEmail(t.email)) return { error: "Владелец портала — главный админ всегда" };
  if (on && t.role !== "ADMIN") return { error: "Сначала сделайте пользователя админом" };
  await prisma.user.update({ where: { id }, data: { superAdmin: on } });
  // Снятый главный админ сразу выходит из режимов: чужой кабинет и режим сотрудника в его сессиях сбрасываются.
  if (!on) await prisma.session.updateMany({ where: { userId: id }, data: { actAsUserId: null, memberView: false } });
  revalidatePath(`/users/${id}`);
  revalidatePath("/users");
  return { ok: on ? "Теперь это главный админ" : "Отметка снята" };
}

/**
 * Активная команда в шапке: сотрудник в нескольких командах (и главный админ в режиме сотрудника) смотрит портал
 * от одной команды. Хранится в строке сессии; в чужом кабинете проверяется по командам того, чей кабинет открыт.
 * null — все команды.
 */
export async function setActiveTeam(teamId: string | null): Promise<void> {
  const s = await realSession();
  if (!s) redirect("/login");
  const me = await getCurrentUser();
  const next = teamId && me?.teams.some((t) => t.id === teamId) ? teamId : null;
  await prisma.session.update({ where: { id: s.id }, data: { activeTeamId: next } });
  revalidatePath("/", "layout");
}
