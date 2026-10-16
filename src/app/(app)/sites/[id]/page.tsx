import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessPinSite, canSeeAccess } from "@/lib/sites/access";
import { accessFormData } from "@/lib/sites/form";
import { Alert, Badge, Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { setSiteToolActive, testSiteAccess, type FormState } from "@/actions/access";
import { siteDeletionImpact } from "@/lib/sites/delete";
import { enablePinsForSite } from "@/actions/pins";
import { enableArticlesForSite } from "@/actions/articles";
import { PROJECT_SLUG } from "@/lib/pins/types";
import { PROJECT_SLUG as ARTICLES_SLUG } from "@/lib/articles/types";
import { fmtDate } from "@/lib/utils";
import { SiteAccessForm } from "@/components/sites/SiteAccessForm";
import { DeleteSiteForm } from "@/components/sites/DeleteSiteForm";
import { canManageTeam } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const accessInclude = { teams: { select: { teamId: true } }, viewers: { select: { userId: true } } };

/**
 * Уровень системы: доступ к сайту (REST API WordPress), команды, сервисы, видимость.
 * Настройки сервисов — в самих сервисах (Pinterest Pins → Сайты). id — доступ; старые ссылки по id сайта Pinterest перенаправляются.
 */
export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const { id } = await params;
  const query = await searchParams;

  const access = await prisma.siteAccess.findUnique({ where: { id }, include: accessInclude });
  if (!access) {
    const pins = await prisma.pinSite.findUnique({ where: { id }, select: { id: true, teamId: true, wpConnectionId: true } });
    if (!pins || !(await canAccessPinSite(me, pins))) notFound();
    redirect(pins.wpConnectionId ? `/sites/${pins.wpConnectionId}` : `/pinterest/pins/sites/${pins.id}`);
  }
  if (!canSeeAccess(me, access)) notFound();

  const [{ teams, projects, members }, pins, articles] = await Promise.all([
    accessFormData(me),
    prisma.pinSite.findFirst({ where: { wpConnectionId: access.id }, select: { id: true, isActive: true } }),
    prisma.artSite.findFirst({ where: { accessId: access.id }, select: { id: true, isActive: true } }),
  ]);
  const teamName = (tid: string) => teams.find((t) => t.id === tid)?.name ?? "другая команда";
  const canDelete = canManageTeam(me, access.teamId);
  const impact = canDelete ? await siteDeletionImpact(access.id) : null;
  const pr = (access.projects as string[] | null) ?? [];
  const pinsAllowed = !pr.length || pr.includes(PROJECT_SLUG);
  const articlesAllowed = !pr.length || pr.includes(ARTICLES_SLUG);

  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title={access.name} subtitle={`${teamName(access.teamId)} · ${access.baseUrl}`} actions={<>{pins && <Link href={`/pinterest/pins/sites/${pins.id}`} className="btn-ghost">Открыть в Pinterest Pins</Link>}{articles && <Link href={`/pinterest/articles/sites/${articles.id}`} className="btn-ghost">Открыть в Статьях</Link>}</>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {(!access.username || !access.appPasswordEnc) && <Alert tone="warn">Сайт перенесён из старого сервиса: доступ к REST API ещё не введён. Укажите логин WordPress и Application Password и нажмите «Сохранить сайт», иначе загрузка картинок в медиатеку и импорт статей работать не будут.</Alert>}
          <Card title="Доступ, команды и видимость" description="Доступ по REST API WordPress вводится один раз. Здесь же — какие команды и сотрудники видят сайт и в какие инструменты он интегрирован. Пароль хранится в зашифрованном виде.">
            <SiteAccessForm row={access} teams={teams} projects={projects} members={members} />
          </Card>

          <Card title="Инструменты" description="Сайт подключается к инструментам ниже. Отключение ничего не удаляет: настройки и история остаются, подключить снова можно в любой момент. Все настройки инструмента делаются внутри него.">
            <div className="space-y-3">
              <ToolRow
                accessId={access.id} tool="pins" name="Pinterest Pins" allowed={pinsAllowed} site={pins}
                hint="Доски, шаблоны ИИ- и Canvas-пинов, язык — в настройках сайта внутри инструмента."
                settingsHref={pins ? `/pinterest/pins/sites/${pins.id}?tab=settings` : ""} enable={enablePinsForSite}
                offWarning="Сайт пропадёт из Pinterest Pins: новые прогоны, выгрузка и календарь запаса его не покажут, запланированные пины в выгрузку не попадут. Доски, настройки, прогоны и пины сохранятся, подключить снова можно в любой момент. Отключить?"
              />
              <ToolRow
                accessId={access.id} tool="articles" name="Статьи" allowed={articlesAllowed} site={articles}
                hint="Ниша, рецепт, количество фото, модерация, категории WordPress, автозапуск — в настройках сайта внутри инструмента."
                settingsHref={articles ? `/pinterest/articles/sites/${articles.id}?tab=settings` : ""} enable={enableArticlesForSite}
                offWarning="Сайт пропадёт из Статей: новые запуски и автозапуск остановятся, статьи в очереди будут ждать. Настройки, запуски и статьи сохранятся, подключить снова можно в любой момент. Отключить?"
              />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Состояние">
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Владелец</dt><dd>{teamName(access.teamId)}</dd></div>
              {access.teams.length > 0 && <div className="flex justify-between gap-3"><dt className="text-muted">Также</dt><dd className="text-right">{access.teams.map((t) => teamName(t.teamId)).join(", ")}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Видят</dt><dd className="text-right">{access.viewers.length ? `${access.viewers.length} сотрудник(ов) + лидеры` : "только лидеры и админы"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Инструменты</dt><dd className="text-right">{pr.length ? pr.map((s) => projects.find((p) => p.slug === s)?.name ?? s).join(", ") : "все"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Подключение</dt><dd>{access.lastCheckOk == null ? <span className="text-muted">не проверялось</span> : access.lastCheckOk ? <Badge tone="ok">работает</Badge> : <Badge tone="danger">ошибка</Badge>}</dd></div>
              {pins && <div className="flex justify-between gap-3"><dt className="text-muted">Pinterest Pins</dt><dd>{pins.isActive ? <Badge tone="ok">подключён</Badge> : <Badge>отключён</Badge>}</dd></div>}
              {articles && <div className="flex justify-between gap-3"><dt className="text-muted">Статьи</dt><dd>{articles.isActive ? <Badge tone="ok">подключён</Badge> : <Badge>отключён</Badge>}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Создан</dt><dd>{fmtDate(access.createdAt)}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              {access.lastCheckedAt && <Alert tone={access.lastCheckOk ? "ok" : "danger"}>{access.lastCheckNote} <span className="opacity-70">({fmtDate(access.lastCheckedAt)})</span></Alert>}
              <ActionForm action={testSiteAccess} hidden={{ id: access.id }}>
                <SubmitButton className="btn-ghost w-full" pendingText="Проверяю…">Проверить подключение</SubmitButton>
              </ActionForm>
            </div>
          </Card>
          {impact && (
            <DeleteSiteForm
              id={access.id}
              name={access.name}
              initialOpen={!!sp(query, "delete")}
              summary={{
                pinRuns: impact.pinRunIds.length, pins: impact.pins, articles: impact.articleIds.length,
                inPins: impact.pinSiteIds.length > 0, inArticles: impact.artSiteIds.length > 0,
                busy: impact.activePinRuns || impact.activeArticles ? "Сейчас по сайту идёт работа: остановите прогоны и статьи или дождитесь окончания, иначе удаление не пройдёт." : null,
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

/** Строка инструмента: подключить / открыть настройки и отключить / подключить снова. Отключение = архив в инструменте, данные сохраняются. */
function ToolRow({ accessId, tool, name, hint, allowed, site, settingsHref, enable, offWarning }: {
  accessId: string; tool: "pins" | "articles"; name: string; hint: string; allowed: boolean;
  site: { id: string; isActive: boolean } | null; settingsHref: string; offWarning: string;
  enable: (p: FormState, f: FormData) => Promise<FormState>;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border border-line p-3 ${site && !site.isActive ? "bg-surface-2" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">{name}{site ? (site.isActive ? <Badge tone="ok">подключён</Badge> : <Badge>отключён</Badge>) : null}</div>
        <div className="help">{site && !site.isActive ? "Сайт отключён от инструмента. Настройки и история сохранены." : hint}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!site ? (
          allowed
            ? <ActionForm action={enable} hidden={{ accessId }} className="inline"><SubmitButton className="btn-primary" pendingText="Подключаю…">Подключить</SubmitButton></ActionForm>
            : <span className="help">не отмечен в списке инструментов выше</span>
        ) : site.isActive ? (
          <>
            <Link href={settingsHref} className="btn-primary">Открыть настройки</Link>
            <ActionForm action={setSiteToolActive} hidden={{ accessId, tool, on: "0" }} className="inline">
              <SubmitButton className="btn-ghost" confirm={offWarning} pendingText="Отключаю…">Отключить</SubmitButton>
            </ActionForm>
          </>
        ) : (
          <>
            <Link href={settingsHref} className="btn-ghost">Настройки и история</Link>
            {allowed
              ? <ActionForm action={setSiteToolActive} hidden={{ accessId, tool, on: "1" }} className="inline"><SubmitButton className="btn-primary" pendingText="Подключаю…">Подключить снова</SubmitButton></ActionForm>
              : <span className="help">отметьте инструмент в списке выше, чтобы подключить снова</span>}
          </>
        )}
      </div>
    </div>
  );
}
