"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { Alert, Card, Field } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { launchEmdRun, previewEmdTable, type EmdPreview } from "@/actions/domainsEmd";
import { EMD_DEFAULTS } from "@/lib/domains/emd";

export type EmdFormDefaults = { sourceUrl: string; name: string; minVolume: number; maxLen: number; matchPct: number; perCluster: number; maxPerCluster: number; tlds: string; allowHyphen: boolean; serp: boolean; autoZones: boolean; variations: boolean; serpVariants: boolean; keywordMods: boolean; geoMods: boolean; suffixes: string; prefixes: string };

export const EMD_FORM_DEFAULTS: EmdFormDefaults = { sourceUrl: "", name: "", ...EMD_DEFAULTS, perCluster: 5, tlds: "com", allowHyphen: true, serp: true, autoZones: true, suffixes: "", prefixes: "" };

/** Форма подбора «EMD по ключам»: ссылка на выгрузку кластеров, порог частоты, домены на кластер, зоны и выдача. */
export function EmdRunForm({ defaults }: { defaults: EmdFormDefaults }) {
  const [url, setUrl] = useState(defaults.sourceUrl);
  const [minVolume, setMinVolume] = useState(defaults.minVolume);
  const [preview, setPreview] = useState<EmdPreview | null>(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    setPreview(null);
    try {
      setPreview(await previewEmdTable(url, minVolume));
    } catch (e) {
      setPreview({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  const ok = preview && !preview.error;
  const flag = (name: string, checked: boolean, title: string, hint: string) => (
    <label className="flex items-start gap-2 text-[14px]">
      <input type="checkbox" name={name} className="mt-0.5 h-4 w-4 shrink-0" defaultChecked={checked} />
      <span>{title}<span className="help block">{hint}</span></span>
    </label>
  );

  return (
    <ActionForm action={launchEmdRun} className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        <Card title="Таблица кластеров" description="Выгрузка «Наблюдение кластеры» на Google Диске: тема, ключи темы, страна и частота. Файлу нужен доступ «Все, у кого есть ссылка — читатель».">
          <div className="space-y-3">
            <Field label="Ссылка на таблицу">
              <input name="sourceUrl" className="input" required value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); }} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </Field>
            <button type="button" className="btn-ghost" disabled={loading || !url.trim()} onClick={check}>{loading ? "Читаю таблицу…" : "Проверить таблицу"}</button>
            {preview?.error && <Alert tone="danger">{preview.error}</Alert>}
            {ok && (
              <div className="space-y-3 rounded-xl border border-line p-3 text-[14px]">
                <div><b>{preview.fileName}</b> <span className="help">· строк {preview.rows}</span></div>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  <span>Кластеров: <b>{preview.clusters}</b></span>
                  <span>Ключей: <b>{preview.keywords}</b></span>
                  <span>Пойдут в домены (тема + частота ≥ {minVolume}): <b>{preview.eligible}</b></span>
                </div>
                <div className="help">Страны: {preview.countries!.map(([c, n]) => `${c.toUpperCase()} · ${n}`).join(", ")}</div>
                <div className="help">Выдача Google по всем ключам: примерно ${((preview.keywords ?? 0) * 0.002).toFixed(2)}–${((preview.keywords ?? 0) * 0.006).toFixed(2)}</div>
                {preview.projects!.length > 0 && (
                  <div>
                    <div className="label">Проекты</div>
                    <div className="space-y-1">
                      {preview.projects!.map(([p, n]) => (
                        <label key={p} className="flex items-start gap-2 text-[13.5px]"><input type="checkbox" name="project" value={p} defaultChecked className="mt-0.5 h-4 w-4 shrink-0" /> <span>{p} <span className="help">· кластеров {n}</span></span></label>
                      ))}
                    </div>
                  </div>
                )}
                {preview.problems!.length > 0 && <Alert tone="warn">Пропущены строки: {preview.problems!.slice(0, 5).join(" · ")}{preview.problems!.length > 5 ? ` · и ещё ${preview.problems!.length - 5}` : ""}</Alert>}
              </div>
            )}
          </div>
        </Card>

        <Card title="Варианты доменов" description="Три уровня основы, в карточке кластера они идут отдельными группами. Каждая основа проверяется во всех зонах; лучшие основы — ещё и с приписками.">
          <div className="space-y-3">
            <div className="rounded-lg bg-ink/5 px-3 py-2 text-[13px]">
              <b>1. Точный ключ</b> — ключ слитно, транслитом и через дефис: <span className="font-mono">casinozondercruks</span>, <span className="font-mono">casino-zonder-cruks</span>. Тема и ключи с частотой от порога.
            </div>
            {flag("variations", defaults.variations, "2. Вариации ключа", "Перестановки (zondercrukscasino), без связок online/met, без casino (zondercruks), ед./мн. число (casinoszondercruks) и ключи из таблицы ниже порога частоты.")}
            {flag("serpVariants", defaults.serpVariants, "3. Вариации из выдачи", "Метки доменов из TOP-10, где ключа от порога подсветки: их основа в других зонах. Нужна выдача Google.")}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Мин. частота ключа" hint="Ключи ниже порога идут только в вариации (уровень 2); тема кластера — всегда точный ключ">
              <input name="minVolume" type="number" min={0} className="input" value={minVolume} onChange={(e) => { setMinVolume(Number(e.target.value) || 0); }} />
            </Field>
            <Field label="Проверять вариантов на кластер, до" hint="Сколько доменов сгенерировать и проверить на кластер; из них выбираешь сам. ~60% без приписок, ~40% с приписками">
              <input name="maxPerCluster" type="number" min={10} max={1000} className="input" defaultValue={defaults.maxPerCluster} />
            </Field>
            <Field label="Отметить ★ лучших на кластер" hint="Сколько обычно берёшь: столько лучших свободных по весу помечаются звёздочкой и выбираются кнопкой «★». Остальные — в списке на выбор">
              <input name="perCluster" type="number" min={1} max={100} className="input" defaultValue={defaults.perCluster} />
            </Field>
            <Field label="Зоны (кроме зоны страны)" hint="Через запятую. Зона страны (.nl, .de, .co.uk) добавляется всегда">
              <input name="tlds" className="input" defaultValue={defaults.tlds} />
            </Field>
            <Field label="Макс. длина метки" hint="Символов до точки; длиннее — не берём">
              <input name="maxLen" type="number" min={8} max={63} className="input" defaultValue={defaults.maxLen} />
            </Field>
          </div>
        </Card>

        <Card title="Приписки" description="Ставятся к 6 лучшим основам кластера, в 3 первые зоны: слитно и через дефис (если дефис включён). В карточке — отдельная группа «С приписками».">
          <div className="space-y-3">
            {flag("keywordMods", defaults.keywordMods, "Из ключей кластера", "Слова из ключей сверх темы: «beste casino zonder cruks» → приписка beste в начале, «casino zonder cruks nederland» → nederland в конце. До 12 самых частотных.")}
            {flag("geoMods", defaults.geoMods, "Гео в конце", "Код страны и alpha-3: casinozondercruksnl, casinozondercruks-nld.")}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Свои приписки в конце" hint="Через запятую: online, top, bonus, 24">
                <input name="suffixes" className="input" defaultValue={defaults.suffixes} placeholder="online, top, bonus" />
              </Field>
              <Field label="Свои приписки в начале" hint="Через запятую: best, top, mijn">
                <input name="prefixes" className="input" defaultValue={defaults.prefixes} placeholder="best, top" />
              </Field>
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        <div className="card p-4 sm:p-5 space-y-3">
          <Field label="Название подбора">
            <input name="name" className="input" defaultValue={defaults.name} placeholder="EMD · Дженерики Европа" />
          </Field>
          {flag("serp", defaults.serp, "Снять TOP-10 Google по каждому ключу", "Какие домены и зоны в выдаче; домены, где есть ключ, подсвечиваются. ~$0.002–0.006 на ключ.")}
          <Field label="Подсвечивать домены выдачи, где ключа не меньше, %" hint="60 — casino zonder cruks → zondercruks.nl (61%) подсветится, casino.com (39%) нет">
            <input name="matchPct" type="number" min={10} max={100} className="input" defaultValue={defaults.matchPct} />
          </Field>
          {flag("autoZones", defaults.autoZones, "Добавлять зоны из анализа", "Зоны маленьких сайтов из таблицы и до 6 зон доменов с ключом из TOP-10.")}
          {flag("allowHyphen", defaults.allowHyphen, "Варианты через дефис", "casinos-zonder-cruks — как запасные, вес ниже слитного.")}
          <SubmitButton className="btn-brand w-full" pendingText="Читаю таблицу и ставлю в очередь…">Запустить подбор</SubmitButton>
          <p className="help">Проверка идёт в фоне, страницу можно закрывать. {ok ? "" : "Таблицу можно не проверять заранее — при запуске она скачается сама."}</p>
        </div>
      </div>
    </ActionForm>
  );
}
