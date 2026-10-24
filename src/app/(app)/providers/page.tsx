import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createProvider } from "@/actions/admin";
import { redirect } from "next/navigation";
import { canManageProviders, canViewProviders } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const me = await requireUser();
  if (!canViewProviders(me)) redirect("/?denied=1");
  const providers = await prisma.provider.findMany({ orderBy: { order: "asc" }, include: { _count: { select: { apiKeys: true, bindings: true } }, models: { select: { isEnabled: true } } } });
  return (
    <>
      <PageHeader title="Провайдеры и модели" subtitle="LLM-провайдеры имеют каталог моделей. Провайдеры данных (SERP, SEO) работают без моделей." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => {
          const enabled = p.models.filter((m) => m.isEnabled).length;
          return (
            <Link key={p.id} href={`/providers/${p.slug}`} className={`card p-4 hover:border-brand transition ${p.isActive ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-[16px]">{p.name}</h3>
                <Badge tone={p.kind === "LLM" ? "ink" : "brand"}>{p.kind === "LLM" ? "LLM" : "данные"}</Badge>
              </div>
              <p className="help mt-1 truncate">{p.baseUrl}</p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
                <span>Ключей: <b className="text-ink">{p._count.apiKeys}</b></span>
                {p.kind === "LLM" && <span>Моделей: <b className="text-ink">{enabled}</b> / {p.models.length}</span>}
                <span>Правил: <b className="text-ink">{p._count.bindings}</b></span>
              </div>
            </Link>
          );
        })}
      </div>
      {canManageProviders(me) && (
        <Card className="mt-6 max-w-2xl" title="Добавить OpenAI-совместимого провайдера" description="Подходит для любого реселлера с API в стиле OpenAI (chat/completions, Bearer-ключ).">
          <ActionForm action={createProvider}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Название"><input name="name" className="input" required placeholder="Например, Together AI" /></Field>
              <Field label="Базовый адрес API"><input name="baseUrl" className="input" required placeholder="https://api.example.com/v1" /></Field>
              <Field label="Эндпоинт списка моделей"><input name="modelsEndpoint" className="input" defaultValue="models" /></Field>
              <Field label="Ссылка на документацию"><input name="docsUrl" className="input" placeholder="https://…" /></Field>
            </div>
            <SubmitButton pendingText="…">Добавить провайдера</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
