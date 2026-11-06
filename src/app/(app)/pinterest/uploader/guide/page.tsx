import Link from "next/link";
import { stat } from "node:fs/promises";
import type { ReactNode } from "react";
import { Card, PageHeader } from "@/components/ui";
import { isAdmin, requireUploader } from "@/lib/uploader/access";
import { downloads } from "@/lib/uploader/release";
import { myReadiness } from "@/lib/uploader/teams";
import { absPath, publicUrl } from "@/lib/pins/storage";
import { PasteShot } from "@/components/uploader/PasteShot";
import { TeamReadinessCard } from "@/components/uploader/TeamReadiness";

export const dynamic = "force-dynamic";

/**
 * Инструкция (переписана 2026-11-06 после разделения Dolphin по командам): как устроено → настройка команды (лид/админ, один раз)
 * → настройка ПК → ежедневная работа → проблемы. Вверху — живая «Готовность команды», чтобы сразу видеть, какой шаг не сделан.
 * Скриншоты — слоты `uploader/guide/<имя>.jpg`: админ кликает по пустому слоту и вставляет снимок Ctrl+V.
 */
type Step = { id: string; title: string; where?: string; href?: string; text: ReactNode[]; shot?: { name: string; caption?: string } };

const L = ({ href, children }: { href: string; children: ReactNode }) => <Link href={href} className="underline">{children}</Link>;

const HOW: ReactNode[] = [
  <><b>Команда портала</b> (Zewex, PinOra, WexOra) = <b>свой аккаунт Dolphin Anty</b> со своими профилями. Аккаунты команд не общие: у каждой команды свой логин в Dolphin.</>,
  <><b>Токен Dolphin API</b> — ключ к аккаунту Dolphin команды. Он хранится в портале у команды (<L href="/pinterest/uploader/settings">Настройки</L>), сотрудникам его вводить не нужно.</>,
  <><b>Агент</b> (программа Zewex Uploader на ПК) привязан к одной команде. Он берёт токен своей команды, читает профили из Dolphin на этом ПК и отправляет их в портал с меткой команды.</>,
  <><b>Важно:</b> агент видит те профили, которые видно в окне Dolphin на этом ПК. Поэтому Dolphin на ПК должен быть открыт <b>в аккаунте той же команды</b>, что и агент. Если в Dolphin вошли в чужой аккаунт, агент это заметит, профили не отправит и напишет «Dolphin на этом ПК вошёл в другой аккаунт».</>,
  <>На <L href="/pinterest/uploader/mapping">Сопоставлении</L> сайту команды можно выбрать <b>только профиль своей команды</b>. Заливку по сайту делает только агент этой команды.</>,
  <>Сайты в разделе показываются по команде, выбранной в шапке портала. Если команда не выбрана, администратор видит все команды сразу: так задумано, это не смешивание.</>,
  <><b>Итого: один ПК = один аккаунт Dolphin = одна команда = один агент.</b></>,
];

const TEAM: Step[] = [
  { id: "team-dolphin", title: "Аккаунт Dolphin Anty команды", where: "Сайт dolphin-anty.com",
    text: ["У каждой команды свой аккаунт Dolphin (логин и пароль хранит лид). В нём лежат профили с аккаунтами Pinterest сайтов команды.", "Профили других команд в нём быть не должны: Zewex работает в своём аккаунте, PinOra — в своём."] },
  { id: "team-token", title: "Токен Dolphin API → в портал", where: "Заливка в Pinterest → Настройки", href: "/pinterest/uploader/settings",
    text: ["Войдите на dolphin-anty.com аккаунтом команды → раздел API → создайте токен и скопируйте его.", "В портале: Настройки → «Токены Dolphin Anty API по командам» → строка вашей команды → вставьте → «Сохранить». Менять может лид команды или администратор.", "Свой токен вводите только в строку своей команды: токен одной команды больше не попадает к другим."],
    shot: { name: "t2-team-token", caption: "Настройки: токен в строке своей команды" } },
];

const PC: Step[] = [
  { id: "dolphin", title: "Установите Dolphin Anty и войдите в аккаунт СВОЕЙ команды", where: "Кнопка «Скачать Dolphin Anty» выше",
    text: ["Запустите установщик, далее всё по умолчанию. Откройте Dolphin и войдите аккаунтом своей команды.", "Проверьте: в окне Dolphin видны профили сайтов вашей команды, а внизу слева стоит почта аккаунта команды. Если там чужие профили, выйдите и войдите заново в нужный аккаунт.", "Открывать профили руками не нужно: это делает агент."],
    shot: { name: "p1-dolphin-account", caption: "Dolphin: профили своей команды, почта аккаунта внизу" } },
  { id: "token", title: "Добавьте агента с командой и скопируйте токен агента", where: "Заливка в Pinterest → Агенты", href: "/pinterest/uploader/agents",
    text: ["Нажмите «Добавить агента», укажите, чей это ПК, и выберите команду. Это та же команда, в чей аккаунт вошли в Dolphin.", "Появится токен zxu_…: скопируйте его кнопкой, он показывается один раз. Это токен агента, а не Dolphin."],
    shot: { name: "p2-agent-add", caption: "Агенты: название, команда, токен zxu_…" } },
  { id: "agent", title: "Скачайте и запустите Zewex Uploader", where: "Кнопка «Скачать Zewex Uploader» выше",
    text: ["Распакуйте ZIP в любую папку (например, Документы\\ZewexUploader) и запустите ZewexUploader.cmd. Больше ничего ставить не нужно.", "В чёрном окне вставьте токен zxu_… (правая кнопка мыши → Вставить) и нажмите Enter. Окно можно свернуть, но не закрывать: пока оно открыто, агент на связи.", "На одном ПК — одно окно агента. Новые версии агент ставит сам."],
    shot: { name: "p3-agent-run", caption: "Окно агента после вставки токена" } },
  { id: "check", title: "Проверьте готовность команды", where: "Блок «Готовность» вверху этой страницы, на «Агентах» и «Сопоставлении»",
    text: ["Все четыре строки должны быть с ✓: токен команды, агент на связи, профили Dolphin получены (сколько и когда), сайты сопоставлены.", "Первая строка с ✗ показывает, что сделать. Профили приходят через минуту после запуска агента, потом обновляются раз в час. Чтобы обновить сразу, перезапустите агент."] },
  { id: "mapping", title: "Сопоставьте сайты и профили", where: "Заливка в Pinterest → Сопоставление", href: "/pinterest/uploader/mapping",
    text: [<><b>Правило:</b> профиль в Dolphin называется доменом сайта («azureglam.com»; допускаются «nimorix.com new», «zentrosy.com1») — или домен вписан в тег либо заметку профиля. Тогда портал сам предложит пару: «Принять» или «Принять все однозначные».</>, "Нет предложения — выберите профиль руками. Рядом с именем показан ID профиля Dolphin: по нему различают дубли.", "В списке только профили вашей команды. Один сайт = один аккаунт Pinterest = один профиль."],
    shot: { name: "p5-mapping", caption: "Сопоставление: предложения и выбор профиля" } },
  { id: "sets", title: "Наборы сайтов (по желанию)", where: "Заливка в Pinterest → Наборы", href: "/pinterest/uploader/sets",
    text: ["Сохраните галочками сайты, которые сейчас в работе, как набор. Его можно выбрать в форме запуска и в расписании агента."] },
];

const WORK: Step[] = [
  { id: "start", title: "Запустить заливку", where: "Заливка в Pinterest → Сегодня", href: "/pinterest/uploader",
    text: ["Выберите в шапке свою команду. Отмечены сайты с файлом на день без отметки «залито». Выберите агента своей команды (и набор, если нужен) и нажмите «Запустить заливку».", "Агент по очереди открывает профили, листает ленту, загружает файл и закрывает профиль. Между сайтами — пауза, как у человека."],
    shot: { name: "w1-today", caption: "Форма запуска на «Сегодня»" } },
  { id: "run", title: "Следить за запуском", where: "Заливка в Pinterest → Запуски", href: "/pinterest/uploader/runs",
    text: ["В карточке запуска видно каждый сайт: шаг агента, «файл принят», ошибки по-русски, скриншоты (клик — увеличить, стрелки — листать).", "Проверка: после заливки агент открывает вкладку Created профиля, считает пины в «Scheduled Pins» и делает скриншот. Результат «в расписании: N» виден в запуске и на «Сегодня».", "Если заливка не удалась, рядом есть кнопка «скачать CSV»: этот файл можно залить руками."],
    shot: { name: "w2-run", caption: "Карточка запуска" } },
  { id: "crm", title: "Отметки в «Проектах»", where: "Проекты → сайт → Выгрузки", href: "/pinterest/projects",
    text: ["После приёма файла в карточке проекта ставится «залито · авто» со скриншотом. В ленту пишутся «Залито», «Заливка не удалась» и «Заливка проверена»."] },
  { id: "schedule", title: "Расписание", where: "Заливка в Pinterest → Агенты", href: "/pinterest/uploader/agents",
    text: ["У своего агента включите «Запускать каждый день в …» и выберите набор. Заливка начнётся сама, если в это время Dolphin и агент запущены."] },
];

const PROBLEMS: Array<[string, ReactNode]> = [
  ["Не вижу свои профили на «Сопоставлении»", <>Смотрите «Готовность команды»: первая строка с ✗ и есть причина. Чаще всего у команды нет токена, у агента не та команда или Dolphin на ПК вошёл в чужой аккаунт. После исправления перезапустите агент.</>],
  ["В окне Dolphin чужие профили", "Dolphin на этом ПК открыт в аккаунте другой команды. Выйдите из аккаунта (меню профиля внизу слева) и войдите в аккаунт своей команды."],
  ["Вижу сайты другой команды", "Выберите свою команду в шапке портала. Администратор без выбранной команды видит все."],
  ["«Профиль из Dolphin другой команды»", "Сайту можно присвоить только профиль его команды, а запустить — агентом этой команды. Создайте или найдите профиль в аккаунте Dolphin своей команды."],
  ["Агент «не на связи»", "Окно агента закрыто или нет интернета. Запустите ZewexUploader.cmd снова: токен повторно вводить не нужно."],
  ["Dolphin Anty не запущен", "Задания ждут в очереди. Откройте Dolphin — заливка продолжится сама."],
  ["Прокси профиля не отвечает", "Dolphin не смог проверить прокси профиля. Смените прокси в Dolphin; если у сайта есть второй профиль с тем же доменом, агент попробует его сам."],
  ["Нужен вход", "В профиле слетела сессия Pinterest. Откройте профиль в Dolphin руками и войдите. Затем на «Сопоставлении» поставьте «Работает», а в запуске нажмите «Повторить неудачные»."],
  ["Профиль уже открыт", "Закройте этот профиль в Dolphin: агент не трогает окна, открытые человеком."],
  ["Pinterest отклонил файл или ограничил аккаунт", "Аккаунт уходит на паузу (2 ч → 6 ч → сутки). Посмотрите скриншот в запуске; снять паузу можно на «Сопоставлении»."],
  ["Сайта нет в списке", "Вы видите только сайты своей команды, к которым у вас есть доступ (раздел «Сайты», блок «Кто видит»). Попросите лида или администратора."],
];

async function shotUrl(name: string): Promise<string | null> {
  const rel = `uploader/guide/${name}.jpg`;
  try { const s = await stat(absPath(rel)); return `${publicUrl(rel)}?v=${Math.round(s.mtimeMs)}`; } catch { return null; }
}

export default async function UploaderGuidePage() {
  const me = await requireUploader();
  const admin = isAdmin(me);
  const [dl, ready] = await Promise.all([downloads(), myReadiness(me)]);
  const urls = new Map<string, string | null>();
  await Promise.all([...TEAM, ...PC, ...WORK].filter((s) => s.shot).map(async (s) => urls.set(s.shot!.name, await shotUrl(s.shot!.name))));
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
      <PageHeader title="Инструкция: как устроено и как настроить" subtitle="Заливка в Pinterest по командам: у каждой команды свой аккаунт Dolphin, свой токен, свои агенты, профили и сайты." />
      <div className="space-y-4">
        <TeamReadinessCard rows={ready} title="Готовность вашей команды сейчас" />
        <Card title="Как это устроено">
          <ul className="ml-5 list-disc space-y-1.5 text-[13.5px]">{HOW.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <div className="mt-3 rounded-lg bg-ink/5 px-3 py-2 font-mono text-[12.5px]">Команда → аккаунт Dolphin команды → токен API (Настройки) → агент команды на ПК (Dolphin открыт в том же аккаунте) → профили команды → сайты команды</div>
        </Card>
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
        <Card title="А. Настройка команды — один раз (лид или администратор)"><StepList steps={TEAM} /></Card>
        <Card title="Б. Настройка ПК сотрудника — один раз на каждый ПК"><StepList steps={PC} from={TEAM.length + 1} /></Card>
        <Card title="В. Ежедневная работа"><StepList steps={WORK} from={TEAM.length + PC.length + 1} /></Card>
        <Card title="Если что-то пошло не так">
          <ul className="space-y-2 text-[13.5px]">{PROBLEMS.map(([t, d]) => <li key={t}><b>{t}.</b> <span className="text-muted">{d}</span></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
