import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { deleteClient, saveClient } from "@/actions/stylist";
import { BASE_PATH } from "@/lib/stylist/consts";
import { MEASURES } from "@/lib/stylist/clients";
import { canSee, teamId } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistClient({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const { id } = await params;
  const c = await prisma.stClient.findFirst({
    where: { id, ...(me.role === "ADMIN" ? {} : { teamId: (await teamId()) ?? "-" }) },
    include: { collections: { orderBy: { createdAt: "desc" }, select: { id: true, name: true, _count: { select: { looks: true } } } }, looks: { orderBy: { updatedAt: "desc" }, select: { id: true, name: true, collection: { select: { name: true } } } } },
  });
  if (!c) notFound();
  const m = (c.measures ?? {}) as Record<string, string>;
  return (
    <>
      <StNav />
      <PageHeader title={c.name} back={{ href: `${BASE_PATH}/clients`, label: "Все клиенты" }} />
      <Card title="Размеры и замеры" description="Размеры пишите так, как они указаны у магазинов: буквенные и числовые через запятую — «S, 36». По ним в образах клиента видно, есть ли вещь в нужном размере.">
        <ActionForm action={saveClient} hidden={{ client: c.id }}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Имя"><input name="name" defaultValue={c.name} required maxLength={200} className="input" /></Field>
            <Field label="Рост, см"><input name="height" defaultValue={c.height ?? ""} inputMode="numeric" className="input" /></Field>
            <Field label="Вес, кг"><input name="weight" defaultValue={c.weight ?? ""} inputMode="decimal" className="input" /></Field>
            <Field label="Город" hint="где проверять наличие в магазинах"><input name="city" defaultValue={c.city} maxLength={80} placeholder="Sliema" className="input" /></Field>
            <Field label="Бюджет на образ, €"><input name="budget" defaultValue={c.budget ?? ""} inputMode="decimal" className="input" /></Field>
            <Field label="Размер верха" hint="куртки, свитеры, рубашки, платья"><input name="sizeTop" defaultValue={c.sizeTop} maxLength={40} placeholder="S, 36" className="input" /></Field>
            <Field label="Размер низа" hint="брюки, джинсы, юбки"><input name="sizeBottom" defaultValue={c.sizeBottom} maxLength={40} placeholder="M, 38" className="input" /></Field>
            <Field label="Размер обуви"><input name="sizeShoes" defaultValue={c.sizeShoes} maxLength={40} placeholder="38" className="input" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MEASURES.map((x) => <Field key={x.id} label={x.label}><input name={`m_${x.id}`} defaultValue={m[x.id] ?? ""} inputMode="decimal" maxLength={10} className="input" /></Field>)}
          </div>
          <Field label="Заметки" hint="Любимые цвета и бренды, что не носит, особенности фигуры, повод">
            <textarea name="note" defaultValue={c.note ?? ""} rows={4} className="input" />
          </Field>
          <SubmitButton>Сохранить</SubmitButton>
        </ActionForm>
      </Card>

      <Card className="mt-5" title={`Коллекции и образы клиента: ${c.collections.length + c.looks.length}`} description="Привязать коллекцию или образ к клиенту можно на странице «Образы» (у коллекции — «Изменить») и на странице образа.">
        {c.collections.length + c.looks.length === 0 ? <p className="help">Пока ничего не привязано.</p> : (
          <ul className="flex flex-col gap-1.5 text-[14px]">
            {c.collections.map((x) => <li key={x.id}>Коллекция <Link href={`${BASE_PATH}/list?collection=${x.id}`} className="font-medium underline">{x.name}</Link> <span className="text-muted">· образов: {x._count.looks}</span></li>)}
            {c.looks.map((x) => <li key={x.id}>Образ <Link href={`${BASE_PATH}/looks/${x.id}`} className="font-medium underline">{x.name}</Link>{x.collection ? <span className="text-muted"> · {x.collection.name}</span> : null}</li>)}
          </ul>
        )}
      </Card>

      <div className="mt-5">
        <ActionForm action={deleteClient} className="" hidden={{ client: c.id }}>
          <SubmitButton className="btn-danger btn-sm" confirm="Удалить карточку клиента? Коллекции и образы останутся, но без привязки.">Удалить карточку</SubmitButton>
        </ActionForm>
      </div>
    </>
  );
}
