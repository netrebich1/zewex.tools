import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteUser, inviteUser, resetUserPassword, updateUser } from "@/actions/admin";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireAdmin();
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { memberships: { include: { team: { select: { name: true } } } }, _count: { select: { apiKeys: true } } } });
  const appUrl = process.env.APP_URL ?? "";
  return (
    <>
      <PageHeader title="Пользователи" subtitle="Регистрация закрыта. Новые люди попадают только по ссылке-приглашению." />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {users.map((u) => {
            const pending = !u.passwordHash;
            const inviteOk = pending && u.inviteToken && u.inviteExpires && u.inviteExpires > new Date();
            return (
              <Card key={u.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-[16px]">{u.name} {u.id === me.id && <span className="help">(вы)</span>}</div>
                    <div className="help">{u.email} · с {fmtDate(u.createdAt)}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge tone={u.role === "ADMIN" ? "ink" : "neutral"}>{u.role === "ADMIN" ? "админ" : "участник"}</Badge>
                      {!u.isActive && <Badge tone="danger">отключён</Badge>}
                      {pending && (inviteOk ? <Badge tone="warn">ждёт регистрации</Badge> : <Badge tone="danger">приглашение истекло</Badge>)}
                      {u.memberships.map((m) => <Badge key={m.teamId} tone="brand">{m.team.name}</Badge>)}
                      {u._count.apiKeys > 0 && <Badge>личных ключей: {u._count.apiKeys}</Badge>}
                    </div>
                    {inviteOk && <p className="mt-2 text-[12.5px] break-all font-mono bg-ink/5 rounded-lg px-2 py-1">{appUrl}/invite/{u.inviteToken}</p>}
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="text-[13px] text-muted cursor-pointer hover:text-ink">Управление</summary>
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    <ActionForm action={updateUser} className="flex flex-wrap items-end gap-2" hidden={{ id: u.id }}>
                      <div className="flex-1 min-w-[140px]"><Field label="Имя"><input name="name" className="input" defaultValue={u.name} /></Field></div>
                      <div className="w-32"><Field label="Роль"><select name="role" className="input" defaultValue={u.role}><option value="MEMBER">участник</option><option value="ADMIN">админ</option></select></Field></div>
                      <div className="w-32"><Field label="Доступ"><select name="isActive" className="input" defaultValue={u.isActive ? "1" : "0"}><option value="1">открыт</option><option value="0">закрыт</option></select></Field></div>
                      <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                    </ActionForm>
                    {u.id !== me.id && (
                      <div className="flex flex-wrap items-end gap-2">
                        {pending ? (
                          <ActionForm action={inviteUser} className="inline" hidden={{ email: u.email, name: u.name, role: u.role }}>
                            <SubmitButton className="btn-ghost btn-sm" pendingText="…">Новая ссылка-приглашение</SubmitButton>
                          </ActionForm>
                        ) : (
                          <ActionForm action={resetUserPassword} className="flex items-end gap-2" hidden={{ id: u.id }}>
                            <div className="w-44"><Field label="Задать пароль"><input name="password" className="input" minLength={8} placeholder="новый пароль" /></Field></div>
                            <SubmitButton className="btn-ghost btn-sm" pendingText="…">Задать</SubmitButton>
                          </ActionForm>
                        )}
                        <ActionForm action={deleteUser} className="inline" hidden={{ id: u.id }}>
                          <SubmitButton className="btn-danger btn-sm" confirm={`Удалить пользователя ${u.email}?`} pendingText="…">Удалить</SubmitButton>
                        </ActionForm>
                      </div>
                    )}
                  </div>
                </details>
              </Card>
            );
          })}
        </div>
        <Card title="Пригласить" description="Создаётся ссылка на 7 дней. Отправьте её человеку любым способом, он сам задаст пароль.">
          <ActionForm action={inviteUser}>
            <Field label="Почта"><input name="email" type="email" className="input" required placeholder="partner@example.com" /></Field>
            <Field label="Имя"><input name="name" className="input" placeholder="Как отображать" /></Field>
            <Field label="Роль">
              <select name="role" className="input" defaultValue="MEMBER">
                <option value="MEMBER">Участник: видит инструменты, свои ключи и расход</option>
                <option value="ADMIN">Админ: полные права, как у вас</option>
              </select>
            </Field>
            <SubmitButton className="btn-brand w-full" pendingText="…">Создать приглашение</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
