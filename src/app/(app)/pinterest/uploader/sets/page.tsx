import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireUploader, visiblePinSites } from "@/lib/uploader/access";
import { setFor, setRows } from "@/lib/uploader/sets";
import { deleteSetAction } from "@/actions/uploader";
import { SetForm } from "@/components/uploader/SetForm";

export const dynamic = "force-dynamic";

/** Наборы сайтов галочками: какие сайты в работе; используются формой запуска и расписанием агента. */
export default async function UploaderSetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUploader();
  const q = await searchParams;
  const editId = sp(q, "edit");
  const [sites, sets, mapped] = await Promise.all([visiblePinSites(me), setRows(me), prisma.uplAccount.findMany({ where: { profileId: { not: null } }, select: { pinSiteId: true } })]);
  const mappedSet = new Set(mapped.map((m) => m.pinSiteId));
  const siteRows = sites.map((s) => ({ id: s.id, name: s.name, mapped: mappedSet.has(s.id) }));
  const nameBy = new Map(sites.map((s) => [s.id, s.name]));
  const editing = editId ? await setFor(me, editId) : null;
  return (
    <>
      <PageHeader title="Наборы сайтов" subtitle="Отметьте галочками сайты, которые сейчас в работе, и сохраните набор. Набор выбирается в форме запуска и в расписании агента." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title={`Наборы · ${sets.length}`}>
          {sets.length === 0 ? <p className="help">Наборов ещё нет. Создайте первый справа, например «В работе».</p> : (
            <ul className="space-y-2">{sets.map((s) => (
              <li key={s.id} className={`rounded-xl border p-3 ${editing?.id === s.id ? "border-brand" : "border-line"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <b>{s.name}</b><span className="help">{s.siteIds.length} сайт(ов)</span>
                  <span className="ml-auto flex gap-1.5">
                    <Link href={`/pinterest/uploader/sets?edit=${s.id}`} className="btn-ghost btn-sm">Изменить</Link>
                    <ActionForm action={deleteSetAction} hidden={{ id: s.id }} className="inline"><SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить набор «${s.name}»?`}>Удалить</SubmitButton></ActionForm>
                  </span>
                </div>
                <p className="help mt-1 line-clamp-2">{s.siteIds.map((id) => nameBy.get(id) ?? "?").join(", ") || "пусто"}</p>
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title={editing ? `Изменить набор «${editing.name}»` : "Новый набор"} actions={editing ? <Link href="/pinterest/uploader/sets" className="btn-ghost btn-sm">Новый</Link> : null}>
          <SetForm key={editing?.id ?? "new"} sites={siteRows} initial={editing ? { id: editing.id, name: editing.name, siteIds: editing.siteIds } : undefined} />
        </Card>
      </div>
    </>
  );
}
