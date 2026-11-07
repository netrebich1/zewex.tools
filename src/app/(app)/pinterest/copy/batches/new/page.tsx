import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { QuotaGrid } from "@/components/copy/QuotaGrid";
import { createCopyBatch } from "@/actions/copyBatch";
import { newBatchData } from "@/lib/copy/batchQueries";
import { QUOTA_CLASSES } from "@/lib/copy/batch";
import { GROUP_LABEL, NICHE_LABEL, VOL_LABEL, nicheLabel } from "@/lib/copy/keys";

export const dynamic = "force-dynamic";
/** Средний расход на текст одной статьи из 25 фото (план, секции, вступление, мета) — по журналу этапов за октябрь–ноябрь 2026. */
const COST_PER_ARTICLE = 0.015;

/** Форма новой партии: сайты, квоты по нишам и частотности, слово-фильтр, число фото, проверка перед публикацией. */
export default async function NewCopyBatchPage({ searchParams }: { searchParams: Promise<{ word?: string; season?: string }> }) {
  const me = await requireUser();
  const { word = "", season } = await searchParams;
  const noSeason = season !== "1";
  const d = await newBatchData(me, word, noSeason);
  const nextYear = new Date().getFullYear() + 1;
  const teams = [...new Set(d.sites.map((s) => s.team))];
  const classes = QUOTA_CLASSES.map((k) => ({ key: k, label: VOL_LABEL[k] }));

  return (
    <>
      <PageHeader title="Новая партия" subtitle="Отметьте сайты, впишите в таблицу, сколько статей каких ниш и частотности собрать, — остальное система сделает сама." back={{ href: "/pinterest/copy/batches", label: "Партии" }} />
      {!d.settings.builtAt ? (
        <Empty title="Запас ещё не посчитан" hint="Подождите 4–5 минут и обновите страницу." />
      ) : d.sites.length === 0 ? (
        <Empty title="Нет привязанных сайтов" hint="Сначала отметьте сайты на вкладке «Сайты и правила»." action={<Link href="/pinterest/copy/settings" className="btn-brand btn-sm">Сайты и правила</Link>} />
      ) : (
        <ActionForm action={createCopyBatch} className="space-y-5">
          <Card title="Сайты" description="Статьи раскладываются по отмеченным сайтам поровну; тема попадает только на сайт её группы ниш, где её ещё нет. Сайту без статей и ниши темы не ставятся.">
            <div className="space-y-4">
              {teams.map((t) => (
                <div key={t}>
                  <div className="mb-1.5 text-[13px] font-semibold">{t}</div>
                  <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {d.sites.filter((s) => s.team === t).map((s) => (
                      <label key={s.id} className={`inline-flex items-start gap-2 text-[14px] ${s.grp ? "" : "opacity-60"}`}>
                        <input type="checkbox" name="site" value={s.id} disabled={!s.grp} className="mt-1" />
                        <span>{s.name}<div className="help">{s.grp ? GROUP_LABEL[s.grp] : "ниша неизвестна"}{s.niches.length ? ` · ${s.niches.map(nicheLabel).join(", ")}` : ""} · статей {s.articles}</div></span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Сколько и каких статей" description="Строки — ниши, столбцы — частотность темы. Например: ногти ВЧ 100, СЧ 100, НЧ 100.">
            <QuotaGrid niches={d.niches} labels={NICHE_LABEL} classes={classes} avail={d.avail} costPerArticle={COST_PER_ARTICLE} photos={d.settings.photosPerArticle} />
          </Card>

          <Card title="Дополнительно">
            <div className="flex flex-wrap items-end gap-4">
              <label className="block"><span className="label">Название партии</span><input name="name" placeholder={`Партия ${new Date().toLocaleDateString("ru-RU")}`} className="input py-1.5 w-64" /></label>
              <label className="block"><span className="label">Только темы со словом</span><input name="word" defaultValue={word} placeholder="bob, almond, christmas…" className="input py-1.5 w-56" /></label>
              <label className="block"><span className="label">Год в ключе</span><input name="year" type="number" min={2024} max={2035} defaultValue={nextYear} placeholder="как у донора" className="input py-1.5 w-28" /></label>
              <Link href={`/pinterest/copy/batches/new?word=${encodeURIComponent(word)}${noSeason ? "" : "&season=1"}`} className="btn-ghost btn-sm mb-0.5" prefetch={false}>Пересчитать «есть»</Link>
            </div>
            <label className="mt-3 inline-flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="noSeason" defaultChecked={noSeason} />
              Без сезонных тем <span className="help">(christmas, halloween, summer, fall… — для вечнозелёных статей; «есть» выше посчитано {noSeason ? "без сезонных" : "со всеми темами"})</span>
            </label>
            <label className="mt-3 inline-flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="review" defaultChecked={d.settings.reviewBeforePublish} />
              Показывать статьи в модерации «Статей» перед публикацией <span className="help">(выключено — публикуются сами)</span>
            </label>
            <p className="help mt-2">Год подставляется в ключ вместо года статьи-донора (пусто — как у донора). Чтобы «есть» учитывало слово-фильтр и сезонность, нажмите «Пересчитать» — форму это не отправляет. Сборка идёт до 15 статей в минуту, текст — по лимитам сайтов в «Статьях» (~1,5 минуты на статью).</p>
          </Card>

          <SubmitButton className="btn-brand" pendingText="Планирую темы…">Запустить партию</SubmitButton>
        </ActionForm>
      )}
    </>
  );
}
