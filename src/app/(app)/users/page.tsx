import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canViewUsers, describePermissions, parsePermissions } from "@/lib/permissions";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { inviteUser } from "@/actions/admin";
import { PermissionsFields } from "@/components/PermissionsFields";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireUser();
  if (!canViewUsers(me)) redirect("/?denied=1");
  const isAdmin = me.role === "ADMIN";
  const [users, teams] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, include: { memberships: { include: { team: { select: { name: true } } } }, _count: { select: { apiKeys: true } } } }),
    prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const appUrl = process.env.APP_URL ?? "";
  return (
    <>
      <PageHeader title="Пользователи" subtitle={isAdmin ? "Регистрация закрыта. Новые люди попадают только по ссылке-приглашению. Права каждого сотрудника настраиваются на его странице." : "Список сотрудников портала. Менять права и приглашать может только администратор."} />
      <div className={isAdmin ? "grid gap-4 lg:grid-cols-[1fr_380px]" : ""}>
        <div className="space-y-3">
          {users.map((u) => {
            const pending = !u.passwordHash;
            const inviteOk = pending && u.inviteToken && u.inviteExpires && u.inviteExpires > new Date();
            const body = (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-[16px]">{u.name} {u.id === me.id && <span className="help">(вы)</span>}</div>
                  <div className="help">{u.email} · с {fmtDate(u.createdAt)}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={u.role === "ADMIN" ? "ink" : "neutral"}>{u.role === "ADMIN" ? "админ" : describePermissions(parsePermissions(u.permissions))}</Badge>
                    {!u.isActive && <Badge tone="danger">отключён</Badge>}
                    {pending && (inviteOk ? <Badge tone="warn">ждёт регистрации</Badge> : <Badge tone="danger">приглашение истекло</Badge>)}
                    {u.memberships.map((m) => <Badge key={m.teamId} tone="brand">{m.team.name}{m.role === "LEAD" ? " · лидер" : ""}</Badge>)}
                    {u._count.apiKeys > 0 && <Badge>личных ключей: {u._count.apiKeys}</Badge>}
                  </div>
                  {isAdmin && inviteOk && <p className="mt-2 text-[12.5px] break-all font-mono bg-ink/5 rounded-lg px-2 py-1">{appUrl}/invite/{u.inviteToken}</p>}
                </div>
                {isAdmin && <span className="btn-ghost btn-sm">Настроить →</span>}
              </div>
            );
            return isAdmin
              ? <Link key={u.id} href={`/users/${u.id}`} className="card block p-4 sm:p-5 hover:border-brand transition">{body}</Link>
              : <Card key={u.id}>{body}</Card>;
          })}
        </div>
        {isAdmin && (
          <Card title="Пригласить" description="Создаётся ссылка на 7 дней. Отправьте её человеку любым способом, он сам задаст пароль.">
            <ActionForm action={inviteUser}>
              <Field label="Почта"><input name="email" type="email" className="input" required placeholder="partner@example.com" /></Field>
              <Field label="Имя"><input name="name" className="input" placeholder="Как отображать" /></Field>
              <Field label="Роль">
                <select name="role" className="input" defaultValue="MEMBER">
                  <option value="MEMBER">Сотрудник: права по профилю ниже</option>
                  <option value="ADMIN">Админ: полные права, как у вас</option>
                </select>
              </Field>
              {teams.length > 0 && (
                <div>
                  <span className="label">Команды</span>
                  <div className="space-y-1.5">
                    {teams.map((t) => <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} className="h-4 w-4" /> {t.name}</label>)}
                  </div>
                </div>
              )}
              <details className="rounded-xl border border-line p-3">
                <summary className="cursor-pointer text-[14px] font-medium">Права сотрудника</summary>
                <div className="mt-3"><PermissionsFields compact /></div>
              </details>
              <SubmitButton className="btn-brand w-full" pendingText="…">Создать приглашение</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
