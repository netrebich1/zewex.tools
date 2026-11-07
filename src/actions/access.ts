"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canManageTeam } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { testConnection } from "@/lib/pins/wp/client";
import { assertPublicUrl } from "@/lib/pins/fetch";
import { removePath, runDir } from "@/lib/pins/storage";
import { purgeArticleFiles } from "@/lib/articles/storage";
import { siteDeletionImpact } from "@/lib/sites/delete";
import { canAccessSiteAccess, canEditAccess, canEditSiteAccess } from "@/lib/sites/access";
import { forSitesTab, seesAllSites } from "@/lib/permissions";

export type FormState = { error?: string; ok?: string; link?: { href: string; label: string } };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
/** Хост без протокола, www и регистра: «https://www.Site.com/» и «http://site.com» — один сайт. */
const hostOf = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Переносит на команду teamId всё, что висит на доступе: сайты пинов, статей и блога, их запуски, выгрузки, ошибки и задания DeepL. Расходы (UsageLog) остаются за командой, которая платила. */
async function moveSiteData(tx: Tx, accessId: string, teamId: string) {
  const pin = (await tx.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true } })).map((s) => s.id);
  const art = (await tx.artSite.findMany({ where: { accessId }, select: { id: true } })).map((s) => s.id);
  const blog = (await tx.blogSite.findMany({ where: { accessId }, select: { id: true } })).map((s) => s.id);
  const data = { teamId };
  await tx.pinJob.updateMany({ where: { run: { siteId: { in: pin } } }, data });
  await tx.pinRun.updateMany({ where: { siteId: { in: pin } }, data });
  await tx.pinExportLog.updateMany({ where: { siteId: { in: pin } }, data });
  await tx.pinStyleExclusion.updateMany({ where: { siteId: { in: pin } }, data });
  await tx.pinStyleOverride.updateMany({ where: { siteId: { in: pin } }, data });
  await tx.artSite.updateMany({ where: { id: { in: art } }, data });
  await tx.artRun.updateMany({ where: { siteId: { in: art } }, data });
  await tx.article.updateMany({ where: { siteId: { in: art } }, data });
  await tx.artError.updateMany({ where: { siteId: { in: art } }, data });
  await tx.artFailedKeyword.updateMany({ where: { siteId: { in: art } }, data });
  await tx.artPhotoFingerprint.updateMany({ where: { siteId: { in: art } }, data });
  await tx.artAiModerationRun.updateMany({ where: { siteId: { in: art } }, data });
  await tx.blogSite.updateMany({ where: { id: { in: blog } }, data });
  await tx.blogRun.updateMany({ where: { siteId: { in: blog } }, data });
  await tx.blogPost.updateMany({ where: { siteId: { in: blog } }, data });
  await tx.blogError.updateMany({ where: { siteId: { in: blog } }, data });
  await tx.blogPhotoFingerprint.updateMany({ where: { siteId: { in: blog } }, data });
  await tx.deeplJob.updateMany({ where: { accessId }, data });
}

/**
 * Доступ к сайту (уровень системы): REST API WordPress, команда-владелец, дополнительные команды,
 * сервисы (projects, пусто = всем) и видимость — список сотрудников (пусто = вся команда).
 */
export async function saveSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  // Право «все сайты только на вкладке „Сайты“» здесь действует как «все сайты»: действие вызывается с этой вкладки.
  const me = forSitesTab(await requireUser());
  const id = str(f, "id");
  const teamId = str(f, "teamId");
  if (!seesAllSites(me) && !canManageTeam(me, teamId) && !me.teamIds.includes(teamId)) return { error: "Нет доступа к команде" };
  const before = id ? await prisma.siteAccess.findUnique({ where: { id }, select: { teamId: true, baseUrl: true, teams: { select: { teamId: true } }, viewers: { select: { userId: true } } } }) : null;
  if (id && !before) return { error: "Доступ не найден" };
  if (before && !canEditAccess(me, before)) return { error: "Менять этот сайт может лидер команды-владельца или админ" };
  const baseUrl = str(f, "baseUrl").replace(/\/+$/, "");
  const username = str(f, "username");
  const appPassword = str(f, "appPassword");
  if (!baseUrl || !username) return { error: "Укажите адрес сайта и логин" };
  if (!/^https?:\/\//.test(baseUrl)) return { error: "Адрес должен начинаться с http(s)://" };
  // Второй доступ к тому же сайту не создаём (2026-11-01): пины, статьи и проекты остаются привязаны к первому,
  // и новый пароль до них не доходит — так встал прогон inspiration-for-home.com. Пароль меняют в существующем доступе.
  // Проверка — при создании и при смене адреса: уже существующие пары можно править как раньше.
  const host = hostOf(baseUrl);
  const twin = before && hostOf(before.baseUrl) === host ? undefined : (await prisma.siteAccess.findMany({ where: { kind: "wordpress", baseUrl: { contains: host }, ...(id ? { id: { not: id } } : {}) }, select: { id: true, baseUrl: true } })).find((a) => hostOf(a.baseUrl) === host);
  if (twin) {
    const visible = await canAccessSiteAccess(me, twin.id);
    return {
      error: `Сайт ${host} уже есть в «Сайтах». Второй доступ не создаём: пины, статьи и проекты привязаны к существующему, и новый пароль до них не дойдёт. Откройте существующий сайт и обновите логин и Application Password там.${visible ? "" : " Он принадлежит другой команде — попросите её лидера или админа."}`,
      ...(visible ? { link: { href: `/sites/${twin.id}`, label: `Открыть ${host}` } } : {}),
    };
  }
  try {
    await assertPublicUrl(baseUrl);
    if (str(f, "mediaBaseUrl")) await assertPublicUrl(str(f, "mediaBaseUrl"));
  } catch (e) { return fail(e); }
  const projects = f.getAll("projects").map(String).filter(Boolean);
  // Дополнительные команды: только те, где пользователь состоит (админ — любые); владелец не дублируется.
  // Команды, которых нет в форме у этого пользователя (он в них не состоит), сохраняются как были — иначе при сохранении они бы слетели.
  const hiddenTeams = seesAllSites(me) ? [] : (before?.teams ?? []).map((t) => t.teamId).filter((t) => !me.teamIds.includes(t));
  const extraTeams = [...new Set([...f.getAll("teamIds").map(String).filter((t) => t && (seesAllSites(me) || me.teamIds.includes(t))), ...hiddenTeams])].filter((t) => t !== teamId);
  const allTeams = [teamId, ...extraTeams];
  // Видимость: только участники выбранных команд.
  const wantViewers = [...new Set(f.getAll("viewerIds").map(String).filter(Boolean))];
  const pickedViewers = wantViewers.length
    ? (await prisma.teamMember.findMany({ where: { teamId: { in: allTeams }, userId: { in: wantViewers } }, select: { userId: true }, distinct: ["userId"] })).map((m) => m.userId)
    : [];
  // Сотрудник видит только свои сайты: тот, кто создаёт или правит сайт, остаётся в списке видящих
  // (иначе он сам потеряет сайт). Админу, лидеру команды-владельца и тому, кто видит все сайты, это не нужно —
  // а сотруднику с правом «все сайты только на вкладке „Сайты“» нельзя: иначе он получил бы сайт и в инструментах.
  const keepsSelf = !seesAllSites(me) && !canManageTeam(me, teamId);
  // Сотрудники других команд, которых форма этому пользователю не показывает, тоже сохраняются как были.
  const formUsers = seesAllSites(me) ? null : new Set((await prisma.teamMember.findMany({ where: { teamId: { in: me.teamIds } }, select: { userId: true } })).map((m) => m.userId));
  const hiddenViewers = formUsers ? (before?.viewers ?? []).map((v) => v.userId).filter((u) => !formUsers.has(u)) : [];
  const kept = [...new Set([...pickedViewers, ...hiddenViewers])];
  const viewers = keepsSelf && !kept.includes(me.id) ? [...kept, me.id] : kept;
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
      // Смена владельца переносит и сайты остальных инструментов вместе с их историей.
      if (before && before.teamId !== teamId) await moveSiteData(tx, aid, teamId);
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
  return { ok: wantViewers.length && !viewers.length ? "Доступ сохранён. Выбранные сотрудники не состоят в командах сайта: сайт видят только лидеры команд и админы." : "Доступ сохранён" };
}

export async function testSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = forSitesTab(await requireUser());
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || !(await canAccessSiteAccess(me, id))) return { error: "Доступ не найден" };
  if (!c.username || !c.appPasswordEnc) return { error: "Сначала введите логин WordPress и Application Password и сохраните сайт" };
  const r = await testConnection({ baseUrl: c.baseUrl, username: c.username, appPassword: decryptSecret(c.appPasswordEnc) });
  await prisma.siteAccess.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckOk: r.ok, lastCheckNote: r.note } });
  revalidatePath(`/sites/${id}`);
  return r.ok ? { ok: r.note } : { error: r.note };
}

/**
 * Удаление сайта целиком: доступ, сайт в Pinterest Pins (доски, наборы, прогоны, пины и их картинки) и сайт в Статьях
 * (запуски, статьи и их фото). В самом WordPress ничего не трогаем. Нужно второе подтверждение — название сайта в поле `confirm`.
 */
export async function deleteSiteAccess(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const c = await prisma.siteAccess.findUnique({ where: { id } });
  if (!c || !canManageTeam(me, c.teamId)) return { error: "Нет прав" };
  if (str(f, "confirm").toLowerCase() !== c.name.trim().toLowerCase()) return { error: "Название сайта введено неверно: удаление отменено" };
  const impact = await siteDeletionImpact(id);
  if (impact.activePinRuns || impact.activeArticles) {
    const busy = [impact.activePinRuns ? `прогонов пинов в работе: ${impact.activePinRuns}` : "", impact.activeArticles ? `статей в работе: ${impact.activeArticles}` : ""].filter(Boolean).join(", ");
    return { error: `Сейчас по сайту идёт работа (${busy}). Остановите её или дождитесь окончания и повторите.` };
  }
  try {
    await prisma.$transaction([
      prisma.pinRun.deleteMany({ where: { siteId: { in: impact.pinSiteIds } } }),
      prisma.pinUrlHistory.deleteMany({ where: { siteId: { in: impact.pinSiteIds } } }),
      prisma.pinExportLog.deleteMany({ where: { siteId: { in: impact.pinSiteIds } } }),
      prisma.prjUpload.deleteMany({ where: { pinSiteId: { in: impact.pinSiteIds } } }),
      prisma.pinSite.deleteMany({ where: { id: { in: impact.pinSiteIds } } }),
      prisma.artPhotoFingerprint.deleteMany({ where: { siteId: { in: impact.artSiteIds } } }),
      prisma.artError.deleteMany({ where: { siteId: { in: impact.artSiteIds } } }),
      prisma.artSite.deleteMany({ where: { id: { in: impact.artSiteIds } } }),
      prisma.siteAccess.delete({ where: { id } }),
    ]);
  } catch (e) { return fail(e); }
  // Файлы убираем после базы: если что-то не удалилось, останется только мусор на диске, а не битые записи.
  await Promise.all([
    ...impact.pinRunIds.map((runId) => removePath(runDir(runId)).catch(() => {})),
    ...impact.articleIds.map((articleId) => purgeArticleFiles(articleId).catch(() => {})),
  ]);
  revalidatePath("/sites");
  revalidatePath("/pinterest/pins/sites");
  revalidatePath("/pinterest/articles");
  redirect("/sites");
}

/**
 * Отключить инструмент от сайта или подключить снова. Отключение — архив в самом инструменте (`isActive=false`):
 * сайт пропадает из новых прогонов, выгрузки и автозапуска, но настройки, прогоны, пины и статьи остаются,
 * и «Подключить снова» возвращает всё как было. Пока по сайту в инструменте идёт работа, отключить нельзя.
 */
export async function setSiteToolActive(_p: FormState, f: FormData): Promise<FormState> {
  const me = forSitesTab(await requireUser());
  const accessId = str(f, "accessId");
  const tool = str(f, "tool");
  const on = str(f, "on") === "1";
  if (tool !== "pins" && tool !== "articles" && tool !== "blog") return { error: "Неизвестный инструмент" };
  const access = await prisma.siteAccess.findUnique({ where: { id: accessId }, select: { id: true, projects: true } });
  if (!access || !(await canAccessSiteAccess(me, accessId))) return { error: "Сайт не найден" };
  if (!(await canEditSiteAccess(me, accessId))) return { error: "Подключать и отключать инструменты может лидер команды-владельца или админ" };
  const label = tool === "pins" ? "Pinterest Pins" : tool === "blog" ? "Pin Blog Article" : "Статьи";
  const slug = tool === "pins" ? "pins" : tool === "blog" ? "blog" : "articles";
  const pr = (access.projects as string[] | null) ?? [];
  if (on && pr.length && !pr.includes(slug)) return { error: `Сначала отметьте «${label}» в списке инструментов сайта выше и сохраните сайт` };
  try {
    if (tool === "pins") {
      const sites = await prisma.pinSite.findMany({ where: { wpConnectionId: accessId }, select: { id: true } });
      if (!sites.length) return { error: "Pinterest Pins для этого сайта ещё не включали" };
      const ids = sites.map((s) => s.id);
      if (!on) {
        const busy = await prisma.pinRun.count({ where: { siteId: { in: ids }, status: { in: ["QUEUED", "RUNNING"] } } });
        if (busy) return { error: `По сайту идут прогоны пинов (${busy}). Остановите их или дождитесь окончания, потом отключайте.` };
      }
      await prisma.pinSite.updateMany({ where: { id: { in: ids } }, data: { isActive: on } });
      ids.forEach((id) => revalidatePath(`/pinterest/pins/sites/${id}`));
      revalidatePath("/pinterest/pins");
    } else if (tool === "blog") {
      const sites = await prisma.blogSite.findMany({ where: { accessId }, select: { id: true } });
      if (!sites.length) return { error: "Pin Blog Article для этого сайта ещё не включали" };
      const ids = sites.map((s) => s.id);
      if (!on) {
        const busy = await prisma.blogPost.count({ where: { siteId: { in: ids }, status: { in: ["RUNNING", "PUBLISHING"] } } });
        if (busy) return { error: `Сейчас пишутся или публикуются инфо-статьи сайта (${busy}). Дождитесь окончания, потом отключайте.` };
      }
      await prisma.blogSite.updateMany({ where: { id: { in: ids } }, data: { isActive: on } });
      ids.forEach((id) => revalidatePath(`/pinterest/blog/sites/${id}`));
      revalidatePath("/pinterest/blog");
    } else {
      const sites = await prisma.artSite.findMany({ where: { accessId }, select: { id: true } });
      if (!sites.length) return { error: "Статьи для этого сайта ещё не включали" };
      const ids = sites.map((s) => s.id);
      if (!on) {
        const busy = await prisma.article.count({ where: { siteId: { in: ids }, status: { in: ["RUNNING", "PUBLISHING"] } } });
        if (busy) return { error: `Сейчас пишутся или публикуются статьи сайта (${busy}). Дождитесь окончания, потом отключайте.` };
      }
      await prisma.artSite.updateMany({ where: { id: { in: ids } }, data: { isActive: on } });
      ids.forEach((id) => revalidatePath(`/pinterest/articles/sites/${id}`));
      revalidatePath("/pinterest/articles");
    }
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${accessId}`);
  revalidatePath("/sites");
  return { ok: on ? `${label} снова подключён: настройки и история на месте` : `${label} отключён. Настройки и история сохранены, подключить можно в любой момент.` };
}
