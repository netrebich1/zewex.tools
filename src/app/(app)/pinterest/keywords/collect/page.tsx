import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireKeywords } from "@/lib/keywords/access";
import { addAccountAction, importStarterAction, recomputeAction, saveAccountAction, enqueueAction } from "@/actions/keywords";
import { kyivDay, PAUSES_MIN } from "@/lib/keywords/collector";
import { NICHES } from "@/lib/keywords/types";
import { extensionVersion, olderVersion } from "@/lib/keywords/extension";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { KeywordsNav } from "@/components/keywords/KeywordsNav";
import { LiftLimitButton, QueueButtons, RevokeButton, TokenForm } from "@/components/keywords/CollectControls";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "Работает", cls: "bg-ok-soft text-ok" },
  SLOW: { label: "Медленный режим", cls: "bg-warn-soft text-warn" },
  LIMITED: { label: "Ограничен поиск", cls: "bg-danger-soft text-danger" },
  OFF: { label: "Выключен", cls: "bg-ink/5 text-muted" },
};
const KIND: Record<string, string> = {
  serp: "выдача", typeahead: "подсказки", pinner: "профиль автора", volume: "частотность",
  blocked: "первый отказ", paused: "пауза", limited: "ограничение поиска", resumed: "поиск снова работает", retry: "повторная попытка", manual: "вручную",
};
const RESULT: Record<string, string> = { ok: "успешно", empty: "пусто", error: "ошибка" };
const TASK_STATUS: Record<string, string> = { QUEUED: "ждут", LEASED: "в работе", DONE: "готово", FAILED: "ошибка" };
const dt = (d: Date | null | undefined) => (d ? d.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ago = (d: Date | null | undefined, now: Date) => {
  if (!d) return "никогда";
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 90) return "только что";
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return dt(d);
};
/** Значение события по смыслу вида: время ответа, длительность паузы/блока или число ключей до блока. */
function eventValue(kind: string, v: number | null): string {
  if (v == null) return "";
  if (kind === "paused") return `${Math.round(v / 60)} мин`;
  if (kind === "resumed") return `блок ${Math.round(v / 60)} мин`;
  if (kind === "blocked" || kind === "limited") return `${v} ключей до блока`;
  return `${(v / 1000).toFixed(1)} с`;
}

/** Сбор: аккаунты Pinterest и их состояние, расширения и токены, очередь заданий, журнал запросов и блокировок. */
export default async function CollectPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireKeywords();
  const latest = await extensionVersion();
  const q = await searchParams;
  const acc = sp(q, "acc") || undefined;
  const ev = sp(q, "ev") || undefined;
  const now = new Date();
  const [accounts, counts, last, events, blocks, totals, collectors, tasks, failed] = await Promise.all([
    prisma.kwAccount.findMany({ orderBy: { name: "asc" } }),
    prisma.kwSerpSnapshot.groupBy({ by: ["accountId"], _count: { _all: true } }),
    prisma.kwSerpSnapshot.groupBy({ by: ["accountId"], _max: { takenAt: true } }),
    prisma.kwAccountEvent.findMany({
      where: { ...(acc ? { accountId: acc } : {}), ...(ev === "problems" ? { result: { not: "ok" } } : ev ? { kind: ev } : {}) },
      orderBy: { at: "desc" }, take: 60, include: { account: { select: { name: true } } },
    }),
    prisma.kwAccountEvent.findMany({ where: { kind: { in: ["blocked", "limited", "resumed"] } }, orderBy: { at: "desc" }, take: 30, include: { account: { select: { name: true } } } }),
    Promise.all([prisma.kwKeyword.count(), prisma.kwVolume.count(), prisma.kwSerpSnapshot.count(), prisma.kwArticle.count(), prisma.kwPinner.count()]),
    prisma.kwCollector.findMany({ where: { revokedAt: null }, orderBy: { createdAt: "desc" }, include: { account: { select: { name: true } } } }),
    prisma.kwTask.groupBy({ by: ["kind", "status"], _count: { _all: true } }),
    prisma.kwTask.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 8, include: { keyword: { select: { phrase: true } } } }),
  ]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(collectors.map((c) => c.userId))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
  const cnt = new Map(counts.map((c) => [c.accountId, c._count._all]));
  const lst = new Map(last.map((c) => [c.accountId, c._max.takenAt]));
  const tc = (kind: string, status: string) => tasks.find((t) => t.kind === kind && t.status === status)?._count._all ?? 0;
  const [kw, vol, snaps, arts, pinners] = totals;
  const today = kyivDay(now);
  const filterHref = (p: { acc?: string; ev?: string }) => {
    const s = new URLSearchParams(Object.entries({ acc, ev, ...p }).filter(([, v]) => v) as Array<[string, string]>);
    return `/pinterest/keywords/collect${s.toString() ? `?${s}` : ""}#journal`;
  };

  return (
    <>
      <PageHeader title="Сбор" subtitle="Выдачу и частотность снимает расширение Chrome «Zewex Collector» в браузере, где открыт Pinterest. Выдача у каждого аккаунта своя, поэтому каждый снимок помнит аккаунт." />
      <KeywordsNav />

      <Card title="Аккаунты Pinterest" description={`Пауза между ключами берётся отсюда (плюс случайный разброс до +50%). При отказе Pinterest — паузы ${PAUSES_MIN.join(" → ")} мин, потом ограничение на 4 ч (повторно 8 ч, дальше сутки), и задания уходят другому аккаунту. Суточного лимита по умолчанию нет — копим статистику блоков.`}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Аккаунт</th><th>Состояние</th><th className="text-right">Пауза</th><th className="text-right">Ключей сегодня</th><th className="text-right">С последнего блока</th><th className="text-right">Снимков</th><th>Последний снимок</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="font-semibold">{a.name}<span className="help block">{a.username ? `@${a.username}` : "логин запомнит расширение"}</span></td>
                  <td>
                    <span className={`badge ${STATUS[a.status]?.cls ?? ""}`}>{STATUS[a.status]?.label ?? a.status}</span>
                    {a.status === "LIMITED" && <span className="help block">{a.limitedUntil ? `до ${dt(a.limitedUntil)}` : "до ручного снятия"}</span>}
                    {a.status !== "LIMITED" && a.pausedUntil && a.pausedUntil > now && <span className="help block text-warn">пауза до {dt(a.pausedUntil)} ({a.blockStep}-й отказ)</span>}
                  </td>
                  <td className="text-right tabular-nums">{a.gapSec} с</td>
                  <td className="text-right tabular-nums">{a.dayDate === today ? a.dayKeys : 0}{a.dailyCap != null ? ` / ${a.dailyCap}` : ""}</td>
                  <td className="text-right tabular-nums">{a.streakKeys}{a.streakFrom && <span className="help block">с {dt(a.streakFrom)}</span>}</td>
                  <td className="text-right tabular-nums">{cnt.get(a.id) ?? 0}</td>
                  <td className="tabular-nums">{dt(lst.get(a.id))}</td>
                  <td>
                    <details>
                      <summary className="cursor-pointer text-[13px] text-muted hover:text-ink">Настроить</summary>
                      <ActionForm action={saveAccountAction} hidden={{ id: a.id }} className="mt-2 w-64 space-y-2">
                        <label className="block"><span className="label">Режим</span>
                          <select name="status" defaultValue={a.status} className="input">
                            <option value="ACTIVE">Работает</option>
                            <option value="SLOW">Медленный режим</option>
                            <option value="OFF">Выключен (пауза)</option>
                            {a.status === "LIMITED" && <option value="LIMITED">Ограничен (оставить)</option>}
                          </select>
                        </label>
                        <label className="block"><span className="label">Пауза между ключами, с</span><input name="gapSec" type="number" min={3} max={600} defaultValue={a.gapSec} className="input" /></label>
                        <label className="block"><span className="label">Лимит ключей в сутки</span><input name="dailyCap" type="number" min={1} defaultValue={a.dailyCap ?? ""} placeholder="без лимита" className="input" /></label>
                        <label className="block"><span className="label">Логин Pinterest</span><input name="username" defaultValue={a.username ?? ""} placeholder="запомнит расширение" className="input" /></label>
                        <SubmitButton className="btn-brand btn-sm w-full" pendingText="Сохраняю…">Сохранить</SubmitButton>
                      </ActionForm>
                      {(a.status === "LIMITED" || (a.pausedUntil && a.pausedUntil > now)) && <div className="mt-2"><LiftLimitButton id={a.id} /></div>}
                    </details>
                  </td>
                </tr>
              ))}
              {!accounts.length && <tr><td colSpan={8} className="text-center text-muted py-8">Аккаунтов пока нет — добавьте ниже или загрузите стартовые данные.</td></tr>}
            </tbody>
          </table>
        </div>
        <ActionForm action={addAccountAction} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block"><span className="label">Новый аккаунт Pinterest</span><input name="name" className="input w-64" placeholder="например: Netrebich 2" maxLength={120} /></label>
          <SubmitButton className="btn-ghost" pendingText="Добавляю…">Добавить</SubmitButton>
        </ActionForm>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Расширения" className="lg:col-span-2" description="Каждое установленное расширение работает со своим токеном и своим аккаунтом Pinterest. Зелёная точка — расширение выходило на связь в последние 3 минуты.">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Расширение</th><th>Аккаунт</th><th>Выдал</th><th>Что делает</th><th>На связи</th><th></th></tr></thead>
              <tbody>
                {collectors.map((c) => {
                  const online = !!c.lastSeenAt && now.getTime() - c.lastSeenAt.getTime() < 180_000;
                  return (
                    <tr key={c.id}>
                      <td><span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${online ? "bg-ok" : "bg-ink/20"}`} aria-hidden />{c.name}<span className="help block font-mono">{c.tokenHint}…{c.version ? ` · v${c.version}` : ""}</span>{olderVersion(c.version, latest) && <span className="badge bg-warn-soft text-warn mt-1">устарело — обновите до v{latest}</span>}</td>
                      <td>{c.account?.name ?? "—"}{c.seenUser && <span className="help block">в браузере @{c.seenUser}</span>}</td>
                      <td className="text-[13px]">{users.get(c.userId) ?? "—"}</td>
                      <td className="text-[13px] text-ink-2 max-w-[260px]">{c.state ?? "—"}</td>
                      <td className="text-[13px] whitespace-nowrap">{ago(c.lastSeenAt, now)}</td>
                      <td>{(c.userId === me.id || me.role === "ADMIN") && <RevokeButton id={c.id} />}</td>
                    </tr>
                  );
                })}
                {!collectors.length && <tr><td colSpan={6} className="text-center text-muted py-8">Расширение ещё не подключено. Выдайте токен справа и вставьте его в окно расширения.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <a href="/api/keywords/extension" className="btn-brand btn-sm">Скачать расширение v{latest} (ZIP)</a>
            <Link href="/pinterest/keywords/guide" className="btn-ghost btn-sm">Инструкция: установка и обновление</Link>
            <span className="help">Одинаково на Mac и Windows.</span>
          </div>
        </Card>
        <Card title="Выдать токен">
          {accounts.length ? <TokenForm accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} /> : <p className="help">Сначала добавьте аккаунт Pinterest.</p>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Очередь" className="lg:col-span-2" description="Расширение берёт задания по одному. Выдача снимается на вкладке www.pinterest.com, частотность — на вкладке Ads Manager (черновик кампании, US).">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Задания</th>{Object.keys(TASK_STATUS).map((s) => <th key={s} className="text-right">{TASK_STATUS[s]}</th>)}<th></th></tr></thead>
              <tbody>
                {(["serp", "volume"] as const).map((k) => (
                  <tr key={k}>
                    <td className="font-semibold">{k === "serp" ? "Выдача Pinterest" : "Частотность Ads Manager"}</td>
                    {Object.keys(TASK_STATUS).map((s) => <td key={s} className="text-right tabular-nums">{tc(k, s).toLocaleString("ru-RU")}</td>)}
                    <td><QueueButtons kind={k} queued={tc(k, "QUEUED")} failed={tc(k, "FAILED")} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {failed.length > 0 && (
            <div className="mt-3">
              <h4 className="text-[12px] font-bold uppercase tracking-wider text-muted mb-1.5">Последние ошибки</h4>
              <ul className="space-y-0.5 text-[13px]">
                {failed.map((t) => <li key={t.id}><span className="font-semibold">{t.keyword?.phrase ?? "—"}</span> · {t.kind === "serp" ? "выдача" : "частотность"} · <span className="text-ink-2">{t.error}</span></li>)}
              </ul>
            </div>
          )}
        </Card>
        <Card title="Поставить в очередь">
          <ActionForm action={enqueueAction} className="space-y-2">
            <label className="block"><span className="label">Что снять</span>
              <select name="kind" className="input" defaultValue="serp"><option value="serp">Выдачу Pinterest</option><option value="volume">Частотность (Ads Manager)</option></select>
            </label>
            <label className="block"><span className="label">Каким ключам</span>
              <select name="scope" className="input" defaultValue="missing">
                <option value="missing">Ещё не снятым</option>
                <option value="older">Не снятым или снятым давно</option>
                <option value="all">Всем подходящим</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="label">«Давно» — дней</span><input name="days" type="number" min={1} placeholder="30 / 60" className="input" /></label>
              <label className="block"><span className="label">Сколько ключей</span><input name="limit" type="number" min={1} max={5000} defaultValue={200} className="input" /></label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="label">Вкладка</span>
                <select name="tab" className="input" defaultValue="main"><option value="main">Ключи</option><option value="new">Новые</option><option value="all">Все</option></select>
              </label>
              <label className="block"><span className="label">Ниша</span>
                <select name="niche" className="input" defaultValue=""><option value="">Все</option>{NICHES.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}</select>
              </label>
            </div>
            <label className="block"><span className="label">Выдача: частотность от</span><input name="vmin" type="number" min={0} defaultValue={3000} className="input" /></label>
            <label className="block"><span className="label">Только с аккаунта</span>
              <select name="accountId" className="input" defaultValue=""><option value="">Любой свободный</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
            <p className="help">Сезонные ключи не ставятся. Сначала идут ключи с большей частотностью. «Давно» по умолчанию: выдача — 30 дней, частотность — 60.</p>
            <SubmitButton className="btn-brand w-full" pendingText="Ставлю…">В очередь</SubmitButton>
          </ActionForm>
        </Card>
      </div>

      <Card title="Блоки Pinterest" className="mt-4" description="После скольких ключей Pinterest начал отказывать и сколько длился блок. По этой статистике позже решим, нужен ли суточный лимит.">
        {blocks.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Когда</th><th>Аккаунт</th><th>Событие</th><th className="text-right">Цифра</th><th>Подробности</th></tr></thead>
              <tbody>
                {blocks.map((e) => (
                  <tr key={String(e.id)}><td className="tabular-nums whitespace-nowrap">{dt(e.at)}</td><td>{e.account.name}</td><td>{KIND[e.kind] ?? e.kind}</td><td className="text-right tabular-nums whitespace-nowrap">{eventValue(e.kind, e.value)}</td><td className="text-[13px] text-ink-2">{e.note}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="help">Блоков пока не было.</p>}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Журнал запросов" className="lg:col-span-2" description="Каждый запрос к Pinterest (выдача, подсказки, профили авторов, частотность), паузы и ограничения.">
          <div id="journal" className="mb-3 flex flex-wrap gap-1.5 text-[13px]">
            <Link href={filterHref({ acc: "" })} className={`tab ${!acc ? "active" : ""}`}>Все аккаунты</Link>
            {accounts.map((a) => <Link key={a.id} href={filterHref({ acc: a.id })} className={`tab ${acc === a.id ? "active" : ""}`}>{a.name}</Link>)}
            <span className="mx-1 text-muted">·</span>
            {[["", "Всё"], ["problems", "Только проблемы"], ["serp", "Выдача"], ["volume", "Частотность"]].map(([k, l]) => <Link key={k} href={filterHref({ ev: k })} className={`tab ${(ev ?? "") === k ? "active" : ""}`}>{l}</Link>)}
          </div>
          {events.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Когда</th><th>Аккаунт</th><th>Событие</th><th>Итог</th><th className="text-right">Время / длительность</th><th>Заметка</th></tr></thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={String(e.id)}>
                      <td className="tabular-nums whitespace-nowrap">{dt(e.at)}</td><td>{e.account.name}</td><td>{KIND[e.kind] ?? e.kind}</td>
                      <td className={e.result === "ok" ? "" : "text-danger"}>{RESULT[e.result] ?? e.result}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{eventValue(e.kind, e.value)}</td>
                      <td className="text-[13px] text-ink-2">{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="help">Событий пока нет.</p>}
        </Card>
        <Card title="Данные">
          <div className="space-y-1 text-[13.5px]">
            <div className="flex justify-between"><span className="text-muted">Ключей</span><span className="font-semibold tabular-nums">{kw.toLocaleString("ru-RU")}</span></div>
            <div className="flex justify-between"><span className="text-muted">Замеров частотности</span><span className="font-semibold tabular-nums">{vol.toLocaleString("ru-RU")}</span></div>
            <div className="flex justify-between"><span className="text-muted">Снимков выдачи</span><span className="font-semibold tabular-nums">{snaps.toLocaleString("ru-RU")}</span></div>
            <div className="flex justify-between"><span className="text-muted">Статей с проверенной датой</span><span className="font-semibold tabular-nums">{arts.toLocaleString("ru-RU")}</span></div>
            <div className="flex justify-between"><span className="text-muted">Профилей авторов в кэше</span><span className="font-semibold tabular-nums">{pinners.toLocaleString("ru-RU")}</span></div>
          </div>
          <p className="help mt-2">Даты статей топа воркер проверяет сам каждые 10 минут; оценки пересчитываются при новом снимке и раз в сутки.</p>
          {me.role === "ADMIN" && (
            <ActionForm action={importStarterAction} className="mt-4 space-y-2">
              <p className="help">Стартовые данные ручного сбора 20.10.2026: лист Evergreen, частотность, снимки выдачи, даты статей. Повторная загрузка ничего не дублирует.</p>
              <SubmitButton className="btn-brand w-full" pendingText="Загружаю…">Загрузить стартовые данные</SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={recomputeAction} className="mt-3 space-y-2">
            <SubmitButton className="btn-ghost w-full" pendingText="Пересчитываю…">Пересчитать оценки и флаги</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
