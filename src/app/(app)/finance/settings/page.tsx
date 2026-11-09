import { prisma } from "@/lib/db";
import { allowedRegistrationEmails } from "@/lib/auth";
import { requireFinance } from "@/lib/finance/access";
import { financeContext } from "@/lib/finance/page";
import { financeUsers } from "@/lib/finance/report";
import { deletePartner, mergeCounterparty, saveCategory, saveCounterparty, saveDirection, savePartner } from "@/actions/finance";
import { PNL_LINES } from "@/lib/finance/pnl";
import { FinanceNav } from "@/components/finance/FinanceNav";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

type CatRow = { id: string; name: string; pnl: string; archived: boolean; dirIds: string[] };
type TopDir = { id: string; name: string; archived: boolean };

/** Строки P&L для списка: доходам — выручка и прочее, расходам — расходные строки и прочее. */
const pnlSelect = (value: string, kind: "INCOME" | "EXPENSE") => (
  <select name="pnl" className="input w-auto" defaultValue={value} title="Строка отчёта P&L">
    {PNL_LINES.filter((l) => l.kind === kind || l.kind === "ANY" || l.key === value).map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
  </select>
);

const dirChecks = (tops: TopDir[], on: string[]) => (
  <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
    <span className="help">Направления{on.length ? "" : " (все)"}:</span>
    {tops.filter((d) => !d.archived || on.includes(d.id)).map((d) => (
      <label key={d.id} className="inline-flex items-center gap-1.5"><input type="checkbox" name="dirs" value={d.id} defaultChecked={on.includes(d.id)} /> {d.name}</label>
    ))}
  </div>
);

/** Список категорий одного вида: название, строка P&L, в каких направлениях предлагать. */
function CatCard({ title, description, kind, pnlDefault, cats, tops }: { title: string; description: string; kind: "INCOME" | "EXPENSE"; pnlDefault: string; cats: CatRow[]; tops: TopDir[] }) {
  return (
    <Card title={title} description={description}>
      <ul className="divide-y divide-line">
        {cats.map((c) => (
          <li key={c.id} className={`py-2.5 ${c.archived ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-start gap-2">
              <ActionForm action={saveCategory} hidden={{ id: c.id, dirsPresent: "1" }} className="flex flex-1 flex-wrap items-center gap-2">
                <input name="name" className="input flex-1 min-w-[140px]" defaultValue={c.name} />
                {pnlSelect(c.pnl, kind)}
                <SubmitButton className="btn-ghost btn-sm" pendingText="…">OK</SubmitButton>
                {dirChecks(tops, c.dirIds)}
              </ActionForm>
              <ActionForm action={saveCategory} hidden={{ id: c.id, archived: c.archived ? "0" : "1" }} className="inline">
                <SubmitButton className="btn-ghost btn-sm" pendingText="…">{c.archived ? "Вернуть" : "Скрыть"}</SubmitButton>
              </ActionForm>
              {c.archived && <Badge>скрыта</Badge>}
            </div>
          </li>
        ))}
      </ul>
      <ActionForm action={saveCategory} hidden={{ dirsPresent: "1" }} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <input name="name" className="input flex-1 min-w-[140px]" placeholder={kind === "INCOME" ? "Новая категория дохода" : "Новая категория расхода"} required />
        {pnlSelect(pnlDefault, kind)}
        <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
        {dirChecks(tops, [])}
      </ActionForm>
    </Card>
  );
}

/** Настройки финансов: партнёры и доли, направления (2 уровня), категории. Скрытое остаётся в старых операциях. */
export default async function FinanceSettings() {
  const me = await requireFinance();
  const ctx = await financeContext(me);
  const { refs } = ctx;
  const [users, used] = await Promise.all([
    financeUsers(allowedRegistrationEmails()),
    prisma.finOp.groupBy({ by: ["partnerId"], _count: true }),
  ]);
  const opsOf = new Map(used.map((u) => [u.partnerId, u._count]));
  const catName = new Map(refs.cats.map((c) => [c.id, c.name]));
  const shareSum = refs.partners.reduce((s, p) => s + p.sharePct, 0);
  const userSelect = (value: string | null) => (
    <select name="userId" className="input" defaultValue={value ?? ""}>
      <option value="">— не привязан —</option>
      {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
    </select>
  );

  return (
    <>
      <FinanceNav cur={ctx.cur} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Партнёры и доли" description="Между кем делятся расходы и доходы. Привязка к пользователю нужна, чтобы в форме сразу стояло «кто платил — я»." >
            <div id="partners" className="space-y-3">
              {refs.partners.map((p) => (
                <div key={p.id} className="rounded-xl border border-line p-3">
                  <ActionForm action={savePartner} hidden={{ id: p.id }} className="grid gap-2 sm:grid-cols-[1fr_1fr_90px_auto] items-end">
                    <label className="block"><span className="label">Имя</span><input name="name" className="input" defaultValue={p.name} required /></label>
                    <label className="block"><span className="label">Пользователь</span>{userSelect(p.userId)}</label>
                    <label className="block"><span className="label">Доля, %</span><input name="sharePct" className="input" inputMode="decimal" defaultValue={p.sharePct} /></label>
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                  </ActionForm>
                  {!opsOf.get(p.id) && (
                    <ActionForm action={deletePartner} hidden={{ id: p.id }} className="mt-1">
                      <SubmitButton className="text-[12.5px] text-danger hover:underline" confirm={`Удалить партнёра «${p.name}»?`} pendingText="…">Удалить</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              ))}
              {refs.partners.length > 0 && Math.abs(shareSum - 100) > 0.01 && <p className="help text-warn">Сумма долей {shareSum}% — расчёт делит пропорционально, но обычно ставят ровно 100%.</p>}
              <ActionForm action={savePartner} className="grid gap-2 sm:grid-cols-[1fr_1fr_90px_auto] items-end border-t border-line pt-3">
                <label className="block"><span className="label">Новый партнёр</span><input name="name" className="input" placeholder="Имя" required /></label>
                <label className="block"><span className="label">Пользователь</span>{userSelect(refs.partners.length === 0 ? me.id : null)}</label>
                <label className="block"><span className="label">Доля, %</span><input name="sharePct" className="input" inputMode="decimal" defaultValue={50} /></label>
                <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
              </ActionForm>
              <p className="help">В списке пользователей — только те, у кого есть доступ к финансам. Доступ выдаёт владелец на странице пользователя.</p>
            </div>
          </Card>

          <CatCard title="Категории доходов" kind="INCOME" pnlDefault="REVENUE" cats={refs.cats.filter((c) => c.kind === "INCOME" || c.kind === "ANY")} tops={refs.parents}
            description="Откуда приходят деньги. У каждого направления могут быть свои: отметьте направления у категории — и в форме дохода она будет предлагаться только в них. Без отметок — во всех." />
          <CatCard title="Категории расходов" kind="EXPENSE" pnlDefault="OPEX" cats={refs.cats.filter((c) => c.kind === "EXPENSE")} tops={refs.parents}
            description="Строка отчёта P&L: прямые, операционные, налоги. Категорию тоже можно показывать только в отмеченных направлениях. Скрытая не предлагается в форме, но остаётся в старых операциях." />
        </div>

        <div className="space-y-4">
        <Card title="Направления" description="Два уровня: направление и его подразделы (например, Пинтерест → Кулинария). Общие расходы компании — в «Общее Wexora».">
          <ul className="space-y-3">
            {refs.parents.map((p) => {
              const kids = refs.dirs.filter((d) => d.parentId === p.id);
              return (
                <li key={p.id} className={`rounded-xl border border-line p-3 ${p.archived ? "opacity-60" : ""}`}>
                  <DirRow id={p.id} name={p.name} archived={p.archived} strong />
                  <ul className="mt-2 space-y-1.5 pl-4 border-l border-line">
                    {kids.map((k) => <li key={k.id}><DirRow id={k.id} name={k.name} archived={k.archived} /></li>)}
                    <li>
                      <ActionForm action={saveDirection} hidden={{ parentId: p.id }} className="flex items-center gap-2">
                        <input name="name" className="input flex-1" placeholder={`Подраздел в «${p.name}»`} required />
                        <SubmitButton className="btn-ghost btn-sm" pendingText="…">+ Подраздел</SubmitButton>
                      </ActionForm>
                    </li>
                  </ul>
                </li>
              );
            })}
          </ul>
          <ActionForm action={saveDirection} className="mt-3 flex items-center gap-2 border-t border-line pt-3">
            <input name="name" className="input flex-1" placeholder="Новое направление" required />
            <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
          </ActionForm>
        </Card>

        <Card title={`Контрагенты: ${refs.counterparties.length}`} description="Кому платим и от кого получаем. Один контрагент может быть в нескольких категориях — в форме при выборе категории показываются только её контрагенты. Новых можно добавлять прямо из формы операции.">
          <div id="counterparties" />
          {refs.counterparties.length === 0 ? <p className="help">Пока нет. Впишите название в поле «Кому платили» при записи расхода — форма предложит добавить.</p> : (
            <ul className="divide-y divide-line">
              {[...refs.counterparties].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                <li key={c.id} className={`py-2 ${c.archived ? "opacity-60" : ""}`}>
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      {c.categoryIds.map((id) => <Badge key={id}>{catName.get(id) ?? "?"}</Badge>)}
                      <span className="help">операций: {c.uses}</span>
                      {c.archived && <Badge tone="warn">скрыт</Badge>}
                    </summary>
                    <div className="mt-2 space-y-2 rounded-xl bg-ink/5 p-3">
                      <ActionForm action={saveCounterparty} hidden={{ id: c.id, catsPresent: "1" }} className="space-y-2">
                        <input name="name" className="input" defaultValue={c.name} required />
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {refs.cats.filter((x) => !x.archived || c.categoryIds.includes(x.id)).map((x) => (
                            <label key={x.id} className="inline-flex items-center gap-1.5 text-[13.5px]"><input type="checkbox" name="cats" value={x.id} defaultChecked={c.categoryIds.includes(x.id)} /> {x.name}</label>
                          ))}
                        </div>
                        <SubmitButton className="btn-primary btn-sm" pendingText="…">Сохранить</SubmitButton>
                      </ActionForm>
                      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                        <ActionForm action={saveCounterparty} hidden={{ id: c.id, archived: c.archived ? "0" : "1" }} className="inline">
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">{c.archived ? "Вернуть" : "Скрыть"}</SubmitButton>
                        </ActionForm>
                        {refs.counterparties.length > 1 && (
                          <ActionForm action={mergeCounterparty} hidden={{ id: c.id }} className="flex flex-wrap items-center gap-2">
                            <select name="intoId" className="input w-auto" defaultValue=""><option value="">Объединить с…</option>{refs.counterparties.filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                            <SubmitButton className="btn-ghost btn-sm" confirm={`Перенести все операции «${c.name}» в выбранного контрагента и удалить «${c.name}»?`} pendingText="…">Объединить</SubmitButton>
                          </ActionForm>
                        )}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={saveCounterparty} hidden={{ catsPresent: "1" }} className="mt-3 space-y-2 border-t border-line pt-3">
            <div className="flex items-center gap-2">
              <input name="name" className="input flex-1" placeholder="Новый контрагент, например Ahrefs" required />
              <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {refs.cats.filter((x) => !x.archived).map((x) => <label key={x.id} className="inline-flex items-center gap-1.5 text-[13.5px]"><input type="checkbox" name="cats" value={x.id} /> {x.name}</label>)}
            </div>
          </ActionForm>
        </Card>
        </div>
      </div>
    </>
  );
}

function DirRow({ id, name, archived, strong }: { id: string; name: string; archived: boolean; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm action={saveDirection} hidden={{ id }} className="flex flex-1 items-center gap-2">
        <input name="name" className={`input flex-1 ${strong ? "font-semibold" : ""}`} defaultValue={name} />
        <SubmitButton className="btn-ghost btn-sm" pendingText="…">OK</SubmitButton>
      </ActionForm>
      <ActionForm action={saveDirection} hidden={{ id, archived: archived ? "0" : "1" }} className="inline">
        <SubmitButton className="btn-ghost btn-sm" pendingText="…">{archived ? "Вернуть" : "Скрыть"}</SubmitButton>
      </ActionForm>
      {archived && <Badge>скрыто</Badge>}
    </div>
  );
}
