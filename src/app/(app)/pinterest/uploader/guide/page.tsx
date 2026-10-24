import Link from "next/link";
import { stat } from "node:fs/promises";
import type { ReactNode } from "react";
import { Card, PageHeader } from "@/components/ui";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { downloads } from "@/lib/uploader/release";
import { absPath, publicUrl } from "@/lib/pins/storage";
import { PasteShot } from "@/components/uploader/PasteShot";

export const dynamic = "force-dynamic";

/**
 * Инструкция по установке и работе для сотрудника: всё скачивается с нашего сервера, настройки — в портале.
 * Скриншоты — слоты `uploader/guide/<имя>.jpg`: админ кликает по пустому слоту и вставляет снимок Ctrl+V.
 */
type Step = { id: string; title: string; where?: string; href?: string; text: ReactNode[]; shot?: { name: string; caption?: string } };

const INSTALL: Step[] = [
  { id: "dolphin", title: "Установите Dolphin Anty", where: "Кнопка «Скачать Dolphin Anty» выше",
    text: ["Запустите установщик, далее всё по умолчанию. После установки откройте Dolphin и войдите в аккаунт команды (логин и пароль даёт администратор).", "Профили с аккаунтами Pinterest уже в команде: открывать их руками не нужно, это делает агент."],
    shot: { name: "01-dolphin-login", caption: "Окно входа Dolphin Anty" } },
  { id: "token", title: "Добавьте агента в портале и скопируйте токен", where: "Заливка в Pinterest → Агенты", href: "/pinterest/uploader/agents",
    text: ["Нажмите «Добавить агента и выдать токен», в названии напишите, чей это ПК. Появится токен zxu_… — скопируйте его кнопкой. Он показывается один раз.", "Токен Dolphin API сотруднику не нужен: его один раз вводит администратор в «Настройках», агент получает его сам."],
    shot: { name: "02-agents-add", caption: "Страница «Агенты»: кнопка выдачи токена и строка с токеном" } },
  { id: "agent", title: "Скачайте и запустите Zewex Uploader", where: "Кнопка «Скачать Zewex Uploader» выше",
    text: ["Распакуйте ZIP в любую папку (например, Документы\\ZewexUploader) и запустите ZewexUploader.cmd. Ничего ставить не нужно: всё необходимое внутри архива.", "В чёрном окне вставьте токен (правая кнопка мыши → Вставить) и нажмите Enter. Окно можно свернуть, закрывать нельзя — пока оно открыто, агент на связи.", <>Состояние агента — на <Link href="/pinterest/uploader/agents" className="underline">странице «Агенты»</Link> и в окошке http://127.0.0.1:47831/ на вашем ПК.</>],
    shot: { name: "03-agent-run", caption: "Окно агента после вставки токена" } },
  { id: "mapping", title: "Сопоставьте сайты и профили", where: "Заливка в Pinterest → Сопоставление", href: "/pinterest/uploader/mapping",
    text: [<><b>Правило:</b> профиль в Dolphin называется доменом сайта (например, «bellaromakitchen.com») — или домен вписан в тег либо заметку профиля. Тогда портал сам предложит пару: нажмите «Принять» или «Принять все однозначные».</>, "Если предложения нет — выберите профиль в списке руками. Один сайт = один аккаунт Pinterest = один профиль.", "При каждом визите агент сверяет логин Pinterest в профиле с запомненным, чужой файл в чужой аккаунт не уйдёт."],
    shot: { name: "04-mapping", caption: "Предложения и выбор профиля" } },
  { id: "sets", title: "Наборы сайтов (по желанию)", where: "Заливка в Pinterest → Наборы", href: "/pinterest/uploader/sets",
    text: ["Отметьте галочками сайты, которые сейчас в работе, и сохраните как набор («В работе», «Кулинария»…). Набор выбирается в форме запуска и в расписании агента, чтобы не отмечать сайты каждый раз."],
    shot: { name: "05-sets", caption: "Набор сайтов галочками" } },
];

const WORK: Step[] = [
  { id: "start", title: "Запустить заливку", where: "Заливка в Pinterest → Сегодня", href: "/pinterest/uploader",
    text: ["Отмечены сайты с файлом на день без отметки «залито». Выберите агента (свой ПК), при необходимости набор, нажмите «Запустить заливку».", "Агент по очереди открывает профили, листает ленту, загружает файл, закрывает профиль. Между сайтами — пауза 1–3 минуты, как у человека."],
    shot: { name: "06-today", caption: "Форма запуска на вкладке «Сегодня»" } },
  { id: "run", title: "Следить за запуском", where: "Заливка в Pinterest → Запуски", href: "/pinterest/uploader/runs",
    text: ["В карточке запуска видно каждый сайт: шаг агента, «файл принят», ошибки по-русски и скриншоты.", "Через 10 минут после последнего сайта агент снова откроет профили и прочитает историю массовых загрузок — появится «опубликовано N»."],
    shot: { name: "07-run", caption: "Карточка запуска" } },
  { id: "crm", title: "Отметки в «Проектах»", where: "Проекты → сайт → Выгрузки", href: "/pinterest/projects",
    text: ["Сразу после приёма файла в карточке проекта встаёт «залито · авто» со ссылкой на скриншот; в ленту пишутся «Залито», «Заливка не удалась», «Заливка проверена»."],
    shot: { name: "08-projects", caption: "Вкладка «Выгрузки» проекта" } },
  { id: "schedule", title: "Расписание", where: "Заливка в Pinterest → Агенты", href: "/pinterest/uploader/agents",
    text: ["У своего агента включите «Запускать каждый день в …» и выберите набор. Заливка начнётся сама, если в это время Dolphin и агент запущены."] },
];

const PROBLEMS: Array<[string, string]> = [
  ["Агент «не на связи»", "Окно агента закрыто или нет интернета. Запустите ZewexUploader.cmd снова — токен вводить повторно не нужно."],
  ["Dolphin Anty не запущен", "Задания ждут в очереди. Откройте Dolphin — заливка продолжится сама."],
  ["Нужен вход", "В профиле слетела сессия Pinterest. Откройте профиль в Dolphin руками, войдите, затем на «Сопоставлении» поставьте «Работает» и в запуске нажмите «Повторить неудачные»."],
  ["Профиль уже открыт", "Закройте этот профиль в Dolphin: агент не трогает окна, открытые человеком."],
  ["Pinterest отклонил файл или ограничил аккаунт", "Аккаунт уходит на паузу (2 ч → 6 ч → сутки). Посмотрите скриншот в запуске; снять паузу можно на «Сопоставлении»."],
  ["Страница загрузки изменилась", "Pinterest обновил интерфейс. Сообщите администратору: адрес меняется в настройках, при необходимости выйдет новая версия агента — она скачивается с той же кнопки."],
  ["Сайта нет в списке", "Вы видите только свои сайты (раздел «Сайты», блок «Кто видит»). Попросите администратора или лидера отметить вас."],
];

async function shotUrl(name: string): Promise<string | null> {
  const rel = `uploader/guide/${name}.jpg`;
  try { const s = await stat(absPath(rel)); return `${publicUrl(rel)}?v=${Math.round(s.mtimeMs)}`; } catch { return null; }
}

export default async function UploaderGuidePage() {
  const me = await requireUploader();
  const admin = isAdmin(me);
  const dl = await downloads();
  const urls = new Map<string, string | null>();
  await Promise.all([...INSTALL, ...WORK].filter((s) => s.shot).map(async (s) => urls.set(s.shot!.name, await shotUrl(s.shot!.name))));
  const StepList = ({ steps, from = 1 }: { steps: Step[]; from?: number }) => (
    <ol className="space-y-6">{steps.map((s, i) => (
      <li key={s.id} id={s.id} className="grid gap-3 lg:grid-cols-[1fr_380px]">
        <div>
          <div className="flex items-start gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-bg text-[13px] font-bold">{from + i}</span>
            <div>
              <h3 className="text-[15px] font-semibold">{s.title}</h3>
              {s.where && <p className="help">{s.href ? <Link href={s.href} className="underline">{s.where}</Link> : s.where}</p>}
            </div>
          </div>
          <ul className="mt-2 ml-10 list-disc space-y-1 text-[13.5px]">{s.text.map((t, j) => <li key={j}>{t}</li>)}</ul>
        </div>
        {s.shot && <PasteShot name={s.shot.name} src={urls.get(s.shot.name) ?? null} caption={s.shot.caption} admin={admin} />}
      </li>
    ))}</ol>
  );
  return (
    <>
      <PageHeader title="Инструкция: установка и работа" subtitle="Всё, что нужно сотруднику, скачивается с нашего сервера. Настройки — только в портале, в коде ничего не правится." />
      <div className="space-y-4">
        <Card title="Скачать">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line p-3">
              <div className="font-semibold">Dolphin Anty</div>
              <p className="help mb-2">Антидетект-браузер с профилями Pinterest. {dl.dolphin ? `Установщик для Windows, ${dl.dolphin.sizeMb} МБ${dl.dolphin.date ? `, от ${dl.dolphin.date}` : ""}.` : "Установщик ещё не загружен на сервер."}</p>
              {dl.dolphin ? <a href={dl.dolphin.url} className="btn-brand w-full">Скачать Dolphin Anty</a> : <span className="btn-ghost w-full opacity-60">Скачать (нет файла)</span>}
            </div>
            <div className="rounded-xl border border-line p-3">
              <div className="font-semibold">Zewex Uploader (агент)</div>
              <p className="help mb-2">Программа, которая получает задания и заливает файлы. {dl.agent ? `Версия ${dl.agent.version}, ${dl.agent.sizeMb} МБ. Ничего дополнительно ставить не нужно.` : "Сборка ещё не опубликована — появится после ближайшего деплоя."}</p>
              {dl.agent ? <a href={dl.agent.url} className="btn-brand w-full">Скачать Zewex Uploader {dl.agent.version}</a> : <span className="btn-ghost w-full opacity-60">Скачать (нет сборки)</span>}
            </div>
          </div>
          {admin && <p className="help mt-3">Админ: пустые слоты скриншотов ниже видите только вы — кликните по слоту и вставьте снимок Ctrl+V. Установщик Dolphin обновляется скриптом scripts/uploader/fetch-dolphin.sh, сборка агента собирается при деплое.</p>}
        </Card>
        <Card title="Установка на ПК сотрудника (один раз)"><StepList steps={INSTALL} /></Card>
        <Card title="Ежедневная работа"><StepList steps={WORK} from={INSTALL.length + 1} /></Card>
        <Card title="Если что-то пошло не так">
          <ul className="space-y-2 text-[13.5px]">{PROBLEMS.map(([t, d]) => <li key={t}><b>{t}.</b> <span className="text-muted">{d}</span></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
