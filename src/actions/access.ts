"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
  let createdId = "";
  try {
    if (id) await prisma.siteAccess.update({ where: { id }, data });
    else {
      if (!appPassword) return { error: "Укажите Application Password" };
      const created = await prisma.siteAccess.create({ data: { ...data, appPasswordEnc: encryptSecret(appPassword) } });
      createdId = created.id;
      const r = await testConnection({ baseUrl, username, appPassword });
      await prisma.siteAccess.update({ where: { id: createdId }, data: { lastCheckedAt: new Date(), lastCheckOk: r.ok, lastCheckNote: r.note } });
    }
  } catch (e) { return fail(e); }
  revalidatePath("/sites");
  if (createdId) redirect(`/sites/${createdId}`);
  revalidatePath(`/sites/${id}`);
  return { ok: "Доступ сохранён" };
}

export async function testSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || (me.role !== "ADMIN" && !me.teamIds.includes(c.teamId))) return { error: "Доступ не найден" };
  const r = await testConnection({ baseUrl: c.baseUrl, username: c.username, appPassword: decryptSecret(c.appPasswordEnc) });
  await prisma.siteAccess.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckOk: r.ok, lastCheckNote: r.note } });
  revalidatePath(`/sites/${id}`);
  return r.ok ? { ok: r.note } : { error: r.note };
}

export async function deleteSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || !canManageTeam(me, c.teamId)) return { error: "Нет прав" };
  const runs = await prisma.pinRun.count({ where: { site: { wpConnectionId: id } } });
  if (runs) return { error: `У сайта ${runs} прогон(ов) в Pinterest Pins. Уберите сайт в архив вместо удаления.` };
  await prisma.$transaction([
    prisma.pinSite.deleteMany({ where: { wpConnectionId: id } }),
    prisma.siteAccess.delete({ where: { id } }),
  ]);
  revalidatePath("/sites");
  redirect("/sites");
}
