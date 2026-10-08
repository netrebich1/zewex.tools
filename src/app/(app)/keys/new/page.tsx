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
          <SubmitButton className="btn-brand" pendingText="Сохраняю и проверяю…">Сохранить ключ</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
