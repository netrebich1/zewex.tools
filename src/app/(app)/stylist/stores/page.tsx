import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { StoreContacts, branchCount } from "@/components/stylist/StoreContacts";
import { saveStore, scanStoreNow } from "@/actions/stylist";
import { GEOS, SEGMENTS, SEGMENT_LABELS } from "@/lib/stylist/consts";
import { ADAPTERS } from "@/lib/stylist/scan";
import { canSee } from "@/lib/stylist/queries";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function StylistStores() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const stores = await prisma.stStore.findMany({ orderBy: [{ geo: "asc" }, { adapter: "asc" }, { name: "asc" }] });
  const segOrder = SEGMENTS.map((s) => s.id as string);
  const running = stores.filter((s) => s.scanStatus === "running");
  const queued = stores.filter((s) => ADAPTERS[s.adapter]?.auto && s.scanStatus !== "running" && (s.scanAsked || (s.isActive && !s.lastScanAt)));
  return (
    <>
      <StNav />
      <PageHeader
        title="Магазины"
        subtitle="Какие магазины есть в каталоге. «Собирается сам» — каталог с ценами, размерами и наличием обновляется раз в сутки автоматически. «По ссылке» — сайт магазина закрыт от автоматического сбора или интернет-магазина нет: вещи из него добавляются вручную на вкладке «Добавить вещь»."
      />
      {running.length > 0 ? (
        <div className="mb-4"><Alert tone="warn">Сейчас собирается: {running.map((s) => `${s.name} (${s.scanNote ?? "идёт сбор"})`).join("; ")}. В очереди: {queued.length ? queued.map((s) => s.name).join(", ") : "никого"}. Магазины собираются по одному; обновите страницу, чтобы увидеть продвижение.</Alert></div>
      ) : (
        <div className="mb-4"><Alert tone="ok">Сейчас сбор не идёт: все автоматические магазины собраны. Следующее обновление — через сутки после предыдущего или по кнопке «Обновить сейчас».</Alert></div>
      )}
      {GEOS.map((g) => {
        const list = stores.filter((s) => s.geo === g.id).sort((a, b) => Number((ADAPTERS[b.adapter]?.auto ?? false) || b.adapter === "feed") - Number((ADAPTERS[a.adapter]?.auto ?? false) || a.adapter === "feed") || segOrder.indexOf(a.segment) - segOrder.indexOf(b.segment) || a.name.localeCompare(b.name));
        return (
          <Card key={g.id} className="mb-5" title={`${g.label} — ${list.length}`}>
            {list.length === 0 ? <p className="help">Магазинов пока нет.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Магазин</th><th>Сегмент</th><th>Сбор</th><th>В наличии</th><th>Состояние</th><th></th></tr></thead>
                  <tbody>
                    {list.map((s) => {
                      const auto = ADAPTERS[s.adapter]?.auto;
                      return (
                        <tr key={s.id}>
                          <td>
                            <div className="font-medium">{s.name}</div>
                            {s.baseUrl && <a href={s.baseUrl} target="_blank" rel="noreferrer noopener" className="text-[12px] text-muted underline">{s.baseUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>}
                            {s.comment && <div className="mt-1 max-w-[420px] !whitespace-normal text-[12px] leading-snug text-ink-2">{s.comment}</div>}
                            {branchCount(s.contacts) > 0 && (
                              <details className="mt-1 max-w-[420px] !whitespace-normal">
                                <summary className="cursor-pointer text-[12px] font-medium">Адреса и телефоны: {branchCount(s.contacts)}</summary>
                                <div className="mt-2"><StoreContacts contacts={s.contacts} /></div>
                              </details>
                            )}
                          </td>
                          <td>{SEGMENT_LABELS[s.segment] ?? s.segment}</td>
                          <td>{auto || s.adapter === "feed" ? <Badge tone="ok">собирается сам</Badge> : <Badge>по ссылке</Badge>}</td>
                          <td>{s.itemCount.toLocaleString("ru-RU")}</td>
                          <td className="!whitespace-normal text-[13px]">
                            {s.scanStatus === "running" ? <Badge tone="brand">идёт сбор</Badge> : s.scanStatus === "error" ? <Badge tone="danger">ошибка</Badge> : null}
                            {s.scanNote && <div className={s.scanStatus === "error" ? "text-danger" : "text-muted"}>{s.scanNote}</div>}
                            {s.lastScanAt && <div className="text-muted">обновлён {fmtDate(s.lastScanAt)}</div>}
                          </td>
                          <td>
                            {auto && (
                              <ActionForm action={scanStoreNow} className="" hidden={{ store: s.id }}>
                                <SubmitButton className="btn-ghost btn-sm" pendingText="…">Обновить сейчас</SubmitButton>
                              </ActionForm>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      <Card title="Добавить магазин" description="Магазин без автоматического сбора: его вещи добавляются по ссылке. Так можно завести любой бренд, включая люкс.">
        <ActionForm action={saveStore}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Название"><input name="name" required maxLength={100} placeholder="например, COS" className="input" /></Field>
            <Field label="Страна">
              <select name="geo" className="input" defaultValue="MT">{GEOS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select>
            </Field>
            <Field label="Сегмент">
              <select name="segment" className="input" defaultValue="mid">{SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </Field>
            <Field label="Валюта цен" hint="Пусто — евро для Мальты, гривна для Украины."><input name="currency" maxLength={4} placeholder="EUR" className="input" /></Field>
          </div>
          <Field label="Сайт магазина"><input name="baseUrl" type="url" placeholder="https://…" className="input" /></Field>
          <SubmitButton>Добавить магазин</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
