import { Alert, Badge, Card } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { checkSiteSheet, removeSheetsKey, saveSheetsKey } from "@/actions/articles";
import { SHEET_COLUMNS_HELP, type SheetsConnection } from "@/lib/articles/sheets";

type Props = {
  siteId: string;
  /** Домен сайта = название вкладки */
  domain: string;
  /** Ссылка из настроек сайта (пусто — ещё не сохранена) */
  sheetUrl: string;
  sheets: SheetsConnection;
  isAdmin: boolean;
};

/**
 * Блок «Google Таблицы» в настройках сайта сервиса «Статьи»: подключено ли (сервисный аккаунт общий для всех сайтов),
 * что сделать с таблицей этого сайта, проверка доступа, какие колонки понимает импорт. Ключ аккаунта меняет только администратор.
 */
export function SheetsCard({ siteId, domain, sheetUrl, sheets, isAdmin }: Props) {
  return (
    <div id="sheets" className="scroll-mt-24">
      <Card title="Google Таблицы" description="Ключи статей берутся из вкладки таблицы, а статус, ссылка и дата публикации записываются обратно в ту же строку.">
        <div className="space-y-4">
          {sheets.connected ? (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Badge tone="ok">подключено</Badge>
              <span>Аккаунт портала: <code className="rounded bg-ink/5 px-1.5 py-0.5 text-[13px] select-all">{sheets.email}</code></span>
            </div>
          ) : (
            <Alert tone="warn">Google Таблицы ещё не подключены к порталу. {isAdmin ? "Добавьте ключ сервисного аккаунта ниже — это делается один раз для всех сайтов." : "Попросите администратора добавить ключ сервисного аккаунта."}</Alert>
          )}

          {sheets.connected && (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-[14px]">
                <li>Откройте таблицу → «Настройки доступа» → добавьте <b className="select-all">{sheets.email}</b> с ролью «Редактор».</li>
                <li>Назовите вкладку сайта его доменом: <b className="select-all">{domain || "домен сайта"}</b>.</li>
                <li>Первая строка вкладки — заголовки колонок (список ниже), порядок любой.</li>
                <li>Сохраните ссылку на таблицу в настройках сайта выше (блок «Прочее») и нажмите «Проверить таблицу».</li>
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <ActionForm action={checkSiteSheet} hidden={{ id: siteId }} className="space-y-2">
                  <SubmitButton className="btn-primary" pendingText="Проверяю…">Проверить таблицу</SubmitButton>
                </ActionForm>
                {sheetUrl
                  ? <a href={sheetUrl} target="_blank" rel="noreferrer" className="text-info hover:underline text-[14px]">открыть таблицу ↗</a>
                  : <span className="help">Ссылка на таблицу ещё не сохранена.</span>}
              </div>
            </>
          )}

          <details className="text-[14px]">
            <summary className="cursor-pointer font-medium">Какие колонки нужны во вкладке</summary>
            <div className="table-wrap mt-2">
              <table className="table text-[13px]">
                <thead><tr><th>Заголовок</th><th>Что в колонке</th><th></th></tr></thead>
                <tbody>
                  {SHEET_COLUMNS_HELP.map((c) => (
                    <tr key={c.title}>
                      <td className="whitespace-nowrap font-medium">{c.title}</td>
                      <td className="text-muted">{c.note}</td>
                      <td>{c.required ? <Badge tone="warn">обязательно</Badge> : c.report ? <Badge>отчёт</Badge> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="help mt-2">В работу берутся строки без «Статуса» и без Publish URL. Чтобы запустить строку заново, очистите у неё «Статус». Колонку «Статус» портал создаст сам, если её нет; колонки для ссылок и дат добавьте заранее — без них отчёт не запишется.</p>
          </details>

          {isAdmin && (
            <details className="text-[14px]" open={!sheets.connected}>
              <summary className="cursor-pointer font-medium">{sheets.connected ? "Заменить ключ сервисного аккаунта" : "Подключить: ключ сервисного аккаунта Google"}</summary>
              <div className="mt-2 space-y-3">
                <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-ink-2">
                  <li>Откройте <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" className="underline">console.cloud.google.com</a> под своим Google-аккаунтом и создайте проект (название любое).</li>
                  <li>Меню → «APIs &amp; Services» → «Library» → найдите «Google Sheets API» → «Enable».</li>
                  <li>Меню → «IAM &amp; Admin» → «Service Accounts» → «Create service account» → название любое → «Done».</li>
                  <li>Нажмите на созданный аккаунт → вкладка «Keys» → «Add key» → «Create new key» → «JSON». Скачается файл.</li>
                  <li>Откройте файл в «Блокноте» (TextEdit), скопируйте всё содержимое и вставьте в поле ниже.</li>
                </ol>
                <ActionForm action={saveSheetsKey} className="space-y-2">
                  <textarea name="serviceKey" className="input font-mono text-[12.5px]" rows={5} placeholder={'{\n  "type": "service_account",\n  "client_email": "…@….iam.gserviceaccount.com",\n  "private_key": "-----BEGIN PRIVATE KEY-----…"\n}'} autoComplete="off" spellCheck={false} />
                  <SubmitButton pendingText="Проверяю ключ…">{sheets.connected ? "Заменить ключ" : "Подключить Google Таблицы"}</SubmitButton>
                </ActionForm>
                <p className="help">Ключ хранится зашифрованным и общий для всех сайтов сервиса. Портал видит только те таблицы, к которым этому аккаунту выдали доступ.</p>
                {sheets.connected && (
                  <ActionForm action={removeSheetsKey} className="space-y-2">
                    <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm="Удалить ключ? Импорт из таблиц и запись отчётов перестанут работать на всех сайтах.">Удалить ключ</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </details>
          )}
        </div>
      </Card>
    </div>
  );
}
