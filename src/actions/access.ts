"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageTeam } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { testConnection } from "@/lib/pins/wp/client";
import { assertPublicUrl } from "@/lib/pins/fetch";
import { canAccessSiteAccess } from "@/lib/sites/access";
import { seesAllSites } from "@/lib/permissions";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

/**
 * Доступ к сайту (уровень системы): REST API WordPress, команда-владелец, дополнительные команды,
 * сервисы (projects, пусто = всем) и видимость — список сотрудников (пусто = вся команда).
 */
export async function saveSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const teamId = str(f, "teamId");
  if (!canManageTeam(me, teamId) && !me.teamIds.includes(teamId)) return { error: "Нет доступа к команде" };
  if (id && !(await canAccessSiteAccess(me, id))) return { error: "Доступ не найден" };
  const baseUrl = str(f, "baseUrl").replace(/\/+$/, "");
  const username = str(f, "username");
  const appPassword = str(f, "appPassword");
  if (!baseUrl || !username) return { error: "Укажите адрес сайта и логин" };
  if (!/^https?:\/\//.test(baseUrl)) return { error: "Адрес должен начинаться с http(s)://" };
  try {
    await assertPublicUrl(baseUrl);
    if (str(f, "mediaBaseUrl")) await assertPublicUrl(str(f, "mediaBaseUrl"));
  } catch (e) { return fail(e); }
  const projects = f.getAll("projects").map(String).filter(Boolean);
  // Дополнительные команды: только те, где пользователь состоит (админ — любые); владелец не дублируется.
  const extraTeams = [...new Set(f.getAll("teamIds").map(String).filter((t) => t && t !== teamId && (seesAllSites(me) || me.teamIds.includes(t))))];
  const allTeams = [teamId, ...extraTeams];
  // Видимость: только участники выбранных команд.
  const wantViewers = [...new Set(f.getAll("viewerIds").map(String).filter(Boolean))];
  const viewers = wantViewers.length
    ? (await prisma.teamMember.findMany({ where: { teamId: { in: allTeams }, userId: { in: wantViewers } }, select: { userId: true }, distinct: ["userId"] })).map((m) => m.userId)
    : [];
  const data = {
    teamId, kind: "wordpress", name: str(f, "name") || baseUrl.replace(/^https?:\/\//, ""), baseUrl, username,
    mediaBaseUrl: str(f, "mediaBaseUrl").replace(/\/+$/, "") || null, mediaUsername: str(f, "mediaUsername") || null, mediaDomain: str(f, "mediaDomain") || null,
    // linkDomain — настройка инструмента пинов (хранится в его настройках сайта); здесь поле больше не редактируется.
    ...(f.has("linkDomain") ? { linkDomain: str(f, "linkDomain") || null } : {}),
    notes: str(f, "notes") || null, projects,
    ...(appPassword ? { appPasswordEnc: encryptSecret(appPassword) } : {}),
    ...(str(f, "mediaAppPassword") ? { mediaAppPasswordEnc: encryptSecret(str(f, "mediaAppPassword")) } : {}),
  };
  let createdId = "";
  try {
    const accessId = await prisma.$transaction(async (tx) => {
      let aid = id;
      if (id) await tx.siteAccess.update({ where: { id }, data });
      else {
        if (!appPassword) throw new Error("Укажите Application Password");
        const created = await tx.siteAccess.create({ data: { ...data, appPasswordEnc: encryptSecret(appPassword) } });
        aid = created.id;
      }
      await tx.siteAccessTeam.deleteMany({ where: { accessId: aid } });
      if (extraTeams.length) await tx.siteAccessTeam.createMany({ data: extraTeams.map((t) => ({ accessId: aid, teamId: t })) });
      await tx.siteAccessViewer.deleteMany({ where: { accessId: aid } });
      if (viewers.length) await tx.siteAccessViewer.createMany({ data: viewers.map((u) => ({ accessId: aid, userId: u })) });
      // Сайт сервиса следует за командой-владельцем доступа.
      await tx.pinSite.updateMany({ where: { wpConnectionId: aid }, data: { teamId } });
      return aid;
    });
    if (!id) {
      createdId = accessId;
      const r = await testConnection({ baseUrl, username, appPassword });
      await prisma.siteAccess.update({ where: { id: createdId }, data: { lastCheckedAt: new Date(), lastCheckOk: r.ok, lastCheckNote: r.note } });
    }
  } catch (e) { return fail(e); }
  revalidatePath("/sites");
  revalidatePath("/pinterest/pins/sites");
  if (createdId) redirect(`/sites/${createdId}`);
  revalidatePath(`/sites/${id}`);
  return { ok: wantViewers.length && !viewers.length ? "Доступ сохранён. Выбранные сотрудники не состоят в командах сайта, видимость оставлена для всех." : "Доступ сохранён" };
}

export async function testSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || !(await canAccessSiteAccess(me, id))) return { error: "Доступ не найден" };
  if (!c.username || !c.appPasswordEnc) return { error: "Сначала введите логин WordPress и Application Password и сохраните сайт" };
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
  revalidatePath("/pinterest/pins/sites");
  redirect("/sites");
}
