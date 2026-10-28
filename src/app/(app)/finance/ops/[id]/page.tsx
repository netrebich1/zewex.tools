import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { userNames } from "@/lib/finance/report";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { OpForm } from "@/components/finance/OpForm";
import { Card, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Правка операции. Курс: если был вписан вручную — остаётся, иначе пересчитывается по дате при сохранении. */
export default async function EditOp({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const me = await requireFinance();
  const { id } = await params;
  // Куда вернуться после сохранения: только внутри финансов, иначе в журнал.
  const raw = (await searchParams).back ?? "";
  const back = /^\/finance(\/|\?|$)/.test(raw) ? raw : "/finance/ops";
  const o = await prisma.finOp.findUnique({ where: { id }, include: { counterparty: { select: { name: true } } } });
  if (!o || o.deletedAt) notFound();
  const ctx = await financeContext(me);
  const names = await userNames([o.createdById, o.updatedById]);
  const dirs = ctx.form.dirs.some((d) => d.id === o.directionId) || !o.directionId ? ctx.form.dirs : [...ctx.form.dirs, ...ctx.refs.dirOptions.filter((d) => d.id === o.directionId)];
  return (
    <>
      <FinanceNav cur={ctx.cur} />
      <PageHeader back={{ href: back, label: back === "/finance/ops" ? "Операции" : "Назад" }} title="Изменить операцию"
        subtitle={`Внёс ${names.get(o.createdById) ?? "—"} ${fmtDate(o.createdAt)}${o.updatedById ? ` · изменил ${names.get(o.updatedById) ?? "—"} ${fmtDate(o.updatedAt)}` : ""}`} />
      <div className="max-w-lg">
        <Card>
          <OpForm
            refs={{ ...ctx.form, dirs, cats: ctx.refs.cats.filter((c) => !c.archived || c.id === o.categoryId).map((c) => ({ id: c.id, name: c.name, kind: c.kind })) }}
            onDone={back}
            initial={{
              id: o.id, type: o.type, amount: String(Number(o.amount)), currency: o.currency, date: o.date.toISOString().slice(0, 10),
              manualRate: o.rateManual ? String(+(1 / Number(o.rate)).toFixed(6)) : "",
              directionId: o.directionId ?? "", categoryId: o.categoryId ?? "", partnerId: o.partnerId, toPartnerId: o.toPartnerId ?? "",
              account: o.account ?? "", note: o.note ?? "", counterparty: o.counterparty?.name ?? "",
            }}
          />
        </Card>
      </div>
    </>
  );
}
