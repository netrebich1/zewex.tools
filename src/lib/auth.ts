import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import bcrypt from "bcryptjs";
import { prisma } from "./db";
import { randomToken } from "./crypto";

export const SESSION_COOKIE = "zx_session";
const SESSION_DAYS = 30;

export async function hashPassword(p: string) {
  return bcrypt.hash(p, 11);
}
export async function verifyPassword(p: string, hash: string) {
  return bcrypt.compare(p, hash);
}

export async function createSession(userId: string) {
  const id = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await prisma.session.create({ data: { id, userId, expiresAt } });
  // Opportunistic cleanup of expired sessions (cheap, indexed by nothing but small table).
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
    // Set SESSION_COOKIE_DOMAIN=.zewex.tools once tools live on subdomains and must call /api/run.
    ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await prisma.session.deleteMany({ where: { id } });
  jar.delete(SESSION_COOKIE);
}

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "MEMBER";
  teamIds: string[];
  /** Teams where the user has the LEAD role: they may manage that team's rules. */
  leadTeamIds: string[];
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const session = await prisma.session.findUnique({
    where: { id },
    include: { user: { include: { memberships: { select: { teamId: true, role: true } } } } },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  const u = session.user;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    teamIds: u.memberships.map((m) => m.teamId),
    leadTeamIds: u.memberships.filter((m) => m.role === "LEAD").map((m) => m.teamId),
  };
});

/** Admins manage every team; a team lead manages only teams they lead. */
export function canManageTeam(u: CurrentUser, teamId: string): boolean {
  return u.role === "ADMIN" || u.leadTeamIds.includes(teamId);
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  return u;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "ADMIN") redirect("/?denied=1");
  return u;
}

export function isAdmin(u: CurrentUser | null) {
  return u?.role === "ADMIN";
}

export function allowedRegistrationEmails(): string[] {
  return (process.env.ALLOWED_REGISTRATION_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Self-registration stays open only until every allowed owner email has a password. */
export async function registrationOpen(): Promise<boolean> {
  const emails = allowedRegistrationEmails();
  if (!emails.length) return false;
  const registered = await prisma.user.count({ where: { email: { in: emails }, passwordHash: { not: null } } });
  return registered < emails.length;
}
