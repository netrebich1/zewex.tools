"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageTeam } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { testConnection } from "@/lib/pins/wp/client";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

/** Доступ к сайту: создание и правка. Сервисы — чекбоксы projects (slug), пусто = всем. */
export async function saveSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const teamId = str(f, "teamId");
  if (!canManageTeam(me, teamId) && !me.teamIds.includes(teamId)) return { error: "Нет доступа к команде" };
  const baseUrl = str(f, "baseUrl").replace(/\/+$/, "");
  const username = str(f, "username");
  const appPassword = str(f, "appPassword");
  if (!baseUrl || !username) return { error: "Укажите адрес сайта и логин" };
  if (!/^https?:\/\//.test(baseUrl)) return { error: "Адрес должен начинаться с http(s)://" };
  const projects = f.getAll("projects").map(String).filter(Boolean);
  const data = {
    teamId, kind: "wordpress", name: str(f, "name") || baseUrl.replace(/^https?:\/\//, ""), baseUrl, username,
    mediaBaseUrl: str(f, "mediaBaseUrl").replace(/\/+$/, "") || null, mediaUsername: str(f, "mediaUsername") || null, mediaDomain: str(f, "mediaDomain") || null,
    linkDomain: str(f, "linkDomain") || null, notes: str(f, "notes") || null, projects,
    ...(appPassword ? { appPasswordEnc: encryptSecret(appPassword) } : {}),
    ...(str(f, "mediaAppPassword") ? { mediaAppPasswordEnc: encryptSecret(str(f, "mediaAppPassword")) } : {}),
  };
  try {
    if (id) await prisma.siteAccess.update({ where: { id }, data });
    else {
      if (!appPassword) return { error: "Укажите Application Password" };
      await prisma.siteAccess.create({ data: { ...data, appPasswordEnc: encryptSecret(appPassword) } });
    }
  } catch (e) { return fail(e); }
  revalidatePath("/access");
  return { ok: "Доступ сохранён" };
}

export async function testSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || (me.role !== "ADMIN" && !me.teamIds.includes(c.teamId))) return { error: "Доступ не найден" };
  const r = await testConnection({ baseUrl: c.baseUrl, username: c.username, appPassword: decryptSecret(c.appPasswordEnc) });
  await prisma.siteAccess.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckOk: r.ok, lastCheckNote: r.note } });
  revalidatePath("/access");
  return r.ok ? { ok: r.note } : { error: r.note };
}

export async function deleteSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || !canManageTeam(me, c.teamId)) return { error: "Нет прав" };
  const used = await prisma.pinSite.count({ where: { wpConnectionId: id } });
  if (used) return { error: `Доступ используют ${used} сайт(ов) в Pinterest Pins. Сначала выберите им другой.` };
  await prisma.siteAccess.delete({ where: { id } });
  revalidatePath("/access");
  return { ok: "Удалено" };
}
