import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessTeam } from "@/lib/pins/runs/actions";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveBoards, saveRecipe, toggleSiteActive } from "@/actions/pins";
import { mergeRecipe } from "@/lib/pins/types";
import { PINORA_TYPES } from "@/lib/pins/prompts/pinora";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
const LANGS = [["en", "English"], ["ru", "Русский"], ["uk", "Українська"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["pl", "Polski"], ["pt", "Português"]];
const NICHES = [["", "— не задана —"], ["decor", "Декор и интерьер"], ["nails", "Ногти"], ["hair", "Причёски"], ["outfit", "Одежда"], ["cooking", "Рецепты"], ["other", "Другое"]];

/** Настройки одного сайта: рецепт пинов и доски. Работа с прогонами — в сервисе Pinterest Pins. */
export default async function SiteSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const site = await prisma.pinSite.findUnique({ where: { id }, include: { boards: { orderBy: { sortOrder: "asc" } }, sets: { orderBy: { name: "asc" } }, team: true, _count: { select: { runs: true } } } });
  if (!site || !canAccessTeam(me, site.teamId)) notFound();
  const r = mergeRecipe(site.recipe);
  const wps = await prisma.siteAccess.findMany({ where: { teamId: site.teamId, kind: "wordpress" }, orderBy: { name: "asc" } })
    .then((rows) => rows.filter((w) => { const pr = (w.projects as string[] | null) ?? []; return !pr.length || pr.includes("pins"); }));
  const wp = wps.find((w) => w.id === r.publishing.wpConnectionId);

  return (
    <>
      <PageHeader back={{ href: "/sites", label: "Сайты" }} title={site.name} subtitle={`${site.team.name} · ${site.slug}`} actions={<Link href={`/pinterest/pins/sites/${id}`} className="btn-ghost">Открыть в Pinterest Pins</Link>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card title="Рецепт пинов" description="Что делать с каждой ссылкой. Снимок рецепта сохраняется в прогон при запуске.">
            <ActionForm action={saveRecipe} hidden={{ id }} className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Название сайта"><input name="name" className="input" defaultValue={site.name} /></Field>
                <Field label="Ниша"><select name="niche" className="input" defaultValue={site.niche}>{NICHES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Язык надписей и текстов"><select name="language" className="input" defaultValue={r.text.language}>{LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              </div>

              <fieldset className="rounded-xl border border-line p-3 sm:p-4">
                <legend className="px-1 font-medium">Пинов на одну ссылку</legend>
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="ИИ-пины"><input name="mixAi" type="number" min={0} max={20} className="input" defaultValue={r.mix.ai} /></Field>
                  <Field label="Фото из статьи"><input name="mixPhotos" type="number" min={0} max={20} className="input" defaultValue={r.mix.photos} /></Field>
                  <Field label="Canvas-пины"><input name="mixCanvas" type="number" min={0} max={20} className="input" defaultValue={r.mix.canvas} /></Field>
                  <Field label="Pinora-пины"><input name="mixPinora" type="number" min={0} max={20} className="input" defaultValue={r.mix.pinora} /></Field>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Фото из статьи"><select name="photosMode" className="input" defaultValue={r.photosMode}><option value="all">Все фото статьи</option><option value="featured_only">Только миниатюра (сайт рецептов)</option></select></Field>
                  <Field label="Доля фото со ссылкой на статью, %"><input name="photoLinkPercent" type="number" min={0} max={100} className="input" defaultValue={r.publishing.photoLinkPercent} /></Field>
                </div>
              </fieldset>

              <fieldset className="rounded-xl border border-line p-3 sm:p-4">
                <legend className="px-1 font-medium">Наборы стилей</legend>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><span className="label">ИИ-наборы</span><div className="space-y-1.5 max-h-56 overflow-auto">
                    {site.sets.filter((s) => s.setKind === "ai").map((s) => <label key={s.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="aiSetIds" value={s.id} defaultChecked={r.sets.aiSetIds.includes(s.id)} className="h-4 w-4" /> {s.name} <span className="help">· {(s.styleIds as string[]).length}{s.topic ? ` · ${s.topic}` : ""}</span></label>)}
                    {!site.sets.some((s) => s.setKind === "ai") && <p className="help">Наборов нет. Собрать их можно в разделе <Link href="/pinterest/pins/styles" className="underline">«Стили»</Link> сервиса.</p>}
                  </div></div>
                  <div><span className="label">Canvas-наборы</span><div className="space-y-1.5 max-h-56 overflow-auto">
                    {site.sets.filter((s) => s.setKind === "canvas").map((s) => <label key={s.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="canvasSetIds" value={s.id} defaultChecked={r.sets.canvasSetIds.includes(s.id)} className="h-4 w-4" /> {s.name} <span className="help">· {(s.styleIds as string[]).length}</span></label>)}
                    {!site.sets.some((s) => s.setKind === "canvas") && <p className="help">Canvas-наборов нет.</p>}
                  </div></div>
                  <div><span className="label">Типы Pinora</span><div className="space-y-1.5 max-h-56 overflow-auto">
                    {PINORA_TYPES.map((t) => <label key={t.id} className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="pinoraTypes" value={t.id} defaultChecked={r.sets.pinoraTypes.includes(t.id)} className="h-4 w-4" /> {t.ru}</label>)}
                  </div></div>
                </div>
              </fieldset>

              <fieldset className="rounded-xl border border-line p-3 sm:p-4">
                <legend className="px-1 font-medium">Тексты и надписи</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Аудитория"><select name="audience" className="input" defaultValue={r.text.audience}><option value="women">Женщины</option><option value="men">Мужчины</option><option value="mix">Смешанная</option></select></Field>
                  <Field label="Разнообразие элементов, %" hint="Какая доля пинов получает сезон, год, цифру, CTA, имя сайта."><input name="variety" type="number" min={0} max={100} className="input" defaultValue={r.text.variety} /></Field>
                  <Field label="Фирменный цвет (необязательно)"><input name="brandColor" className="input" placeholder="#FFC800" defaultValue={r.text.brandColor ?? ""} /></Field>
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-[14px]">
                  <label className="flex items-center gap-2"><input type="checkbox" name="elSeason" defaultChecked={r.text.elements.season} className="h-4 w-4" /> сезон</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="elYear" defaultChecked={r.text.elements.year} className="h-4 w-4" /> год</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="elNumber" defaultChecked={r.text.elements.number} className="h-4 w-4" /> цифра («7 идей»)</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="elCta" defaultChecked={r.text.elements.cta} className="h-4 w-4" /> призыв к действию</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="elSiteName" defaultChecked={r.text.elements.siteName} className="h-4 w-4" /> имя сайта на пине</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="hashtags" defaultChecked={r.text.hashtags} className="h-4 w-4" /> хэштеги в описании</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="multiBoard" defaultChecked={r.boards.multiBoard} className="h-4 w-4" /> до 3 досок на пин</label>
                </div>
              </fieldset>

              <fieldset className="rounded-xl border border-line p-3 sm:p-4">
                <legend className="px-1 font-medium">Публикация и расписание</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="WordPress для медиатеки" hint="Список берётся из «Доступы к сайтам».">
                    <select name="wpConnectionId" className="input" defaultValue={r.publishing.wpConnectionId ?? ""}>
                      <option value="">— не выбрано —</option>
                      {wps.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Домен для ссылок (необязательно)" hint="Если ссылки в пинах должны вести на другой домен."><input name="linkDomain" className="input" defaultValue={r.publishing.linkDomain} placeholder="site.com" /></Field>
                  <Field label="Пинов в день (не больше 100)"><input name="pinsPerDay" type="number" min={1} max={100} className="input" defaultValue={r.schedule.pinsPerDay} /></Field>
                  <Field label="Начинать с"><input name="startFrom" className="input" placeholder="следующий свободный день" defaultValue={r.schedule.startFrom === "next_free_day" ? "" : r.schedule.startFrom} /></Field>
                  <Field label="Модерация по умолчанию"><select name="moderationMode" className="input" defaultValue={r.schedule.moderationMode}><option value="required">Обязательна</option><option value="auto">Автоодобрение</option></select></Field>
                </div>
                <p className="help mt-2">Правила расписания едины: окно 30 дней, не больше 2 пинов со статьи в день, первый пин статьи в первые 3 дня, шаг 2–5 дней, время 08:00–21:00.</p>
              </fieldset>

              <SubmitButton pendingText="Сохраняю…">Сохранить рецепт</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="Доски Pinterest" description="По одной в строке. ИИ выбирает доску для каждой статьи из этого списка.">
            <ActionForm action={saveBoards} hidden={{ id }}>
              <textarea name="boards" className="input font-mono text-[13px]" rows={Math.min(16, Math.max(5, site.boards.length + 1))} defaultValue={site.boards.map((b) => b.name).join("\n")} />
              <SubmitButton pendingText="…">Сохранить доски</SubmitButton>
            </ActionForm>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Состояние">
            <dl className="space-y-2 text-[14px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Статус</dt><dd>{site.isActive ? <Badge tone="ok">активен</Badge> : <Badge>в архиве</Badge>}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Команда</dt><dd>{site.team.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">WordPress</dt><dd>{wp ? <Link href="/access" className="hover:underline">{wp.name}</Link> : <span className="text-muted">не выбран</span>}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Досок</dt><dd>{site.boards.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Прогонов</dt><dd>{site._count.runs}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Создан</dt><dd>{fmtDate(site.createdAt)}</dd></div>
            </dl>
            <div className="mt-4 space-y-2">
              <Link href={`/pinterest/pins/runs/new?site=${id}`} className="btn-primary w-full">Новый прогон</Link>
              <Link href={`/pinterest/pins/sites/${id}`} className="btn-ghost w-full">Запас пинов и прогоны</Link>
            </div>
          </Card>
          <ActionForm action={toggleSiteActive} hidden={{ id }}>
            {site.isActive
              ? <SubmitButton className="btn-danger w-full" confirm="Убрать сайт в архив? Он пропадёт из списка в сервисе, прогоны сохранятся." pendingText="…">В архив</SubmitButton>
              : <SubmitButton className="btn-ghost w-full" pendingText="…">Вернуть из архива</SubmitButton>}
          </ActionForm>
        </div>
      </div>
    </>
  );
}
