import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createKey } from "@/actions/admin";

export const dynamic = "force-dynamic";

export default async function NewKeyPage() {
  const me = await requireUser();
  const providers = await prisma.provider.findMany({ where: { isActive: true }, orderBy: { order: "asc" } });
  const isAdmin = me.role === "ADMIN";
  const [projects, teams] = await Promise.all([
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.leadTeamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <>
      <PageHeader back={{ href: "/keys", label: "Ключи" }} title="Новый ключ" subtitle="Ключ хранится в зашифрованном виде, в интерфейсе виден только его хвост. После сохранения он сразу проверяется." />
      <Card className="max-w-2xl">
        <ActionForm action={createKey}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Провайдер">
              <select name="providerId" className="input" required>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Название (как вы его узнаете)"><input name="label" className="input" required placeholder="OpenRouter — основной" /></Field>
          </div>
          <Field label="Секрет" hint="Для DataForSEO введите «логин:пароль» одной строкой. Для SerpAPI — api_key.">
            <input name="secret" className="input font-mono" required autoComplete="off" placeholder="sk-…" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Месячный лимит, $ (необязательно)" hint="При достижении вызовы через этот ключ блокируются до конца месяца."><input name="monthlyLimitUsd" className="input" inputMode="decimal" placeholder="например 50" /></Field>
            {me.role === "ADMIN" ? (
              <Field label="Кому доступен">
                <select name="personal" className="input" defaultValue="0">
                  <option value="0">Общий ключ (всем по правилам)</option>
                  <option value="1">Личный (только мне)</option>
                </select>
              </Field>
            ) : <input type="hidden" name="personal" value="1" />}
          </div>
          <Field label="Заметка"><input name="notes" className="input" placeholder="Чей аккаунт, где пополнять…" /></Field>
          {(isAdmin || teams.length > 0) && (
            <div className="rounded-xl border border-line p-3 sm:p-4">
              <div className="font-medium mb-1">Где работает этот ключ</div>
              <p className="help mb-3">Отметьте сервисы и команды. Для личного ключа это не нужно: он работает по вашему личному правилу.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <span className="label">Сервисы</span>
                  <div className="space-y-1.5">{projects.map((p) => <label key={p.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="projectIds" value={p.id} className="h-4 w-4" /> {p.name}</label>)}</div>
                </div>
                <div>
                  <span className="label">Команды</span>
                  <div className="space-y-1.5">{teams.map((t) => <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="teamIds" value={t.id} className="h-4 w-4" /> {t.name}</label>)}</div>
                </div>
              </div>
            </div>
          )}
          <SubmitButton className="btn-brand" pendingText="Сохраняю и проверяю…">Сохранить ключ</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
