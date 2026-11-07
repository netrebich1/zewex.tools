import { prisma } from "@/lib/db";
import { accountWhere, groupWhere, isBackfilling, requireAnalytics } from "@/lib/analytics/access";
import { oauthConfig } from "@/lib/analytics/google";
import { deleteGroupAction, refreshAccountAction, removeAccountAction, renameGroupAction, setAllPropertiesAction } from "@/actions/analytics";
import { AnalyticsNav } from "@/components/analytics/AnalyticsNav";
import { PropertiesTable, type GroupItem, type PropertyItem } from "@/components/analytics/PropertiesTable";
import { ColorPicker, NewGroupForm, ServiceAccountForm } from "@/components/analytics/SettingsForms";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Messages, PageHeader, sp, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Настройки: Google-аккаунты, какие сайты показывать, группы. */
export default async function AnalyticsSettings({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireAnalytics();
  const params = await searchParams;
  const oauth = !!oauthConfig();
  const [accounts, groups] = await Promise.all([
    prisma.gaAccount.findMany({ where: accountWhere(me), orderBy: { createdAt: "asc" }, include: { properties: { orderBy: [{ gaAccountName: "asc" }, { order: "asc" }, { name: "asc" }], include: { groups: { select: { groupId: true } } } }, user: { select: { name: true } } } }),
    prisma.gaGroup.findMany({ where: groupWhere(me), orderBy: [{ order: "asc" }, { name: "asc" }], include: { _count: { select: { properties: true } } } }),
  ]);
  const groupItems: GroupItem[] = groups.map((g) => ({ id: g.id, name: g.name, color: g.color }));
  const error = sp(params, "error") === "oauth" ? "Подключение через Google не настроено на сервере: нужны GOOGLE_OAUTH_CLIENT_ID и GOOGLE_OAUTH_CLIENT_SECRET в .env (см. docs/analytics/README.md)." : sp(params, "error");

  return (
    <>
      <PageHeader title="Настройки аналитики" subtitle="Подключите все Google-аккаунты, где есть доступ к Google Analytics, и отметьте сайты, которые хотите видеть." />
      <AnalyticsNav />
      <Messages error={error} ok={sp(params, "ok")} />

      <Card className="mb-4" title="Google-аккаунты" description="Доступ только на чтение статистики. Подключённые аккаунты видите вы и администраторы." actions={
        <>
          {oauth ? <a href="/api/analytics/oauth/start" className="btn-brand"><GoogleMark /> Подключить Google-аккаунт</a> : <span className="help max-w-xs">Кнопка появится, когда на сервере будут заданы GOOGLE_OAUTH_CLIENT_ID и GOOGLE_OAUTH_CLIENT_SECRET — инструкция в docs/analytics/README.md.</span>}
          <ServiceAccountForm />
        </>
      }>
        {!accounts.length ? (
          <div className="rounded-xl border border-dashed border-line p-5 text-[14px]">
            <p className="font-medium">Как это работает</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-2">
              <li>Нажмите «Подключить Google-аккаунт» и выберите аккаунт, в котором есть Google Analytics. Google спросит разрешение только на чтение статистики.</li>
              <li>Повторите для каждого Google-аккаунта — их может быть сколько угодно.</li>
              <li>В списке ниже отметьте сайты, которые нужно показывать. История за год загрузится за несколько минут, дальше данные обновляются раз в час.</li>
              <li>Разложите сайты по группам (например, «Кулинария», «Гемблинг») — на обзоре можно смотреть трафик по группе.</li>
            </ol>
          </div>
        ) : (
          <div className="space-y-6">
            {accounts.map((a) => {
              const live = a.properties.filter((p) => !p.removed);
              const on = live.filter((p) => p.enabled).length;
              const items: PropertyItem[] = a.properties.filter((p) => !p.removed || p.enabled).map((p) => ({ id: p.id, name: p.name, host: p.host, url: p.url, gaAccountName: p.gaAccountName, timezone: p.timezone, enabled: p.enabled, removed: p.removed, groupIds: p.groups.map((g) => g.groupId), lastSyncAt: p.lastSyncAt?.toISOString() ?? null, lastSyncError: p.lastSyncError, backfilling: p.enabled && isBackfilling(p.syncState) }));
              return (
                <section key={a.id} className="rounded-2xl border border-line">
                  <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[15px] truncate">{a.label || a.email}</span>
                        <Badge tone="neutral">{a.kind === "service" ? "сервисный аккаунт" : "Google"}</Badge>
                        {a.status !== "OK" ? <Badge tone="danger">нужно переподключить</Badge> : <Badge tone="ok">подключён</Badge>}
                      </div>
                      <div className="help truncate">{a.label ? `${a.email} · ` : ""}сайтов: {live.length}, показываем: {on}{me.role === "ADMIN" && a.user.name ? ` · подключил ${a.user.name}` : ""}{a.propertiesSyncedAt ? ` · список обновлён ${a.propertiesSyncedAt.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}` : ""}</div>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-2">
                      {live.length > 0 && on < live.length && <form action={setAllPropertiesAction}><input type="hidden" name="accountId" value={a.id} /><input type="hidden" name="enabled" value="1" /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Включить все</SubmitButton></form>}
                      {on > 0 && <form action={setAllPropertiesAction}><input type="hidden" name="accountId" value={a.id} /><input type="hidden" name="enabled" value="0" /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Выключить все</SubmitButton></form>}
                      <form action={refreshAccountAction}><input type="hidden" name="id" value={a.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="Обновляем…">Обновить список сайтов</SubmitButton></form>
                      {a.status !== "OK" && a.kind === "oauth" && oauth && <a href="/api/analytics/oauth/start" className="btn-primary btn-sm">Переподключить</a>}
                      <form action={removeAccountAction}><input type="hidden" name="id" value={a.id} /><SubmitButton className="btn-danger btn-sm" pendingText="…" confirm={`Отключить аккаунт ${a.email}? Загруженная статистика его сайтов будет удалена из кабинета.`}>Отключить</SubmitButton></form>
                    </div>
                  </div>
                  {a.lastError && <div className="px-4 pt-3"><Alert tone={a.status === "OK" ? "warn" : "danger"}>{a.lastError}</Alert></div>}
                  <div className="p-4">
                    {items.length ? <PropertiesTable items={items} groups={groupItems} /> : <p className="help">Этому аккаунту не открыт ни один ресурс Google Analytics 4.{a.kind === "service" ? " Добавьте почту сервисного аккаунта в GA с ролью «Читатель» и нажмите «Обновить список сайтов»." : ""}</p>}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Группы сайтов" description="Сайт может быть в нескольких группах. Группы — это фильтр на обзоре и странице «Страницы».">
        <div className="space-y-2 mb-4">
          {groups.map((g) => (
            <form key={g.id} action={renameGroupAction} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
              <input type="hidden" name="id" value={g.id} />
              <i className="inline-block h-3 w-3 rounded-full shrink-0" style={{ background: g.color }} />
              <input name="name" defaultValue={g.name} className="input !w-56 !py-1.5 sm:!text-[13.5px]" />
              <ColorPicker value={g.color} name="color" />
              <span className="help">{g._count.properties} {g._count.properties === 1 ? "сайт" : g._count.properties >= 2 && g._count.properties <= 4 ? "сайта" : "сайтов"}</span>
              <span className="ml-auto flex gap-2">
                <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                <SubmitButton className="btn-danger btn-sm" pendingText="…" formAction={deleteGroupAction} confirm={`Удалить группу «${g.name}»? Сайты останутся, пропадёт только метка.`}>Удалить</SubmitButton>
              </span>
            </form>
          ))}
          {!groups.length && <p className="help">Групп пока нет.</p>}
        </div>
        <NewGroupForm />
      </Card>
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.5 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
      <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.7-6c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
