"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { allowedRegistrationEmails, createSession, destroySession, hashPassword, normalizeLogin, verifyPassword, getCurrentUser, registrationOpen } from "@/lib/auth";
import { clientIp, clear, hit, tooMany } from "@/lib/ratelimit";

export type FormState = { error?: string; ok?: string };

const creds = z.object({ email: z.string().email("Некорректная почта"), password: z.string().min(8, "Пароль не короче 8 символов") });

// Brute-force protection: per IP and per account, 15-minute windows.
const WINDOW = 15 * 60;
const IP_LIMIT = 30;
const ACCOUNT_LIMIT = 8;

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const login = normalizeLogin(String(form.get("login") ?? ""));
  const password = String(form.get("password") ?? "");
  if (!login || login.length > 190) return { error: "Укажите логин" };
  if (!password) return { error: "Укажите пароль" };
  const ip = await clientIp();
  const byIp = hit(`login:ip:${ip}`, IP_LIMIT, WINDOW);
  if (byIp) return { error: tooMany(byIp) };
  const byAccount = hit(`login:acc:${login}`, ACCOUNT_LIMIT, WINDOW);
  if (byAccount) return { error: tooMany(byAccount) };
  const user = await prisma.user.findUnique({ where: { email: login } });
  if (!user || !user.passwordHash || !user.isActive) return { error: "Неверный логин или пароль" };
  if (!(await verifyPassword(password, user.passwordHash))) return { error: "Неверный логин или пароль" };
  clear(`login:acc:${login}`);
  await createSession(user.id);
  redirect("/");
}

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim();
  const parsed = creds.safeParse({ email, password: String(form.get("password") ?? "") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!name) return { error: "Укажите имя" };
  const ip = await clientIp();
  const byIp = hit(`register:ip:${ip}`, 10, WINDOW);
  if (byIp) return { error: tooMany(byIp) };
  if (!(await registrationOpen())) return { error: "Регистрация закрыта. Аккаунт создаёт администратор." };
  if (!allowedRegistrationEmails().includes(email)) return { error: "Регистрация закрыта. Аккаунт создаёт администратор." };
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists?.passwordHash) return { error: "Этот аккаунт уже зарегистрирован, войдите" };
  const passwordHash = await hashPassword(parsed.data.password);
  const user = exists
    ? await prisma.user.update({ where: { id: exists.id }, data: { passwordHash, name, role: "ADMIN", isActive: true, inviteToken: null, inviteExpires: null } })
    : await prisma.user.create({ data: { email, name, passwordHash, role: "ADMIN" } });
  await createSession(user.id);
  redirect("/");
}

export async function changePasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) return { error: "Нет сессии" };
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  if (next.length < 8) return { error: "Новый пароль не короче 8 символов" };
  const byAccount = hit(`chpass:${me.id}`, ACCOUNT_LIMIT, WINDOW);
  if (byAccount) return { error: tooMany(byAccount) };
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) return { error: "Текущий пароль неверный" };
  await prisma.user.update({ where: { id: me.id }, data: { passwordHash: await hashPassword(next) } });
  clear(`chpass:${me.id}`);
  return { ok: "Пароль обновлён" };
}

export async function updateProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) return { error: "Нет сессии" };
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Укажите имя" };
  await prisma.user.update({ where: { id: me.id }, data: { name } });
  return { ok: "Сохранено" };
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
