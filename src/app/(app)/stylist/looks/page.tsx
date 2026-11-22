import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ItemPhoto } from "@/components/stylist/ItemCard";
import { checkStock, createLook, deleteCollection, renameLook, saveCollection } from "@/actions/stylist";
import { BASE_PATH, money } from "@/lib/stylist/consts";
import { activeLook, canSee, listCollections, listLooks, lookTotals, type LookFull } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

function LookCard({ look, active }: { look: LookFull; active: boolean }) {
  const t = lookTotals(look);
  const main = look.items.filter((p) => !p.parentId);
  return (
    <div className="card flex flex-col gap-3 p-4">
      <Link href={`${BASE_PATH}/looks/${look.id}`} className="grid grid-cols-4 gap-1.5">
        {main.slice(0, 4).map((p) => <div key={p.id} className="aspect-[3/4] overflow-hidden rounded-lg bg-ink/5"><ItemPhoto item={p.item} /></div>)}
        {main.length === 0 && <div className="col-span-4 flex aspect-[4/1] items-center justify-center rounded-lg bg-ink/5 text-[13px] text-muted">пока пусто</div>}
      </Link>
      <div>
        <ActionForm action={renameLook} className="flex items-center gap-1.5" hidden={{ look: look.id }}>
          <input name="name" defaultValue={look.name} maxLength={200} aria-label="Название образа" title="Название можно изменить прямо здесь" className="input !py-1.5 font-semibold" />
          <SubmitButton className="btn-ghost btn-sm shrink-0" pendingText="…">Сохранить</SubmitButton>
        </ActionForm>
        {active && <span className="badge mt-1 bg-brand-soft text-warn">последний открытый</span>}
        <div className="mt-0.5 text-[13px] text-muted">
          {t.pieces} вещ.{main.length > 4 ? ` (+${main.length - 4} на фото не вошли)` : ""} · {t.native ? `${money(t.native.sum, t.native.currency)} ≈ ` : ""}{money(t.eur, "EUR")}
          {t.outOfStock > 0 && <span className="text-danger"> · нет в наличии: {t.outOfStock}</span>}
        </div>
        <Link href={`${BASE_PATH}/looks/${look.id}`} className="mt-2 inline-block text-[13px] font-medium underline">Открыть образ →</Link>
      </div>
    </div>
  );
}

export default async function StylistLooks() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const [looks, collections, active] = await Promise.all([listLooks(me), listCollections(me), activeLook(me)]);
  const loose = looks.filter((l) => !l.collectionId);
  const sum = (list: LookFull[]) => Math.round(list.reduce((s, l) => s + lookTotals(l).eur, 0) * 100) / 100;

  return (
    <>
      <StNav />
      <PageHeader title="Образы" subtitle="Коллекции — это подборки образов (под клиента, сезон или повод). В образе — вещи из разных магазинов, общая цена и аналоги; одна вещь может быть в нескольких образах." />

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <Card title="Новая коллекция">
          <ActionForm action={saveCollection} className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
              <span className="text-muted">Название</span>
              <input name="name" required maxLength={200} placeholder="например, Анна · осень 2026" className="input" />
            </label>
            <SubmitButton>Создать коллекцию</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Новый образ">
          <ActionForm action={createLook} className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px]">
              <span className="text-muted">Название</span>
              <input name="name" placeholder="например, Образ 1 · офис" className="input" />
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted">Коллекция</span>
              <select name="collection" className="input !w-auto" defaultValue="">
                <option value="">без коллекции</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <SubmitButton>Создать и собирать</SubmitButton>
          </ActionForm>
        </Card>
      </div>

      {looks.length === 0 && collections.length === 0 && (
        <Empty title="Образов пока нет" hint="Создайте коллекцию и образ — или просто нажмите «В новый образ» на вещи в каталоге." action={<Link href={BASE_PATH} className="btn-primary">В каталог</Link>} />
      )}

      {collections.map((c) => {
        const list = looks.filter((l) => l.collectionId === c.id);
        return (
          <section key={c.id} className="mb-7">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
              <div>
                <h2 className="h2">{c.name}</h2>
                <div className="text-[13px] text-muted">образов: {list.length}{list.length ? ` · все вместе ≈ ${money(sum(list), "EUR")}` : ""}{c.note ? ` · ${c.note}` : ""}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {list.length > 0 && <Link href={`${BASE_PATH}/list?collection=${c.id}`} className="btn-brand btn-sm">Шопинг-лист</Link>}
                {list.length > 0 && (
                  <ActionForm action={checkStock} className="" hidden={{ collection: c.id }}>
                    <SubmitButton className="btn-ghost btn-sm" pendingText="Проверяю… до минуты">Проверить наличие</SubmitButton>
                  </ActionForm>
                )}
                <ActionForm action={createLook} className="" hidden={{ collection: c.id, name: `Образ ${list.length + 1}` }}>
                  <SubmitButton className="btn-primary btn-sm" pendingText="…">+ Образ {list.length + 1}</SubmitButton>
                </ActionForm>
                <details className="relative">
                  <summary className="btn-ghost btn-sm cursor-pointer list-none">Изменить</summary>
                  <div className="absolute right-0 z-10 mt-1 w-[300px] rounded-xl border border-line bg-surface p-3 shadow-lg">
                    <ActionForm action={saveCollection} className="flex flex-col gap-2" hidden={{ collection: c.id }}>
                      <input name="name" defaultValue={c.name} required maxLength={200} className="input" />
                      <input name="note" defaultValue={c.note ?? ""} maxLength={2000} placeholder="заметка: клиент, бюджет, повод" className="input" />
                      <SubmitButton className="btn-primary btn-sm">Сохранить</SubmitButton>
                    </ActionForm>
                    <div className="mt-2 border-t border-line pt-2">
                      <ActionForm action={deleteCollection} className="" hidden={{ collection: c.id }}>
                        <SubmitButton className="btn-danger btn-sm" confirm="Удалить коллекцию? Её образы останутся и перейдут в «Без коллекции».">Удалить коллекцию</SubmitButton>
                      </ActionForm>
                    </div>
                  </div>
                </details>
              </div>
            </div>
            {list.length === 0 ? <p className="help">В коллекции пока нет образов — нажмите «+ Образ 1».</p> : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{list.map((l) => <LookCard key={l.id} look={l} active={active?.id === l.id} />)}</div>
            )}
          </section>
        );
      })}

      {loose.length > 0 && (
        <section className="mb-7">
          <div className="mb-3 border-b border-line pb-2">
            <h2 className="h2">Без коллекции</h2>
            <div className="text-[13px] text-muted">образов: {loose.length} · перенести в коллекцию можно на странице образа</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{loose.map((l) => <LookCard key={l.id} look={l} active={active?.id === l.id} />)}</div>
        </section>
      )}
    </>
  );
}
