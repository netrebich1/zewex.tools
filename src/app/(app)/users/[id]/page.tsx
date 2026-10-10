import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { parsePermissions } from "@/lib/permissions";
import { Alert, Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addTeamMember, deleteUser, inviteUser, removeTeamMember, resetUserPassword, updateUser, updateUserPermissions } from "@/actions/admin";
import { PermissionsFields } from "@/components/PermissionsFields";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Карточка сотрудника: роль и доступ, права, команды, пароль и приглашение. Только для админа. */
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin();
  const { id } = await params;
  const [u, teams] = await Promise.all([
    prisma.user.findUnique({ where: { id }, include: { memberships: { include: { team: { select: { id: true, name: true, slug: true } } }, orderBy: { createdAt: "asc" } }, apiKeys: { select: { id: true, label: true, provider: { select: { name: true } } } } } }),
    prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!u) notFound();
  const pending = !u.passwordHash;
  const inviteOk = pending && u.inviteToken && u.inviteExpires && u.inviteExpires > new Date();
  const appUrl = process.env.APP_URL ?? "";
  const memberIds = new Set(u.memberships.map((m) => m.teamId));
  const isSelf = u.id === me.id;

  return (
    <>
      <PageHeader back={{ href: "/users", label: "Пользователи" }} title={u.name} subtitle={`${u.email} · с ${fmtDate(u.createdAt)}`} actions={<div className="flex gap-1.5"><Badge tone={u.role === "ADMIN" ? "ink" : "neutral"}>{u.role === "ADMIN" ? "админ" : "сотрудник"}</Badge>{!u.isActive && <Badge tone="danger">отключён</Badge>}{pending && (inviteOk ? <Badge tone="warn">ждёт регистрации</Badge> : <Badge tone="danger">приглашение истекло</Badge>)}</div>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card title="Права" description={u.role === "ADMIN" ? "Админ может всё: эти настройки не ограничивают его. Они вступят в силу, если сменить роль на «сотрудник»." : "Выберите готовый профиль или настройте каждое право отдельно. Лидер команды дополнительно получает уровень «команда» в своей команде."}>
            <ActionForm action={updateUserPermissions} hidden={{ id: u.id }}>
              <PermissionsFields value={parsePermissions(u.permissions)} />
              <SubmitButton pendingText="Сохраняю…">Сохранить права</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="Команды" description="В какой команде человек состоит и лидер ли он. Лидер управляет ключами, правилами и составом своей команды.">
            {u.memberships.length === 0 ? <p className="help">Не состоит ни в одной команде.</p> : (
              <ul className="divide-y divide-line">
                {u.memberships.map((m) => (
                  <li key={m.teamId} className="flex items-center justify-between gap-3 py-2">
                    <div><span className="font-medium">{m.team.name}</span> {m.role === "LEAD" && <Badge tone="brand">лидер</Badge>}</div>
                    <div className="flex items-center gap-1">
                      <ActionForm action={addTeamMember} className="inline" hidden={{ teamId: m.teamId, userId: u.id, slug: m.team.slug, role: m.role === "LEAD" ? "MEMBER" : "LEAD" }}>
                        <SubmitButton className="btn-ghost btn-sm" pendingText="…">{m.role === "LEAD" ? "Снять лидера" : "Сделать лидером"}</SubmitButton>
                      </ActionForm>
                      <ActionForm action={removeTeamMember} className="inline" hidden={{ teamId: m.teamId, userId: u.id, slug: m.team.slug }}>
                        <SubmitButton className="btn-ghost btn-sm" confirm={`Убрать из команды «${m.team.name}»?`} pendingText="…">Убрать</SubmitButton>
                      </ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {teams.some((t) => !memberIds.has(t.id)) && (
              <ActionForm action={addTeamMember} className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3" hidden={{ userId: u.id, slug: "" }}>
                <div className="flex-1 min-w-[180px]"><Field label="Добавить в команду">
                  <select name="teamId" className="input">{teams.filter((t) => !memberIds.has(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                </Field></div>
                <div className="w-36"><Field label="Роль"><select name="role" className="input"><option value="MEMBER">участник</option><option value="LEAD">лидер</option></select></Field></div>
                <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
              </ActionForm>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Роль и доступ">
            <ActionForm action={updateUser} hidden={{ id: u.id }}>
              <Field label="Имя"><input name="name" className="input" defaultValue={u.name} /></Field>
              <Field label="Роль">
                <select name="role" className="input" defaultValue={u.role} disabled={isSelf}>
                  <option value="MEMBER">Сотрудник: по правам выше</option>
                  <option value="ADMIN">Админ: полные права</option>
                </select>
              </Field>
              <Field label="Доступ к порталу">
                <select name="isActive" className="input" defaultValue={u.isActive ? "1" : "0"} disabled={isSelf}>
                  <option value="1">Открыт</option>
                  <option value="0">Закрыт (сессии сбрасываются)</option>
                </select>
              </Field>
              {isSelf && <><input type="hidden" name="role" value="ADMIN" /><input type="hidden" name="isActive" value="1" /></>}
              <SubmitButton pendingText="…">Сохранить</SubmitButton>
            </ActionForm>
          </Card>

          {!isSelf && (
            <Card title={pending ? "Приглашение" : "Пароль"}>
              {pending ? (
                <div className="space-y-3">
                  {inviteOk ? <p className="text-[12.5px] break-all font-mono bg-ink/5 rounded-lg px-2 py-1">{appUrl}/invite/{u.inviteToken}</p> : <Alert tone="warn">Ссылка истекла. Создайте новую.</Alert>}
                  <ActionForm action={inviteUser} className="inline" hidden={{ email: u.email, name: u.name, role: u.role }}>
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…">Новая ссылка-приглашение</SubmitButton>
                  </ActionForm>
                </div>
              ) : (
                <ActionForm action={resetUserPassword} hidden={{ id: u.id }}>
                  <Field label="Задать новый пароль" hint="Сессии пользователя будут сброшены."><input name="password" className="input" minLength={8} placeholder="не короче 8 символов" /></Field>
                  <SubmitButton className="btn-ghost btn-sm" pendingText="…">Задать пароль</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          {u.apiKeys.length > 0 && (
            <Card title="Личные ключи">
              <ul className="space-y-1 text-[14px]">{u.apiKeys.map((k) => <li key={k.id}>{k.label} <span className="help">· {k.provider.name}</span></li>)}</ul>
              <p className="help mt-2">Пока у пользователя есть личные ключи, удалить его нельзя.</p>
            </Card>
          )}

          {!isSelf && (
            <ActionForm action={deleteUser} hidden={{ id: u.id }}>
              <SubmitButton className="btn-danger w-full" confirm={`Удалить пользователя ${u.email}?`} pendingText="…">Удалить пользователя</SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </>
  );
}
