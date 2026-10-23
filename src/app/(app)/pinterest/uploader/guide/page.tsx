import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireUploader } from "@/lib/uploader/access";

export const dynamic = "force-dynamic";

const STEPS: Array<{ title: string; text: string }> = [
  { title: "Запустите Dolphin Anty", text: "На этом ПК должен быть открыт Dolphin Anty под аккаунтом команды, в нём — профили с выполненным входом в Pinterest. Агент работает только пока Dolphin открыт." },
  { title: "Добавьте агента в портале", text: "На странице «Агенты» нажмите «Добавить агента», назовите его (чей ПК) и скопируйте токен — он показывается один раз." },
  { title: "Скачайте и запустите Zewex Uploader", text: "Кнопка «Скачать» на странице «Агенты». Распакуйте ZIP в любую папку, запустите ZewexUploader.exe. При первом запуске вставьте токен портала. Окно агента можно свернуть — он остаётся в трее." },
  { title: "Проверьте связь", text: "Через минуту на странице «Агенты» ваш агент станет «На связи», а на «Сопоставлении» появится список профилей Dolphin." },
  { title: "Сопоставьте сайты и профили", text: "На странице «Сопоставление» напротив каждого сайта выберите его профиль Dolphin (один сайт = один профиль). Сохраняется сразу." },
  { title: "Запустите заливку", text: "На «Сегодня» отмечены сайты с файлом на день без отметки «залито». Выберите своего агента и нажмите «Запустить заливку». Агент по очереди откроет профили, зальёт файлы и закроет их; прогресс виден на странице запуска." },
  { title: "Проверка", text: "Через 10 минут после последнего сайта агент снова откроет профили и прочитает историю массовых загрузок — в запуске появится «опубликовано N». Отметка «залито · авто» встаёт в «Проектах» сразу после приёма файла." },
  { title: "Расписание", text: "На «Агентах» включите «Запускать каждый день в …» — заливка начнётся сама, если агент и Dolphin в это время запущены." },
];

const PROBLEMS: Array<{ title: string; text: string }> = [
  { title: "Dolphin Anty не запущен", text: "Агент ждёт: задания остаются в очереди. Откройте Dolphin — заливка продолжится сама." },
  { title: "Нужен вход", text: "В профиле слетела сессия Pinterest. Откройте профиль в Dolphin руками, войдите в аккаунт, затем на «Сопоставлении» поставьте состояние «Работает» и повторите неудачные в запуске." },
  { title: "Профиль уже открыт", text: "Закройте этот профиль в Dolphin: агент не трогает окна, открытые человеком." },
  { title: "Страница загрузки изменилась", text: "Pinterest обновил интерфейс. Сообщите администратору: в настройках можно задать новый адрес, при необходимости обновим агент." },
  { title: "Pinterest отклонил файл / ограничил аккаунт", text: "Аккаунт уходит на паузу (2 ч → 6 ч → сутки). Посмотрите скриншот в запуске; снять паузу можно на «Сопоставлении»." },
];

export default async function UploaderGuidePage() {
  await requireUploader();
  return (
    <>
      <PageHeader title="Инструкция" subtitle="Как подключить свой ПК и заливать выгрузки автоматически." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Подключение и запуск">
          <ol className="space-y-3 text-[13.5px]">{STEPS.map((s, i) => <li key={s.title} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand text-bg text-[12px] font-bold">{i + 1}</span><div><b>{s.title}</b><div className="text-muted">{s.text}</div></div></li>)}</ol>
          <p className="help mt-3"><Link href="/pinterest/uploader/agents" className="underline">Перейти к агентам</Link></p>
        </Card>
        <Card title="Если что-то пошло не так">
          <ul className="space-y-3 text-[13.5px]">{PROBLEMS.map((p) => <li key={p.title}><b>{p.title}</b><div className="text-muted">{p.text}</div></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
