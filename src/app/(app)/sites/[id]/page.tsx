import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessPinSite, canSeeAccess } from "@/lib/sites/access";
import { accessFormData } from "@/lib/sites/form";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteSiteAccess, testSiteAccess } from "@/actions/access";
import { enablePinsForSite } from "@/actions/pins";
import { PROJECT_SLUG } from "@/lib/pins/types";
import { fmtDate } from "@/lib/utils";
import { SiteAccessForm } from "@/components/sites/SiteAccessForm";

export const dynamic = "force-dynamic";

const accessInclude = { teams: { select: { teamId: true } }, viewers: { select: { userId: true } } };

/**
 * Уровень системы: доступ к сайту (REST API WordPress), команды, сервисы, видимость.
 * Настройки сервисов — в самих сервисах (Pinterest Pins → Сайты). id — доступ; старые ссылки по id сайта Pinterest перенаправляются.
 */
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;

  const access = await prisma.siteAccess.findUnique({ where: { id }, include: accessInclude });
  if (!access) {
    const pins = await prisma.pinSite.findUnique({ where: { id }, select: { id: true, teamId: true, wpConnectionId: true } });
    if (!pins || !(await canAccessPinSite(me, pins))) notFound();
    redirect(pins.wpConnectionId ? `/sites/${pins.wpConnectionId}` : `/pinterest/pins/sites/${pins.id}`);
  }
  if (!canSeeAccess(me, access)) notFound();

  const [{ teams, projects, members }, pins] = await Promise.all([
    accessFormData(me),
    prisma.pinSite.findFirst({ where: { wpConnectionId: access.id }, select: { id: true, isActive: true } }),
  ]);
  const teamName = (tid: string) => teams.find((t) => t.id === tid)?.name ?? "другая команда";
  const pr = (access.projects as string[] | null) ?? [];
  const pinsAllowed = !pr.length || pr.includes(PROJECT_SLUG);

  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title={access.name} subtitle={`${teamName(access.teamId)} · ${access.baseUrl}`} actions={pins ? <Link href={`/pinterest/pins/sites/${pins.id}`} className="btn-ghost">Открыть в Pinterest Pins</Link> : null} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {(!access.username || !access.appPasswordEnc) && <Alert tone="warn">Сайт перенесён из старого сервиса: доступ к REST API ещё не введён. Укажите логин WordPress и Application Password и нажмите «Сохранить сайт», иначе загрузка картинок в медиатеку и импорт статей работать не будут.</Alert>}
          <Card title="Доступ, команды и видимость" description="Доступ по REST API WordPress вводится один раз. Здесь же — какие команды и сотрудники видят сайт и в какие инструменты он интегрирован. Пароль хранится в зашифрованном виде.">
            <SiteAccessForm row={access} teams={teams} projects={projects} members={members} />
          </Card>

          <Card title="Инструменты" description="Сайт интегрирован в инструменты ниже. Все настройки, относящиеся к инструменту, делаются внутри него.">
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <div><div className="font-medium">Pinterest Pins</div><div className="help">Доски, шаблоны ИИ- и Canvas-пинов, язык — в настройках сайта внутри инструмента.</div></div>
              <div className="ml-auto flex items-center gap-2">
                {pins ? <>{pins.isActive ? <Badge tone="ok">включён</Badge> : <Badge>в архиве</Badge>}<Link href={`/pinterest/pins/sites/${pins.id}?tab=settings`} className="btn-primary">Открыть настройки</Link></>
                  : pinsAllowed ? <ActionForm action={enablePinsForSite} hidden={{ accessId: access.id }} className="inline"><SubmitButton className="btn-primary" pendingText="Включаю…">Включить</SubmitButton></ActionForm>
                  : <span className="help">не отмечен в списке инструментов выше</span>}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Состояние">
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Владелец</dt><dd>{teamName(access.teamId)}</dd></div>
              {access.teams.length > 0 && <div className="flex justify-between gap-3"><dt className="text-muted">Также</dt><dd className="text-right">{access.teams.map((t) => teamName(t.teamId)).join(", ")}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Видят</dt><dd className="text-right">{access.viewers.length ? `${access.viewers.length} сотрудник(ов)` : "все участники"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Инструменты</dt><dd className="text-right">{pr.length ? pr.map((s) => projects.find((p) => p.slug === s)?.name ?? s).join(", ") : "все"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Подключение</dt><dd>{access.lastCheckOk == null ? <span className="text-muted">не проверялось</span> : access.lastCheckOk ? <Badge tone="ok">работает</Badge> : <Badge tone="danger">ошибка</Badge>}</dd></div>
              {pins && <div className="flex justify-between gap-3"><dt className="text-muted">Pinterest Pins</dt><dd>{pins.isActive ? <Badge tone="ok">включён</Badge> : <Badge>в архиве</Badge>}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Создан</dt><dd>{fmtDate(access.createdAt)}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              {access.lastCheckedAt && <Alert tone={access.lastCheckOk ? "ok" : "danger"}>{access.lastCheckNote} <span className="opacity-70">({fmtDate(access.lastCheckedAt)})</span></Alert>}
              <ActionForm action={testSiteAccess} hidden={{ id: access.id }}>
                <SubmitButton className="btn-ghost w-full" pendingText="Проверяю…">Проверить подключение</SubmitButton>
              </ActionForm>
            </div>
          </Card>
          <ActionForm action={deleteSiteAccess} hidden={{ id: access.id }}>
            <SubmitButton className="btn-danger w-full" confirm="Удалить сайт и доступ безвозвратно?" pendingText="…">Удалить сайт</SubmitButton>
          </ActionForm>
        </div>
      </div>
    </>
  );
}
