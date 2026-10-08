import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Alert, Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteKey, testKey, updateKey } from "@/actions/admin";
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

  return (
    <>
      <PageHeader back={{ href: "/keys", label: "Ключи" }} title={key.label} subtitle={`${key.provider.name} · ${key.secretHint}`} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
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
                <Field label="Заменить секрет" hint="Оставьте пустым, чтобы не менять."><input name="secret" className="input font-mono" autoComplete="off" placeholder="новый ключ" /></Field>
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
