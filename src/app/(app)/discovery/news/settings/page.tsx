import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, Badge, Card, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { NewsNav } from "@/components/news/NewsNav";
import { createProject, saveProxy, saveSettings, testBot } from "@/actions/news";
import { canManageProject, requireProject } from "@/lib/news/access";
import { agoText } from "@/lib/news/query";
import { CATEGORIES, CATEGORY_LABELS, DEFAULT_SETTINGS, parseSettings } from "@/lib/news/types";

export const dynamic = "force-dynamic";

function Num({ name, label, value, hint }: { name: string; label: string; value: number; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input name={name} className="input" defaultValue={String(value)} inputMode="decimal" />
      {hint && <span className="help mt-0.5 block">{hint}</span>}
    </label>
  );
}

function Words({ name, label, value, hint }: { name: string; label: string; value: string[]; hint: string }) {
  return (
    <label className="block">
      <span className="label">{label} ({value.length})</span>
      <textarea name={name} className="input min-h-[110px] text-[13px]" defaultValue={value.join(", ")} />
      <span className="help mt-0.5 block">{hint}</span>
    </label>
  );
}

export default async function NewsSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const { project, list } = await requireProject(me, sp(q, "project"));
  const admin = me.role === "ADMIN";
  const [teams, sites, proxies] = await Promise.all([
    admin ? prisma.team.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.siteAccess.findMany({ where: admin ? {} : { teamId: { in: me.teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true, baseUrl: true } }),
    admin ? prisma.newsProxy.findMany({ orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
  ]);
  const manage = project ? canManageProject(me, project) : false;
  const s = project ? parseSettings(project.settings) : DEFAULT_SETTINGS;

  return (
    <>
      <NewsNav projects={list.map((p) => ({ id: p.id, name: p.name }))} current={project?.id ?? null} />
      <PageHeader title="Настройки" subtitle="Расписание, пороги ленты, бюджет, фильтры до LLM и Telegram-бот — у каждого проекта (сайта) свои. Изменения действуют со следующего прогона." />

      {project && !manage && <div className="mb-4"><Alert tone="warn">Менять настройки может администратор или лидер команды проекта — здесь только просмотр.</Alert></div>}

      {project && (
        <ActionForm action={saveSettings} className="space-y-5" hidden={{ project: project.id }}>
          <Card title="Проект">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block"><span className="label">Название</span><input name="name" className="input" defaultValue={project.name} /></label>
              <label className="block"><span className="label">Адрес сайта</span><input name="siteUrl" className="input" defaultValue={project.siteUrl} placeholder="https://beautydaily.com.ua" /></label>
              <label className="block"><span className="label">Сайт в «Сайтах» (для черновиков WordPress, этап 2)</span>
                <select name="siteAccessId" className="input" defaultValue={project.siteAccessId ?? ""}>
                  <option value="">— не выбран —</option>
                  {sites.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.baseUrl}</option>)}
                </select>
              </label>
              {admin && (
                <label className="block"><span className="label">Команда (с её ключей идёт расход)</span>
                  <select name="teamId" className="input" defaultValue={project.teamId}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                </label>
              )}
              <label className="flex items-center gap-2 pt-6 text-[14px]"><input type="checkbox" name="isActive" defaultChecked={project.isActive} /> Проект включён (плановые прогоны идут)</label>
            </div>
          </Card>

          <Card title="Расписание и лента">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Num name="intervalMin" label="Прогон раз в, мин" value={s.intervalMin} hint="40 — стартовое значение ТЗ" />
              <Num name="maxAgeHours" label="Материалы не старше, ч" value={s.maxAgeHours} />
              <Num name="topN" label="Карточек в ленте (топ-N за сутки)" value={s.topN} hint="Редакция берёт 10–50 тем в день" />
              <Num name="urgentScore" label="«Срочно» и Telegram от балла" value={s.urgentScore} />
              <Num name="minScore" label="Не показывать ниже балла" value={s.minScore} />
              <Num name="clusterWindowHours" label="Кластер принимает материалы, ч" value={s.clusterWindowHours} />
              <Num name="clusterSim" label="Склейка: близость" value={s.clusterSim} hint="0.5–0.99, выше — строже" />
              <Num name="clusterSimEntity" label="Склейка при той же сущности" value={s.clusterSimEntity} />
            </div>
            <fieldset className="mt-4">
              <legend className="label">Категории в ленте</legend>
              <div className="flex flex-wrap gap-3">
                {CATEGORIES.filter((c) => c !== "other").map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-[14px]"><input type="checkbox" name="targetCategories" value={c} defaultChecked={s.targetCategories.includes(c)} /> {CATEGORY_LABELS[c]}</label>
                ))}
              </div>
            </fieldset>
          </Card>

          <Card title="Бюджет и модели" description="Расход — с ключей OpenRouter команды проекта по правилам слотов инструмента «Новости для Discover» (страница инструмента → правила). Пустое поле модели — модель из правила.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Num name="monthlyBudgetUsd" label="Бюджет в месяц, $" value={s.monthlyBudgetUsd} hint="Дневной лимит = месяц / 30 × 1.5" />
              <Num name="classifyPerDay" label="Классификаций в сутки" value={s.classifyPerDay} />
              <label className="block"><span className="label">Модель классификации</span><input name="classifyModel" className="input" defaultValue={s.classifyModel} /></label>
              <label className="block"><span className="label">Модель эмбеддингов</span><input name="embedModel" className="input" defaultValue={s.embedModel} /></label>
              <label className="flex items-center gap-2 text-[14px] sm:col-span-2"><input type="checkbox" name="embedFilter" defaultChecked={s.embedFilter} /> Фильтр по эмбеддингу (включается сам, когда наберётся по 40 примеров «нашего» и «не нашего»)</label>
              <Num name="embedMargin" label="Запас фильтра эмбеддинга" value={s.embedMargin} hint="Больше — мягче фильтр" />
            </div>
          </Card>

          <Card title="Фильтры до LLM" description="Совпадение по началу слова: «зірк» ловит «зірка, зірки, зіркою». Фразы из нескольких слов тоже можно. Пустое поле — вернуть список по умолчанию.">
            <div className="grid gap-4 lg:grid-cols-2">
              <Words name="stopWords" label="Стоп-слова" value={s.stopWords} hint="Война, политика, криминал, происшествия: материал отсекается сразу, даже со звездой." />
              <Words name="stopExceptions" label="Исключения стоп-слов" value={s.stopExceptions} hint="Слова, которые начинаются со стоп-основы, но к ней не относятся: «судячи», «ракетка», «світське»." />
              <Words name="stopRubrics" label="Стоп-рубрики источников" value={s.stopRubrics} hint="Рубрика ленты «Політика», «Війна», «Спорт» — отсекается. Не действует, если у источника задан список своих рубрик." />
              <Words name="nicheWords" label="Нишевые слова (белый список)" value={s.nicheWords} hint="Без сущности из списка материал проходит, только если есть одно из этих слов или источник профильный." />
            </div>
          </Card>

          <Card title="Google News и Trends">
            <div className="grid gap-4 lg:grid-cols-2">
              <Words name="gnewsQueries" label="Нишевые запросы Google News (каждый прогон)" value={s.gnewsQueries} hint="Через запятую. К каждому добавляется when:1d, язык и страна — ниже." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Num name="gnewsEntitiesPerQuery" label="Сущностей в одном запросе (через OR)" value={s.gnewsEntitiesPerQuery} />
                <Num name="gnewsGroupsPerRun" label="Групп второго ряда за прогон" value={s.gnewsGroupsPerRun} />
                <Num name="topEntityWeight" label="Первый ряд — вес от" value={s.topEntityWeight} />
                <label className="block"><span className="label">Язык / страна / ceid</span>
                  <div className="flex gap-1.5"><input name="hl" className="input" defaultValue={s.hl} /><input name="gl" className="input" defaultValue={s.gl} /><input name="ceid" className="input" defaultValue={s.ceid} /></div>
                </label>
                <label className="flex items-center gap-2 text-[14px] sm:col-span-2"><input type="checkbox" name="autoProxy" defaultChecked={s.autoProxy} /> При ответах 403 / 429 повторять через прокси</label>
              </div>
            </div>
          </Card>

          <Card title="Telegram" description="Срочные кластеры (балл от порога «Срочно») и предупреждение о 80% бюджета. Бота создайте в @BotFather, добавьте в чат или канал и впишите его id или @имя канала.">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block"><span className="label">Токен бота {project.tgTokenEnc ? <Badge tone="ok">сохранён</Badge> : null}</span><input name="tgToken" type="password" className="input" autoComplete="off" placeholder={project.tgTokenEnc ? "оставьте пустым, чтобы не менять" : "123456:ABC…"} /></label>
              <label className="block"><span className="label">Чат</span><input name="tgChatId" className="input" defaultValue={project.tgChatId ?? ""} placeholder="-100… или @channel" /></label>
              <div className="space-y-1 pt-6 text-[14px]">
                <label className="flex items-center gap-2"><input type="checkbox" name="telegramAlerts" defaultChecked={s.telegramAlerts} /> Слать алерты</label>
                <label className="flex items-center gap-2 text-danger"><input type="checkbox" name="tgClear" /> Удалить токен и чат</label>
              </div>
            </div>
          </Card>

          {manage && <SubmitButton className="btn-brand" pendingText="Сохраняю…">Сохранить настройки</SubmitButton>}
        </ActionForm>
      )}

      {project && manage && project.tgTokenEnc && (
        <ActionForm action={testBot} className="mt-3" hidden={{ project: project.id }}>
          <SubmitButton className="btn-ghost btn-sm" pendingText="Отправляю…">Проверить бота — отправить тестовое сообщение</SubmitButton>
        </ActionForm>
      )}

      {admin && (
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <Card title="Прокси модуля" description="Для сайтов с защитой от ботов (fakty, ictv, stb, suspilne, people) и при ответах 429 от Google. Источник с галочкой «через прокси» ходит только через него; остальные — при 403/429, если включено в настройках проекта.">
            <ActionForm action={saveProxy} className="mb-3 flex flex-wrap gap-2" hidden={{ op: "add" }}>
              <input name="label" className="input !w-36" placeholder="Название" />
              <input name="url" className="input min-w-0 flex-1" placeholder="http://логин:пароль@хост:порт" autoComplete="off" />
              <SubmitButton className="btn-primary" pendingText="…">Добавить</SubmitButton>
            </ActionForm>
            {proxies.length === 0 ? <p className="help">Прокси не добавлены — все запросы идут с IP сервера.</p> : (
              <ul className="space-y-2">
                {proxies.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-[14px]">
                    <span className="font-medium">{p.label}</span>
                    {!p.isActive && <Badge>выкл.</Badge>}
                    <span className="help">{p.lastOkAt ? `работал ${agoText(p.lastOkAt)}` : "не проверялся"}{p.lastError ? ` · ошибка: ${p.lastError}` : ""}</span>
                    <span className="ml-auto flex gap-1.5">
                      <ActionForm action={saveProxy} className="inline" hidden={{ op: "test", id: p.id }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">Проверить</SubmitButton></ActionForm>
                      <ActionForm action={saveProxy} className="inline" hidden={{ op: "toggle", id: p.id }}><SubmitButton className="btn-ghost btn-sm" pendingText="…">{p.isActive ? "Выключить" : "Включить"}</SubmitButton></ActionForm>
                      <ActionForm action={saveProxy} className="inline" hidden={{ op: "delete", id: p.id }}><SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить прокси «${p.label}»?`}>Удалить</SubmitButton></ActionForm>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Новый проект (сайт)" description="У проекта свои источники, сущности, бюджет и бот. Google Trends и раздел «Розваги» Google News добавятся сразу, остальные источники — на вкладке «Источники».">
            <ActionForm action={createProject} className="grid gap-2 sm:grid-cols-2">
              <label className="block"><span className="label">Название</span><input name="name" className="input" placeholder="site.ua" /></label>
              <label className="block"><span className="label">Адрес сайта</span><input name="siteUrl" className="input" placeholder="https://site.ua" /></label>
              <label className="block"><span className="label">Команда</span>
                <select name="teamId" className="input" defaultValue={teams.find((t) => /wexora/i.test(t.name))?.id ?? ""}>
                  <option value="">— выберите —</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label className="block"><span className="label">Сайт в «Сайтах»</span>
                <select name="siteAccessId" className="input" defaultValue="">
                  <option value="">— не выбран —</option>
                  {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
              <div className="sm:col-span-2"><SubmitButton className="btn-brand" pendingText="Создаю…">Создать проект</SubmitButton></div>
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
