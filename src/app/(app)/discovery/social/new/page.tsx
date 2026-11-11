import { requireUser } from "@/lib/auth";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Field, PageHeader } from "@/components/ui";
import { SocialNav } from "@/components/social/SocialNav";
import { launchSocialRun } from "@/actions/social";
import { DEFAULT_NETWORKS, MAX_RUN_ITEMS, NETWORKS, todayKyiv } from "@/lib/social/types";
import { addDays } from "@/lib/social/metricool";
import { TTS_VOICES } from "@/lib/social/voices";

export const dynamic = "force-dynamic";

export default async function SocialNew() {
  await requireUser();
  return (
    <>
      <SocialNav />
      <PageHeader title="Новый прогон" subtitle="Одна статья = по одному посту в каждую отмеченную сеть. Тексты пишутся заново под каждую сеть, фото берутся из статьи." back={{ href: "/discovery/social", label: "Прогоны" }} />
      <ActionForm action={launchSocialRun} className="space-y-5">
        <Card title="1. Статьи" description={`Ссылки на опубликованные статьи, по одной в строке (до ${MAX_RUN_ITEMS} за прогон) — или адрес сайта, и инструмент сам возьмёт свежие статьи нужных тем.`}>
          <div className="space-y-4">
            <Field label="Ссылки на статьи">
              <textarea name="urls" rows={6} className="input w-full font-mono !text-[13px]" placeholder={"https://site.com/statya-1/\nhttps://site.com/statya-2/"} />
            </Field>
            <div className="grid gap-4 rounded-xl border border-line p-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Field label="…или взять свежие статьи сайта" hint="Работает, если поле ссылок пустое. Берутся только рубрики про моду, стиль, одежду, ногти и волосы; «Поради», новости и звёзды не берутся. Статьи из прошлых прогонов пропускаются.">
                  <input name="site" className="input w-full" placeholder="beautydaily.com.ua" maxLength={200} />
                </Field>
              </div>
              <Field label="Сколько статей"><input name="siteCount" type="number" min={1} max={100} defaultValue={10} className="input w-full" /></Field>
            </div>
            <Field label="Название прогона" hint="Необязательно: без него — домен и дата.">
              <input name="name" className="input w-full sm:!w-[420px]" maxLength={120} />
            </Field>
          </div>
        </Card>

        <Card title="2. Соцсети" description="Для каждой сети свой текст, длина и число фото. Сети, которым нужно фото, пропускают статьи без фото.">
          <div className="grid gap-2 sm:grid-cols-2">
            {NETWORKS.map((n) => (
              <label key={n.key} className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2.5">
                <input type="checkbox" name="networks" value={n.key} defaultChecked={DEFAULT_NETWORKS.includes(n.key)} className="mt-1" />
                <span>
                  <span className="font-medium">{n.label}</span>
                  <span className="help block">{n.video ? "ролик 9:16 из фото статьи: озвучка и субтитры · подпись до " + n.maxChars + " знаков" : <>до {n.maxChars} знаков · до {Math.min(10, n.maxImages)} фото{n.linkInText ? " · со ссылкой" : " · без ссылки в тексте"}{n.needsImage ? " · только с фото" : ""}</>}</span>
                </span>
              </label>
            ))}
          </div>
        </Card>

        <Card title="3. Тексты">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Язык постов" hint="«auto» — язык статьи. Или напишите язык: украинский, English, Deutsch.">
              <input name="language" defaultValue="auto" className="input w-full" maxLength={40} />
            </Field>
            <Field label="Фото в посте, не больше" hint="Сверху действует лимит сети (X и Bluesky — 4).">
              <input name="maxImages" type="number" min={1} max={10} defaultValue={5} className="input w-full" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Пожелания к текстам" hint="Необязательно: тон, обращение к читателю, чего избегать, призыв.">
                <textarea name="notes" rows={3} className="input w-full" maxLength={2000} />
              </Field>
            </div>
            <Field label="Голос озвучки видео" hint="Для видео-сетей. Один ролик на статью идёт во все отмеченные видео-сети; сборка — около минуты на статью.">
              <select name="voice" defaultValue="coral" className="input w-full">{TTS_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </Field>
            <Field label="Категория YouTube" hint="Для Shorts, как в списке шаблона Metricool (например HOWTO_AND_STYLE, EDUCATION, ENTERTAINMENT).">
              <input name="ytCategory" defaultValue="HOWTO_AND_STYLE" className="input w-full" maxLength={40} />
            </Field>
            <label className="flex items-center gap-2"><input type="checkbox" name="emoji" defaultChecked /> Эмодзи там, где уместно</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="utm" defaultChecked /> Метки utm в ссылках (переходы по сетям видны в аналитике)</label>
          </div>
        </Card>

        <Card title="4. Расписание" description="Статьи идут по порядку списка. Время — по часовому поясу бренда в Metricool. Расписание можно поменять и после прогона.">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Первый день" hint="По умолчанию завтра: время в прошлом Metricool не примет."><input name="startDate" type="date" defaultValue={addDays(todayKyiv(), 1)} className="input w-full" /></Field>
            <Field label="Статей в день"><input name="perDay" type="number" min={1} max={50} defaultValue={3} className="input w-full" /></Field>
            <Field label="Публиковать с, час"><input name="fromHour" type="number" min={0} max={22} defaultValue={9} className="input w-full" /></Field>
            <Field label="до, час"><input name="toHour" type="number" min={1} max={23} defaultValue={21} className="input w-full" /></Field>
            <div className="sm:col-span-2">
              <Field label="Бренд в Metricool" hint="Точное название бренда, с учётом регистра. Пусто — посты встанут в бренд, открытый при импорте.">
                <input name="brand" className="input w-full" maxLength={120} />
              </Field>
            </div>
            <label className="flex items-center gap-2 sm:col-span-2 sm:mt-6"><input type="checkbox" name="draft" /> Импортировать черновиками (проверить в Metricool перед публикацией)</label>
          </div>
        </Card>

        <SubmitButton className="btn-brand" pendingText="Запускаю…">Запустить прогон</SubmitButton>
      </ActionForm>
    </>
  );
}
