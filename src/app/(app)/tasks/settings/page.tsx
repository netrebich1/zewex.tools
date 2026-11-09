import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireTasks, allPeople, taskPeople } from "@/lib/tasks/access";
import { fmtDateTime } from "@/lib/tasks/consts";
import { deleteLabel, issueLinkCode, saveBot, saveDigestHours, saveLabel, toggleDigest, unlinkTg } from "@/actions/tasks";
import { TasksHeader } from "@/components/tasks/Header";
import { Avatar, LabelChip } from "@/components/tasks/bits";
import { TkForm, Btn } from "@/components/tasks/TkForm";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

const COLORS = ["#dc2626", "#f97316", "#f59e0b", "#16a34a", "#0ea5e9", "#2563eb", "#a855f7", "#db2777", "#64748b"];

/** Настройки раздела: Telegram-бот, часы дайджестов, привязки сотрудников (коды), метки, кому открыт доступ. */
export default async function TasksSettings() {
  const me = await requireTasks();
  const [s, links, people, everyone, labels] = await Promise.all([
    prisma.tkSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } }),
    prisma.tkTgLink.findMany(), taskPeople(), allPeople(), prisma.tkLabel.findMany({ orderBy: { order: "asc" } }),
  ]);
  const myLink = links.find((l) => l.userId === me.id);
  const linkOf = (uid: string) => links.find((l) => l.userId === uid);
  return (
    <>
      <TasksHeader userId={me.id} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 min-w-0">
          <Card title="Telegram-бот" description="Один бот на портал: дайджесты утром и вечером, задачи текстом, голосовые отчёты сотрудников, кнопки «Готово / На завтра».">
            {s.botUsername ? (
              <p className="text-[14px] mb-3">Подключён <a href={`https://t.me/${s.botUsername}`} target="_blank" rel="noreferrer" className="font-semibold underline">@{s.botUsername}</a>{s.lastError && <span className="text-danger"> · ошибка опроса: {s.lastError}</span>}</p>
            ) : (
              <ol className="list-decimal pl-5 text-[14px] space-y-1 mb-3">
                <li>В Telegram откройте <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">@BotFather</a> → <code>/newbot</code>, придумайте имя.</li>
                <li>Скопируйте токен вида <code>123456:ABC-…</code> и вставьте ниже.</li>
                <li>Привяжите свой чат кодом (блок «Мой Telegram»).</li>
              </ol>
            )}
            {me.superAdmin ? (
              <TkForm action={saveBot} className="flex items-center gap-2">
                <input name="token" type="password" className="input" placeholder={s.botUsername ? "Новый токен (пусто — отключить бота)" : "Токен от BotFather"} autoComplete="off" />
                <Btn className="btn-primary shrink-0">{s.botUsername ? "Заменить" : "Подключить"}</Btn>
              </TkForm>
            ) : <p className="help">Токен бота меняет главный админ.</p>}
            <TkForm action={saveDigestHours} className="mt-4 flex flex-wrap items-end gap-3">
              <div><label className="label">Утренний дайджест, час (Киев)</label><input type="number" name="morningHour" min={0} max={23} defaultValue={s.morningHour} className="input !w-28" /></div>
              <div><label className="label">Вечерний, час</label><input type="number" name="eveningHour" min={0} max={23} defaultValue={s.eveningHour} className="input !w-28" /></div>
              <Btn className="btn-ghost">Сохранить</Btn>
            </TkForm>
            <p className="help mt-2">Дайджест приходит, если есть что показать; пустой день — тишина.</p>
          </Card>

          <Card title="Мой Telegram">
            {myLink?.chatId ? (
              <div className="space-y-3">
                <p className="text-[14px]">Привязан: <b>{myLink.tgName ?? "чат " + myLink.chatId}</b> <span className="help">· {myLink.linkedAt ? fmtDateTime(myLink.linkedAt) : ""}</span></p>
                <div className="flex flex-wrap gap-2">
                  <TkForm action={toggleDigest} hidden={{ kind: "morning" }} inline><Btn className={`tab ${myLink.morning ? "active" : "border-line"}`}>☀️ Утренний дайджест {myLink.morning ? "вкл" : "выкл"}</Btn></TkForm>
                  <TkForm action={toggleDigest} hidden={{ kind: "evening" }} inline><Btn className={`tab ${myLink.evening ? "active" : "border-line"}`}>🌙 Вечерний {myLink.evening ? "вкл" : "выкл"}</Btn></TkForm>
                  <TkForm action={unlinkTg} hidden={{ userId: me.id }} confirm="Отвязать Telegram?" inline><Btn className="btn-ghost btn-sm text-danger">Отвязать</Btn></TkForm>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {myLink?.code ? <p className="text-[15px]">Напишите боту{s.botUsername ? <> <a href={`https://t.me/${s.botUsername}?start=${myLink.code}`} target="_blank" rel="noreferrer" className="underline font-semibold">@{s.botUsername}</a></> : ""}: <code className="rounded bg-ink/5 px-2 py-1 text-[15px] font-bold">/start {myLink.code}</code></p> : <p className="help">Получите код и отправьте его боту командой /start.</p>}
                <TkForm action={issueLinkCode} hidden={{ userId: me.id }} inline><Btn className="btn-ghost btn-sm">{myLink?.code ? "Новый код" : "Получить код"}</Btn></TkForm>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4 min-w-0">
          <Card title="Сотрудники и бот" description="Любой сотрудник портала может сдавать голосовые отчёты, даже без доступа к задачам. Выдайте код и попросите отправить боту /start КОД.">
            <div className="divide-y divide-line/70">
              {everyone.map((u) => {
                const l = linkOf(u.id);
                const hasTasks = people.some((p) => p.id === u.id);
                return (
                  <div key={u.id} className="flex items-center gap-3 py-2">
                    <Avatar name={u.name} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium truncate">{u.name}{hasTasks && <span className="badge bg-brand-soft text-warn ml-2">задачи</span>}</p>
                      <p className="help truncate">{l?.chatId ? `Telegram: ${l.tgName ?? l.chatId}` : l?.code ? <>код: <code className="font-bold text-ink">/start {l.code}</code></> : "не привязан"}</p>
                    </div>
                    {me.superAdmin && (l?.chatId
                      ? <TkForm action={unlinkTg} hidden={{ userId: u.id }} confirm={`Отвязать Telegram у ${u.name}?`} inline><Btn className="btn-ghost btn-sm">Отвязать</Btn></TkForm>
                      : <TkForm action={issueLinkCode} hidden={{ userId: u.id }} inline><Btn className="btn-ghost btn-sm">{l?.code ? "Новый код" : "Код"}</Btn></TkForm>)}
                  </div>
                );
              })}
            </div>
            <p className="help mt-3">Доступ к самому разделу «Задачи» выдаётся на <Link href="/users" className="underline">странице сотрудника</Link> (закрытый инструмент, как Финансы). Сейчас открыт: {people.map((p) => p.name).join(", ") || "только владельцу"}.</p>
          </Card>

          <Card title="Метки" description="Цветные теги на задачах. Фильтр по метке есть в канбане.">
            <div className="flex flex-wrap gap-2 mb-3">
              {labels.map((l) => (
                <div key={l.id} className="inline-flex items-center gap-1">
                  <LabelChip name={l.name} color={l.color} />
                  <TkForm action={deleteLabel} hidden={{ id: l.id }} confirm={`Удалить метку «${l.name}»?`} inline><button type="submit" className="text-muted hover:text-danger text-[13px] px-1" title="Удалить">✕</button></TkForm>
                </div>
              ))}
              {!labels.length && <p className="help">Меток нет.</p>}
            </div>
            <TkForm action={saveLabel} reset className="flex flex-wrap items-center gap-2">
              <input name="name" required maxLength={60} className="input !w-48" placeholder="Новая метка" />
              <div className="flex gap-1">{COLORS.map((c, i) => <label key={c} className="h-6 w-6 rounded-full cursor-pointer has-[:checked]:ring-2 has-[:checked]:ring-ink ring-offset-1 ring-offset-surface" style={{ background: c }}><input type="radio" name="color" value={c} defaultChecked={i === 8} className="sr-only" /></label>)}</div>
              <Btn className="btn-ghost btn-sm">Добавить</Btn>
            </TkForm>
          </Card>
        </div>
      </div>
    </>
  );
}
