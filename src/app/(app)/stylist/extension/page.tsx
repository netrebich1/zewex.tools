import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { issueExtToken } from "@/actions/stylist";
import { extVersion } from "@/lib/stylist/ext";
import { canSee } from "@/lib/stylist/queries";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function StylistExtension() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const [token, version] = await Promise.all([prisma.stExtToken.findUnique({ where: { userId: me.id } }), extVersion()]);
  return (
    <>
      <StNav />
      <PageHeader
        title="Расширение для Chrome"
        subtitle="Кнопка «Z» на страницах магазинов одежды. С любой вещи, которую вы открыли на сайте магазина, она в один клик попадает в каталог, избранное или образ — с ценой, артикулом и размерами. Так добавляются вещи из магазинов, которые не собираются автоматически (Mango, H&M, Next, Guess, Tommy Hilfiger, Levi's и другие)."
        actions={<a href="/api/stylist/extension" className="btn-brand">Скачать расширение (v{version})</a>}
      />

      <Card title="Установка — один раз" className="mb-5">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-relaxed">
          <li>Нажмите «Скачать расширение» и распакуйте архив в любую папку (правой кнопкой → «Извлечь всё»). Папку потом не удаляйте.</li>
          <li>В Chrome откройте адрес <b className="select-all font-mono">chrome://extensions</b> и включите справа вверху «Режим разработчика».</li>
          <li>Нажмите «Загрузить распакованное расширение» и выберите папку <b>zewex-stylist</b> из архива.</li>
          <li>Ниже на этой странице нажмите «Выдать токен», скопируйте его.</li>
          <li>Нажмите на значок расширения (пазл справа от адресной строки → «Zewex Стилист»), вставьте токен, впишите город и нажмите «Сохранить и проверить». Должно появиться «Связь есть».</li>
        </ol>
      </Card>

      <Card title="Токен расширения" className="mb-5" description="Токен связывает расширение с вашим входом на портале. Новый токен отменяет прежний.">
        <p className="mb-3 text-[14px]">{token ? <>Токен выдан {fmtDate(token.createdAt)} (начинается с <span className="font-mono">{token.hint}…</span>){token.lastUsedAt ? <>, расширение выходило на связь {fmtDate(token.lastUsedAt)}</> : <>, расширение ещё не подключалось</>}.</> : "Токен ещё не выдавался."}</p>
        <ActionForm action={issueExtToken}>
          <SubmitButton confirm={token ? "Выдать новый токен? Прежний перестанет работать — его нужно будет заменить в расширении." : undefined}>{token ? "Выдать новый токен" : "Выдать токен"}</SubmitButton>
        </ActionForm>
      </Card>

      <Card title="Как пользоваться">
        <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] leading-relaxed">
          <li><b>Добавить вещь.</b> Откройте страницу вещи на сайте магазина → слева внизу кнопка «Z» → «В каталог», «♥ В избранное» или выберите образ, впишите нужный размер и нажмите «В образ».</li>
          <li><b>Наличие в магазинах Zara.</b> На странице вещи нажмите на сайте «Check in-store availability», отметьте размеры, выберите город — расширение само запишет в образ, в каких магазинах вещь есть (или что её нет), с городом и временем проверки.</li>
          <li><b>Город.</b> Задаётся в окне расширения и подставляется в поиск магазинов. Для Мальты достаточно одного города, для Украины или Италии меняйте его под клиента — результат всегда записывается вместе с городом.</li>
          <li><b>Остальные магазины.</b> Если сайт показывает наличие по магазинам на странице вещи — проверьте там и отметьте в образе «есть» или «нет». Автоматическое чтение добавляется по одному сайту: скажите, на каких магазинах оно нужнее всего.</li>
          <li><b>Если вещь уже есть в каталоге</b> (Zara, Massimo Dutti, Bershka…), расширение не создаёт дубль, а обновляет её цену и размеры.</li>
        </ul>
      </Card>
    </>
  );
}
