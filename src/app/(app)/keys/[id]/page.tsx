import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { assignKeyUsage, deleteKey, testKey, updateKey } from "@/actions/admin";
import { CAPABILITY_LABELS, SCOPE_LABELS, fmtDate, fmtMoney, monthStart } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function KeyPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const key = await prisma.apiKey.findUnique({
    where: { id },
    include: {
      provider: true, owner: { select: { id: true, name: true } },
      bindings: { include: { slot: { include: { project: true } }, team: true, user: true, model: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!key) notFound();
  const isAdmin = me.role === "ADMIN";
  if (!isAdmin && key.ownerId && key.ownerId !== me.id) notFound();
  const canEdit = isAdmin || key.ownerId === me.id;
  const spend = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, _count: true, where: { apiKeyId: id, createdAt: { gte: monthStart() } } });
  const [projects, teams] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, _count: { select: { slots: true } } } }),
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.leadTeamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const usedProjectIds = new Set(key.bindings.filter((b) => b.slot).map((b) => b.slot!.project.id));
  const usedTeamIds = new Set(key.bindings.filter((b) => b.teamId).map((b) => b.teamId as string));
  const canAssign = canEdit && !key.ownerId && (isAdmin || teams.length > 0);
  // The monthly limit only works when every call's cost is known; warn about rules where it is not.
  const limitWarning = key.monthlyLimitUsd == null ? null
    : key.provider.adapter === "SERPAPI" ? "SerpAPI не сообщает стоимость запросов, поэтому вызовы через этот ключ будут отклоняться, пока на нём стоит лимит. Снимите лимит."
    : (() => {
        const unpriced = key.bindings.filter((b) => key.provider.kind === "LLM" && (!b.model || (b.model.inputPrice == null && b.model.outputPrice == null))).map((b) => b.model?.modelId ?? "без модели");
        return unpriced.length ? `У моделей ${Array.from(new Set(unpriced)).join(", ")} не заданы цены: вызовы по этим правилам будут отклоняться, пока на ключе стоит лимит. Укажите цены на странице провайдера.` : null;
      })();

  return (
    <>
      <PageHeader back={{ href: "/keys", label: "Ключи" }} title={key.label} subtitle={`${key.provider.name} · ${key.secretHint}`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {limitWarning && <Alert tone="warn">{limitWarning}</Alert>}
          {canAssign && (
            <Card title="Подключить к сервисам и командам" description="Отметьте, где работает этот ключ. Правила создаются сами, модель берётся из настроек провайдера. Несколько ключей на одном сервисе делят нагрузку.">
              <ActionForm action={assignKeyUsage} hidden={{ id: key.id }}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <span className="label">Сервисы</span>
                    <div className="space-y-1.5">
                      {projects.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="projectIds" value={p.id} defaultChecked={usedProjectIds.has(p.id)} className="h-4 w-4" /> {p.name} <span className="help">· слотов: {p._count.slots}</span></label>
                      ))}
                      {projects.length === 0 && <p className="help">Сервисов пока нет.</p>}
                    </div>
                  </div>
                  <div>
                    <span className="label">Команды</span>
                    <div className="space-y-1.5">
                      {teams.map((t) => (
                        <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} defaultChecked={usedTeamIds.has(t.id)} className="h-4 w-4" /> {t.name}</label>
                      ))}
                    </div>
                    <p className="help mt-2">Без команд ключ станет ключом сервиса по умолчанию для всех.</p>
                  </div>
                </div>
                <SubmitButton pendingText="Подключаю…">Сохранить подключения</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card title="Где используется" description="Правила, которые ссылаются на этот ключ. Удалить ключ можно только когда список пуст.">
            {key.bindings.length === 0 ? <p className="help">Пока нигде.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Инструмент / слот</th><th>Уровень</th><th>Для кого</th><th>Модель</th></tr></thead>
                  <tbody>
                    {key.bindings.map((b) => (
                      <tr key={b.id}>
                        <td>{b.slot ? <Link href={`/projects/${b.slot.project.slug}`} className="font-medium hover:underline">{b.slot.project.name}</Link> : <span className="text-muted">все инструменты</span>}{b.slot ? <span className="text-muted"> · {b.slot.name}</span> : b.capability ? <span className="text-muted"> · {CAPABILITY_LABELS[b.capability]}</span> : null}</td>
                        <td><Badge>{SCOPE_LABELS[b.scope]}</Badge></td>
                        <td>{b.team?.name ?? b.user?.name ?? "все"}</td>
                        <td className="text-muted">{b.model?.modelId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {canEdit && (
            <Card title="Настройки ключа">
              <ActionForm action={updateKey} hidden={{ id: key.id }}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Название"><input name="label" className="input" defaultValue={key.label} /></Field>
                  <Field label="Статус">
                    <select name="status" className="input" defaultValue={key.status}>
                      <option value="ACTIVE">Активен</option>
                      <option value="DISABLED">Выключен (правила с ним пропускаются)</option>
                    </select>
                  </Field>
                  <Field label="Месячный лимит, $"><input name="monthlyLimitUsd" className="input" inputMode="decimal" defaultValue={key.monthlyLimitUsd ?? ""} placeholder="без лимита" /></Field>
                  {isAdmin && (
                    <Field label="Кому доступен">
                      <select name="personal" className="input" defaultValue={key.ownerId ? "1" : "0"}>
                        <option value="0">Общий</option>
                        <option value="1">Личный{key.owner ? ` · ${key.owner.name}` : ""}</option>
                      </select>
                    </Field>
                  )}
                </div>
                {key.provider.authType === "BASIC" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Заменить логин DataForSEO" hint="Оба поля пустые — доступ не меняется."><input name="secretLogin" className="input" autoComplete="off" placeholder="email аккаунта" /></Field>
                    <Field label="Заменить пароль API"><input name="secretPassword" className="input font-mono" autoComplete="off" placeholder="пароль из кабинета DataForSEO" /></Field>
                  </div>
                ) : (
                  <Field label="Заменить секрет" hint="Оставьте пустым, чтобы не менять."><input name="secret" className="input font-mono" autoComplete="off" placeholder="новый ключ" /></Field>
                )}
                <Field label="Заметка"><input name="notes" className="input" defaultValue={key.notes ?? ""} /></Field>
                <SubmitButton pendingText="Сохраняю…">Сохранить</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Состояние">
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Статус</dt><dd>{key.status === "ACTIVE" ? <Badge tone="ok">активен</Badge> : <Badge tone="danger">выключен</Badge>}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Чей</dt><dd>{key.owner ? `личный · ${key.owner.name}` : "общий"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Расход за месяц</dt><dd>{fmtMoney(spend._sum.costUsd ?? 0)}{key.monthlyLimitUsd != null ? ` / ${fmtMoney(key.monthlyLimitUsd)}` : ""}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Вызовов за месяц</dt><dd>{spend._count}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Создан</dt><dd>{fmtDate(key.createdAt)}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              {key.lastCheckedAt && (
                <Alert tone={key.lastCheckOk ? "ok" : "danger"}>{key.lastCheckNote} <span className="opacity-70">({fmtDate(key.lastCheckedAt)})</span></Alert>
              )}
              {canEdit && (
                <ActionForm action={testKey} hidden={{ id: key.id }} className="space-y-2">
                  <SubmitButton className="btn-ghost w-full" pendingText="Проверяю…">Проверить ключ</SubmitButton>
                </ActionForm>
              )}
            </div>
          </Card>
          {canEdit && (
            <ActionForm action={deleteKey} hidden={{ id: key.id }}>
              <SubmitButton className="btn-danger w-full" confirm="Удалить ключ безвозвратно?" pendingText="…">Удалить ключ</SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </>
  );
}
