import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { saveClient } from "@/actions/stylist";
import { BASE_PATH } from "@/lib/stylist/consts";
import { canSee, teamId } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistClients() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const clients = await prisma.stClient.findMany({
    where: me.role === "ADMIN" ? {} : { teamId: (await teamId()) ?? "-" },
    orderBy: { name: "asc" },
    include: { _count: { select: { looks: true, collections: true } } },
  });
  return (
    <>
      <StNav />
      <PageHeader title="Клиенты" subtitle="Карточка клиента: рост, вес, размеры и замеры. К клиенту привязываются коллекции и образы — тогда в образе сразу видно, есть ли вещь в его размере." />
      <Card className="mb-5" title="Новый клиент">
        <ActionForm action={saveClient} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
            <span className="text-muted">Имя</span>
            <input name="name" required maxLength={200} placeholder="например, Анна К." className="input" />
          </label>
          <SubmitButton>Создать карточку</SubmitButton>
        </ActionForm>
      </Card>
      {clients.length === 0 ? <Empty title="Клиентов пока нет" hint="Создайте карточку и впишите размеры — их можно дополнить позже." /> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <Link key={c.id} href={`${BASE_PATH}/clients/${c.id}`} className="card card-hover flex flex-col gap-1.5 p-4">
              <div className="text-[16px] font-semibold">{c.name}</div>
              <div className="text-[13px] text-ink-2">
                {[c.height ? `рост ${c.height} см` : "", c.weight ? `вес ${c.weight} кг` : ""].filter(Boolean).join(" · ") || "рост и вес не указаны"}
              </div>
              <div className="text-[13px] text-ink-2">
                {[c.sizeTop && `верх ${c.sizeTop}`, c.sizeBottom && `низ ${c.sizeBottom}`, c.sizeShoes && `обувь ${c.sizeShoes}`].filter(Boolean).join(" · ") || "размеры не указаны"}
              </div>
              <div className="text-[12px] text-muted">коллекций: {c._count.collections} · образов: {c._count.looks}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
