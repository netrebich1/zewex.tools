import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { artSiteWhere, canAccessArtSite } from "@/lib/articles/access";
import { automationPayload, canEditGlobalSettings, canEditTeamSettings, patchSiteAutomation, saveArtSettings, saveTeamAutostart, validateSitePatch, validateTeamPatch, type ArtGlobalSettings } from "@/lib/articles/automation";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Строки сайтов со счётчиками и диагностикой, итоги, глобальные настройки, воркер — для экрана «Автозапуск сайтов». */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  return NextResponse.json(await automationPayload(me), NO_STORE);
}

type Body =
  | { siteId: string; patch: unknown }
  | { all: true; patch: unknown }
  | { global: Partial<ArtGlobalSettings> }
  | { team: { teamId: string; patch: unknown } };

/**
 * PATCH {siteId, patch} — настройки одного сайта; {all: true, patch} — всех видимых сайтов;
 * {global: {...}} — выключатели всей системы и общий потолок (только админ);
 * {team: {teamId, patch}} — выключатели, потолок и режим очереди команды (админ или лидер этой команды).
 * patch = {autostart?: {...}, aiModeration?: {...}} — только присланные поля (пределы — SITE_LIMITS, как в форме настроек сайта;
 * устаревшее autoRestart игнорируется). Запись — patchSiteAutomation со сравнением по updatedAt. В ответе — свежие данные как в GET.
 */
export async function PATCH(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  if ("global" in body) {
    if (!canEditGlobalSettings(me)) return NextResponse.json({ error: "Выключатели всей системы меняет администратор; у команды — свои" }, { status: 403 });
    const g = body.global;
    if (!g || typeof g !== "object") return NextResponse.json({ error: "Пустой патч" }, { status: 400 });
    if ("maxConcurrent" in g && (typeof g.maxConcurrent !== "number" || g.maxConcurrent < 0 || g.maxConcurrent > 300)) return NextResponse.json({ error: "Общий потолок — число от 0 до 300" }, { status: 400 });
    if ("aiModAutoBatch" in g && (typeof g.aiModAutoBatch !== "number" || g.aiModAutoBatch < 1 || g.aiModAutoBatch > 200)) return NextResponse.json({ error: "Пачка ИИ-модерации — число от 1 до 200" }, { status: 400 });
    await saveArtSettings(g);
    return NextResponse.json(await automationPayload(me), NO_STORE);
  }

  if ("team" in body) {
    const teamId = body.team?.teamId;
    if (typeof teamId !== "string" || !teamId) return NextResponse.json({ error: "Укажите команду" }, { status: 400 });
    if (!canEditTeamSettings(me, teamId)) return NextResponse.json({ error: "Настройки команды меняет администратор или лидер этой команды" }, { status: 403 });
    const t = validateTeamPatch(body.team.patch);
    if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
    if (!(await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }))) return NextResponse.json({ error: "Команда не найдена" }, { status: 404 });
    await saveTeamAutostart(teamId, t.patch);
    return NextResponse.json(await automationPayload(me), NO_STORE);
  }

  const v = validateSitePatch((body as { patch?: unknown }).patch);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  if ("all" in body && body.all === true) {
    const sites = await prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true } });
    for (const s of sites) await patchSiteAutomation(s.id, v.patch);
    return NextResponse.json(await automationPayload(me), NO_STORE);
  }

  if ("siteId" in body && typeof body.siteId === "string") {
    const site = await prisma.artSite.findUnique({ where: { id: body.siteId }, select: { teamId: true, accessId: true } });
    if (!site || !(await canAccessArtSite(me, site))) return NextResponse.json({ error: "Сайт не найден или нет доступа" }, { status: 404 });
    await patchSiteAutomation(body.siteId, v.patch);
    return NextResponse.json(await automationPayload(me), NO_STORE);
  }

  return NextResponse.json({ error: "Укажите siteId, all: true или global" }, { status: 400 });
}
