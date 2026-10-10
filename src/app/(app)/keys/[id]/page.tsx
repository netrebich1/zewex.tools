import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { assignScope, canAssignGlobal, canAssignKey, canCreatePersonalKey, canCreateSharedKey, canManageKey, canViewKey, keyTeamScope } from "@/lib/permissions";
import type { KeyOwnerOption } from "@/components/KeyOwnerFields";
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
      provider: true, owner: { select: { id: true, name: true } }, team: { select: { id: true, name: true } },
      bindings: { include: { slot: { include: { project: true } }, team: true, user: true, model: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!key || !canViewKey(me, key)) notFound();
  const canEdit = canManageKey(me, key);
  const canAssign = canAssignKey(me, key);
  const assignTeams = assignScope(me);
  const keyTeams = keyTeamScope(me);
  const spend = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, _count: true, where: { apiKeyId: id, createdAt: { gte: monthStart() } } });
  const [projects, teams] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, _count: { select: { slots: true } } } }),
    prisma.team.findMany({
      where: keyTeams === "all" && assignTeams === "all" ? {} : { id: { in: [...(keyTeams === "all" ? [] : keyTeams), ...(assignTeams === "all" ? [] : assignTeams)] } },
      orderBy: { name: "asc" }, select: { id: true, name: true },
    }),
  ]);
  const usedProjectIds = [...new Set(key.bindings.filter((b) => b.slot).map((b) => b.slot!.project.id))];
  const usedTeamIds = [...new Set(key.bindings.filter((b) => b.teamId).map((b) => b.teamId as string))];
  const assignable = teams.filter((t) => assignTeams === "all" || assignTeams.includes(t.id));
  const currentOwner = key.ownerId ? "personal" : key.teamId ? `team:${key.teamId}` : "shared";
  // Варианты «чей ключ» для формы настроек: текущий всегда есть, остальные — по правам.
  const owners: KeyOwnerOption[] = [];
  if (canCreateSharedKey(me) || currentOwner === "shared") owners.push({ value: "shared", label: "Общий: всем по правилам" });
  for (const t of teams) if (keyTeams === "all" || keyTeams.includes(t.id) || key.teamId === t.id) owners.push({ value: `team:${t.id}`, label: `Команда «${t.name}»` });
  if (key.team && !owners.some((o) => o.value === `team:${key.team!.id}`)) owners.push({ value: `team:${key.team.id}`, label: `Команда «${key.team.name}»` });
  if (canCreatePersonalKey(me) || currentOwner === "personal") owners.push({ value: "personal", label: `Личный${key.owner ? ` · ${key.owner.name}` : ""}` });
  // The monthly limit only works when every call's cost is known; warn about rules where it is not.
  const limitWarning = key.monthlyLimitUsd == null ? null
    : key.provider.adapter === "SERPAPI" ? "SerpAPI не сообщает стоимость запросов, поэтому вызовы через этот ключ будут отклоняться, пока на нём стоит лимит. Снимите лимит."
    : (() => {
        const unpriced = key.bindings.filter((b) => key.provider.kind === "LLM" && (!b.model || (b.model.inputPrice == null && b.model.outputPrice == null))).map((b) => b.model?.modelId ?? "без модели");
        return unpriced.length ? `У моделей ${Array.from(new Set(unpriced)).join(", ")} не заданы цены: вызовы по этим правилам будут отклоняться, пока на ключе стоит лимит. Укажите цены на странице провайдера.` : null;
      })();
  const whose = key.owner ? `личный · ${key.owner.name}` : key.team ? `команда «${key.team.name}»` : "общий";

  return (
    <>
      <PageHeader back={{ href: "/keys", label: "Ключи" }} title={key.label} subtitle={`${key.provider.name} · ${key.secretHint} · ${whose}`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {limitWarning && <Alert tone="warn">{limitWarning}</Alert>}
          {canAssign && (
            <Card title="Подключить к сервисам и командам" description={key.teamId ? `Командный ключ: правила создаются только для команды «${key.team?.name}». Отметьте сервисы или оставьте пусто, чтобы ключ работал во всех инструментах команды.` : "Отметьте, где работает этот ключ. Правила создаются сами, модель берётся из настроек провайдера. Несколько ключей на одном сервисе делят нагрузку."}>
              <ActionForm action={assignKeyUsage} hidden={{ id: key.id }}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <span className="label">Сервисы</span>
                    <div className="space-y-1.5">
                      {projects.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="projectIds" value={p.id} defaultChecked={usedProjectIds.includes(p.id)} className="h-4 w-4" /> {p.name} <span className="help">· слотов: {p._count.slots}</span></label>
                      ))}
                      {projects.length === 0 && <p className="help">Сервисов пока нет.</p>}
                    </div>
                  </div>
                  {key.teamId ? <input type="hidden" name="teamIds" value={key.teamId} /> : (
                    <div>
                      <span className="label">Команды</span>
                      <div className="space-y-1.5">
                        {assignable.map((t) => (
                          <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} defaultChecked={usedTeamIds.includes(t.id)} className="h-4 w-4" /> {t.name}</label>
                        ))}
                      </div>
                      <p className="help mt-2">{canAssignGlobal(me) ? "Без команд ключ станет ключом сервиса по умолчанию для всех." : "Вы подключаете ключ только к своим командам: отметьте хотя бы одну."}</p>
                    </div>
                  )}
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
                  {owners.length > 1 ? (
                    <Field label="Чей ключ" hint={key.bindings.length ? "Чтобы поменять, сначала уберите ключ из правил." : undefined}>
                      <select name="owner" className="input" defaultValue={currentOwner} disabled={key.bindings.length > 0}>
                        {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </Field>
                  ) : <input type="hidden" name="owner" value={currentOwner} />}
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
              <div className="flex justify-between gap-3"><dt className="text-muted">Чей</dt><dd>{whose}</dd></div>
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
