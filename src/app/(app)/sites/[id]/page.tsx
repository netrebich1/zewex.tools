import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessTeam } from "@/lib/pins/runs/actions";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteSiteAccess, testSiteAccess } from "@/actions/access";
import { enablePinsForSite, toggleSiteActive } from "@/actions/pins";
import { PROJECT_SLUG } from "@/lib/pins/types";
import { fmtDate } from "@/lib/utils";
import { SiteAccessForm } from "@/components/sites/SiteAccessForm";
import { PinsRecipeForm } from "@/components/sites/PinsRecipeForm";

export const dynamic = "force-dynamic";

const pinsInclude = { boards: { orderBy: { sortOrder: "asc" as const } }, sets: { orderBy: { name: "asc" as const } }, _count: { select: { runs: true } } };

/** Страница сайта: доступ REST API (команда, сервисы) и настройки Pinterest Pins. id — доступ; старые ссылки по id сайта Pinterest тоже работают. */
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const isAdmin = me.role === "ADMIN";

  let access = await prisma.siteAccess.findUnique({ where: { id } });
  let pins = access ? await prisma.pinSite.findFirst({ where: { wpConnectionId: access.id }, include: pinsInclude }) : null;
  if (!access) {
    // Ссылка по id сайта Pinterest Pins (из сервиса или старых адресов).
    pins = await prisma.pinSite.findUnique({ where: { id }, include: pinsInclude });
    if (!pins) notFound();
    if (pins.wpConnectionId) redirect(`/sites/${pins.wpConnectionId}`);
  }
  const teamId = access?.teamId ?? pins!.teamId;
  if (!canAccessTeam(me, teamId)) notFound();

  const [teams, projects, team, wps] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true } }),
    prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }),
    prisma.siteAccess.findMany({ where: { teamId, kind: "wordpress" }, orderBy: { name: "asc" }, select: { id: true, name: true, projects: true } })
      .then((rows) => rows.filter((w) => { const pr = (w.projects as string[] | null) ?? []; return !pr.length || pr.includes(PROJECT_SLUG); })),
  ]);
  const pr = (access?.projects as string[] | null) ?? [];
  const pinsAllowed = !access || !pr.length || pr.includes(PROJECT_SLUG);
  const title = access?.name ?? pins!.name;

  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title={title} subtitle={`${team?.name ?? ""}${access ? ` · ${access.baseUrl}` : ` · ${pins!.slug}`}`} actions={pins ? <><Link href={`/pinterest/pins/styles?tab=ai&site=${pins.id}`} className="btn-ghost">Стили сайта</Link><Link href={`/pinterest/pins/sites/${pins.id}`} className="btn-ghost">Открыть в Pinterest Pins</Link></> : null} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {access ? (
            <Card title="Доступ по REST API WordPress" description="Команда владеет сайтом, сервисы получают к нему доступ. Пароль хранится в зашифрованном виде.">
              <SiteAccessForm row={access} teams={teams} projects={projects} />
            </Card>
          ) : (
            <Alert tone="warn">У этого сайта нет доступа WordPress. Выберите его в поле «WordPress для медиатеки» ниже или <Link href="/sites/new" className="underline">добавьте новый сайт</Link>.</Alert>
          )}

          {pins ? (
            <PinsRecipeForm site={pins} wps={wps} />
          ) : pinsAllowed ? (
            <Card title="Pinterest Pins" description="Сервис ещё не включён для этого сайта. После включения появятся рецепт пинов и доски.">
              <ActionForm action={enablePinsForSite} hidden={{ accessId: access!.id }}>
                <SubmitButton className="btn-primary" pendingText="Включаю…">Включить Pinterest Pins</SubmitButton>
              </ActionForm>
            </Card>
          ) : (
            <Card title="Pinterest Pins" description="Сервис Pinterest Pins не отмечен в списке сервисов этого сайта. Отметьте его выше и сохраните доступ."><p className="help">Пока недоступно.</p></Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Состояние">
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Команда</dt><dd>{team?.name}</dd></div>
              {access && <div className="flex justify-between gap-3"><dt className="text-muted">Сервисы</dt><dd className="text-right">{pr.length ? pr.map((s) => projects.find((p) => p.slug === s)?.name ?? s).join(", ") : "все"}</dd></div>}
              {access && <div className="flex justify-between gap-3"><dt className="text-muted">Подключение</dt><dd>{access.lastCheckOk == null ? <span className="text-muted">не проверялось</span> : access.lastCheckOk ? <Badge tone="ok">работает</Badge> : <Badge tone="danger">ошибка</Badge>}</dd></div>}
              {pins && <div className="flex justify-between gap-3"><dt className="text-muted">Pinterest Pins</dt><dd>{pins.isActive ? <Badge tone="ok">включён</Badge> : <Badge>в архиве</Badge>}</dd></div>}
              {pins && <div className="flex justify-between gap-3"><dt className="text-muted">Досок / прогонов</dt><dd>{pins.boards.length} / {pins._count.runs}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Создан</dt><dd>{fmtDate(access?.createdAt ?? pins!.createdAt)}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              {access?.lastCheckedAt && <Alert tone={access.lastCheckOk ? "ok" : "danger"}>{access.lastCheckNote} <span className="opacity-70">({fmtDate(access.lastCheckedAt)})</span></Alert>}
              {access && (
                <ActionForm action={testSiteAccess} hidden={{ id: access.id }}>
                  <SubmitButton className="btn-ghost w-full" pendingText="Проверяю…">Проверить подключение</SubmitButton>
                </ActionForm>
              )}
              {pins && pins.isActive && <Link href={`/pinterest/pins/runs/new?site=${pins.id}`} className="btn-primary w-full">Новый прогон</Link>}
              {pins && <Link href={`/pinterest/pins/styles?tab=ai&site=${pins.id}`} className="btn-ghost w-full">Стили: примеры ИИ и Canvas</Link>}
              {pins && <Link href={`/pinterest/pins/sites/${pins.id}`} className="btn-ghost w-full">Запас пинов и прогоны</Link>}
            </div>
          </Card>
          {pins && (
            <ActionForm action={toggleSiteActive} hidden={{ id: pins.id }}>
              {pins.isActive
                ? <SubmitButton className="btn-ghost w-full" confirm="Убрать сайт из Pinterest Pins в архив? Прогоны и настройки сохранятся." pendingText="…">Pinterest Pins: в архив</SubmitButton>
                : <SubmitButton className="btn-ghost w-full" pendingText="…">Pinterest Pins: вернуть из архива</SubmitButton>}
            </ActionForm>
          )}
          {access && (
            <ActionForm action={deleteSiteAccess} hidden={{ id: access.id }}>
              <SubmitButton className="btn-danger w-full" confirm="Удалить сайт и доступ безвозвратно?" pendingText="…">Удалить сайт</SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </>
  );
}
