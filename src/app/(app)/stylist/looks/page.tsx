import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ItemPhoto } from "@/components/stylist/ItemCard";
import { createLook } from "@/actions/stylist";
import { BASE_PATH, money } from "@/lib/stylist/consts";
import { activeLook, canSee, listLooks, lookTotals } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistLooks() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const [looks, active] = await Promise.all([listLooks(me), activeLook(me)]);
  return (
    <>
      <StNav />
      <PageHeader title="Образы" subtitle="Сохранённые образы: вещи из разных магазинов, общая цена и аналоги к каждой вещи." />
      <Card className="mb-5" title="Новый образ">
        <ActionForm action={createLook} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-muted">Название</span>
            <input name="name" placeholder="например, Осень · офис · Анна" className="input sm:!w-[340px]" />
          </label>
          <SubmitButton>Создать и собирать</SubmitButton>
        </ActionForm>
      </Card>
      {looks.length === 0 ? (
        <Empty title="Образов пока нет" hint="Создайте образ или просто нажмите «В образ» на вещи в каталоге." action={<Link href={BASE_PATH} className="btn-primary">В каталог</Link>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {looks.map((l) => {
            const t = lookTotals(l);
            const main = l.items.filter((p) => !p.parentId);
            return (
              <Link key={l.id} href={`${BASE_PATH}/looks/${l.id}`} className="card card-hover flex flex-col gap-3 p-4">
                <div className="grid grid-cols-4 gap-1.5">
                  {main.slice(0, 4).map((p) => <div key={p.id} className="aspect-[3/4] overflow-hidden rounded-lg bg-ink/5"><ItemPhoto item={p.item} /></div>)}
                  {main.length === 0 && <div className="col-span-4 flex aspect-[4/1] items-center justify-center rounded-lg bg-ink/5 text-[13px] text-muted">пока пусто</div>}
                </div>
                <div>
                  <div className="flex items-center gap-2 font-semibold">{l.name}{active?.id === l.id && <span className="badge bg-brand-soft text-warn">собирается</span>}</div>
                  <div className="mt-0.5 text-[13px] text-muted">
                    {t.pieces} вещ.{main.length > 4 ? ` (+${main.length - 4} на фото не вошли)` : ""} · {t.native ? `${money(t.native.sum, t.native.currency)} ≈ ` : ""}{money(t.eur, "EUR")}
                    {t.outOfStock > 0 && <span className="text-danger"> · нет в наличии: {t.outOfStock}</span>}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
