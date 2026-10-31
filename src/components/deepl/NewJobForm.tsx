"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Card } from "@/components/ui";
import { launchDeeplJob, saveDeeplScenario } from "@/actions/deepl";
import { DEEPL_LANGS, describeSettings, MAX_JOB_ITEMS, RECOMMENDED_MODELS, WP_STATUSES, type DeeplSettings } from "@/lib/deepl/types";

type Site = { id: string; name: string; baseUrl: string; ready: boolean };
type Prompt = { id: string; name: string; purpose: string };
type Scenario = { id: string; name: string; settings: DeeplSettings };
type Post = { id: number; title: string; date: string; status: string; link: string; categories: number[] };

const MODELS = [RECOMMENDED_MODELS.edit, RECOMMENDED_MODELS.headings, "anthropic/claude-haiku-5.5", "google/gemini-2.5-flash"];
const SOURCE_LANGS = DEEPL_LANGS.filter((l) => !l.targetOnly);
const baseCode = (c: string) => c.split("-")[0]!;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function NewJobForm({ sites, prompts, scenarios, initial, initialSite, hasEditKey, isAdmin, deeplKeys }: {
  sites: Site[];
  prompts: Prompt[];
  scenarios: Scenario[];
  initial: DeeplSettings;
  initialSite: string;
  hasEditKey: boolean;
  isAdmin: boolean;
  deeplKeys: number;
}) {
  // ---- источник ----
  const [site, setSite] = useState(initialSite);
  const [status, setStatus] = useState("draft");
  const [after, setAfter] = useState(() => isoDay(new Date(Date.now() - 7 * 86_400_000)));
  const [before, setBefore] = useState(() => isoDay(new Date(Date.now() + 86_400_000)));
  const [search, setSearch] = useState("");
  const [cats, setCats] = useState<Array<{ id: number; name: string; count: number }> | null>(null);
  const [catIds, setCatIds] = useState<number[]>([]);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- настройки ----
  const [s, setS] = useState<DeeplSettings>(initial);
  const [name, setName] = useState("");
  const [scenarioName, setScenarioName] = useState("");
  const upd = (patch: Partial<DeeplSettings>) => setS((p) => ({ ...p, ...patch }));

  const siteRow = sites.find((x) => x.id === site);
  const headingPrompts = prompts.filter((p) => p.purpose === "headings" || p.purpose === "any");
  const editPrompts = prompts.filter((p) => p.purpose === "post_edit" || p.purpose === "any");

  async function findPosts() {
    if (!site) return;
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams({ site, status, after, before, search, categories: catIds.join(","), limit: String(MAX_JOB_ITEMS) });
      const res = await fetch(`/api/deepl/posts?${q}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
      setPosts(data.posts);
      setTotal(data.total);
      setPicked(new Set((data.posts as Post[]).map((p) => p.id)));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setPosts(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadCats() {
    setCats([]);
    try {
      const res = await fetch(`/api/deepl/categories?site=${site}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCats(data.categories);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setCats(null);
    }
  }

  const selected = useMemo(() => (posts ?? []).filter((p) => picked.has(p.id)), [posts, picked]);
  const settingsJson = JSON.stringify(s);
  const postsJson = JSON.stringify(selected.map((p) => ({ id: p.id, title: p.title, link: p.link, status: p.status, date: p.date })));

  function setStep(i: number, patch: Partial<{ source: string; target: string }>) {
    const steps = s.translateSteps.map((st, n) => (n === i ? { ...st, ...patch } : st));
    // Исходный язык следующего шага = язык результата текущего (EN-GB → EN).
    if (patch.target && steps[i + 1]) steps[i + 1] = { ...steps[i + 1]!, source: baseCode(patch.target) };
    upd({ translateSteps: steps });
  }
  function addStep() {
    const last = s.translateSteps[s.translateSteps.length - 1];
    upd({ translateSteps: [...s.translateSteps, { source: last ? baseCode(last.target) : "UK", target: "EN-GB" }].slice(0, 3) });
  }

  return (
    <div className="space-y-5">
      {/* ---------- 1. Статьи ---------- */}
      <Card title="1. Статьи из WordPress" description="Статьи берутся по статусу и дате публикации; HTML загружается целиком (картинки, шорткоды, ссылки сохраняются).">
        {sites.length === 0 ? (
          <Alert tone="warn">
            Нет сайтов для инструмента. Добавьте сайт в разделе <Link href="/sites" className="underline">«Сайты»</Link> (адрес, логин WP и Application Password) и отметьте сервис «DeepL Articler» — или оставьте список сервисов пустым.
          </Alert>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="label">Сайт</span>
                <select className="input" value={site} onChange={(e) => { setSite(e.target.value); setPosts(null); setCats(null); setCatIds([]); }}>
                  {sites.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}{x.ready ? "" : " — нет логина"}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Статус</span>
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {WP_STATUSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="label">Дата публикации с</span>
                <input type="date" className="input" value={after} onChange={(e) => setAfter(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">по</span>
                <input type="date" className="input" value={before} onChange={(e) => setBefore(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block grow min-w-[220px]">
                <span className="label">Поиск в заголовке/тексте (необязательно)</span>
                <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="например: манікюр" />
              </label>
              {cats === null ? (
                <button type="button" className="btn-ghost" onClick={loadCats} disabled={!site}>Фильтр по рубрикам…</button>
              ) : null}
              <button type="button" className="btn-primary" onClick={findPosts} disabled={!site || loading || !siteRow?.ready}>{loading ? "Ищу…" : "Найти статьи"}</button>
            </div>
            {siteRow && !siteRow.ready && <Alert tone="warn">У сайта «{siteRow.name}» не заполнены логин и Application Password — <Link href={`/sites/${siteRow.id}`} className="underline">заполнить</Link>.</Alert>}
            {cats && (
              <div>
                <span className="label">Рубрики (ничего не отмечено — все)</span>
                {cats.length === 0 ? <p className="help">Загружаю…</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {cats.map((c) => {
                      const on = catIds.includes(c.id);
                      return (
                        <button key={c.id} type="button" className={`tab ${on ? "active" : ""}`} onClick={() => setCatIds(on ? catIds.filter((x) => x !== c.id) : [...catIds, c.id])}>
                          {c.name} <span className="opacity-60">{c.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {loadError && <Alert tone="danger">{loadError}</Alert>}
            {posts && (
              posts.length === 0 ? <p className="help">Статей с такими условиями нет.</p> : (
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-3 text-[14px]">
                    <span>Найдено {total}{total > posts.length ? ` (показаны первые ${posts.length})` : ""} · выбрано <b>{picked.size}</b></span>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set(posts.map((p) => p.id)))}>Выбрать все</button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Снять все</button>
                  </div>
                  <div className="table-wrap max-h-[420px] overflow-y-auto">
                    <table className="table">
                      <thead><tr><th></th><th>Статья</th><th>Дата</th><th>Статус</th></tr></thead>
                      <tbody>
                        {posts.map((p) => (
                          <tr key={p.id}>
                            <td className="w-8">
                              <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => {
                                const n = new Set(picked);
                                if (e.target.checked) n.add(p.id); else n.delete(p.id);
                                setPicked(n);
                              }} />
                            </td>
                            <td><a href={p.link} target="_blank" rel="noreferrer" className="hover:underline">{p.title || `#${p.id}`}</a></td>
                            <td className="help whitespace-nowrap">{p.date}</td>
                            <td className="help">{p.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </Card>

      {/* ---------- 2. Цепочка ---------- */}
      <Card
        title="2. Цепочка обработки"
        description={describeSettings(s)}
        actions={scenarios.length ? (
          <select className="input" defaultValue="" onChange={(e) => { const sc = scenarios.find((x) => x.id === e.target.value); if (sc) { setS(sc.settings); setScenarioName(sc.name); } }}>
            <option value="" disabled>Применить сценарий…</option>
            {scenarios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        ) : null}
      >
        <div className="space-y-5">
          <section>
            <div className="mb-2 font-medium">Перевод DeepL — до 3 шагов подряд</div>
            {s.translateSteps.length > 0 && deeplKeys === 0 && (
              <div className="mb-2"><Alert tone="warn">Нет рабочих ключей DeepL — <Link href="/discovery/deepl/keys" className="underline">добавить ключи</Link>.</Alert></div>
            )}
            {s.translateSteps.length === 0 && <p className="help mb-2">Перевод выключен — будут только H2 и постредактура.</p>}
            <div className="space-y-2">
              {s.translateSteps.map((st, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="help w-16">Шаг {i + 1}</span>
                  <select className="input w-auto" value={st.source || "AUTO"} onChange={(e) => setStep(i, { source: e.target.value === "AUTO" ? "auto" : e.target.value })}>
                    <option value="AUTO">определить сам</option>
                    {SOURCE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                  </select>
                  <span>→</span>
                  <select className="input w-auto" value={st.target} onChange={(e) => setStep(i, { target: e.target.value })}>
                    {DEEPL_LANGS.filter((l) => l.code !== "EN" && l.code !== "PT").map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                  </select>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => upd({ translateSteps: s.translateSteps.filter((_, n) => n !== i) })}>Убрать</button>
                </div>
              ))}
            </div>
            {s.translateSteps.length < 3 && <button type="button" className="btn-ghost btn-sm mt-2" onClick={addStep}>+ шаг перевода</button>}
            <p className="help mt-1">Ссылки с анкорами, картинки, шорткоды [caption] и iframe прячутся от переводчика и возвращаются один в один. Один и тот же фрагмент DeepL не оплачивается дважды (кэш).</p>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div>
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={s.headings.enabled} onChange={(e) => upd({ headings: { ...s.headings, enabled: e.target.checked } })} />
                Заголовки H2 (после перевода)
              </label>
              {s.headings.enabled && (
                <select className="input mt-2" value={s.headings.promptId} onChange={(e) => upd({ headings: { ...s.headings, promptId: e.target.value } })}>
                  <option value="">— выберите промт —</option>
                  {headingPrompts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={s.postEdit.enabled} onChange={(e) => upd({ postEdit: { ...s.postEdit, enabled: e.target.checked } })} />
                Постредактура (ошибки перевода, кальки, тема)
              </label>
              {s.postEdit.enabled && (
                <select className="input mt-2" value={s.postEdit.promptId} onChange={(e) => upd({ postEdit: { ...s.postEdit, promptId: e.target.value } })}>
                  <option value="">— выберите промт —</option>
                  {editPrompts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <p className="help mt-1">Точечная правка по 3 секции H2 за раз: пересказ (&gt;22% слов) и рост текста отклоняются, фрагмент остаётся как был.</p>
            </div>
          </section>

          <section>
            <label className={`flex items-center gap-2 font-medium ${s.postEdit.enabled ? "" : "opacity-50"}`}>
              <input type="checkbox" checked={s.seo.enabled} disabled={!s.postEdit.enabled} onChange={(e) => upd({ seo: { ...s.seo, enabled: e.target.checked } })} />
              Добор SEO-ключей (отдельный проход после постредактуры)
            </label>
            {s.seo.enabled && s.postEdit.enabled && (
              <div className="mt-2 grid gap-3 lg:grid-cols-3">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[14px]">
                    <input type="checkbox" checked={s.seo.auto} onChange={(e) => upd({ seo: { ...s.seo, auto: e.target.checked } })} />
                    Ключи из исходника автоматически (до 10 частых фраз)
                  </label>
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <span>Вернуть</span>
                    <input type="number" min={0} max={100} className="input !w-20" value={s.seo.minPct} onChange={(e) => upd({ seo: { ...s.seo, minPct: Number(e.target.value) } })} />
                    <span>–</span>
                    <input type="number" min={0} max={200} className="input !w-20" value={s.seo.maxPct} onChange={(e) => upd({ seo: { ...s.seo, maxPct: Number(e.target.value) } })} />
                    <span>% вхождений</span>
                  </div>
                  <p className="help">От числа вхождений ключа в исходной статье: 25–70% — ключ звучит, но без переспама.</p>
                </div>
                <label className="block lg:col-span-2">
                  <span className="label">Свои ключи (по строке или через запятую; ключ берётся в статью, только если он есть в её исходнике)</span>
                  <textarea className="input min-h-[90px]" value={s.seo.keywords.join("\n")} onChange={(e) => upd({ seo: { ...s.seo, keywords: e.target.value.split("\n") } })} />
                </label>
              </div>
            )}
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <label className="block">
                <span className="label">Модель OpenRouter: постредактура и ключи</span>
                <input className="input" list="deepl-models" value={s.model} placeholder="пусто — модель из правила ключа" onChange={(e) => upd({ model: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Модель OpenRouter: заголовки H2</span>
                <input className="input" list="deepl-models" value={s.headingsModel} placeholder="пусто — как для постредактуры" onChange={(e) => upd({ headingsModel: e.target.value })} />
              </label>
              <datalist id="deepl-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
              <p className="help">Подобраны на тестах: {RECOMMENDED_MODELS.edit} — самая дешёвая и точная в правке перевода; {RECOMMENDED_MODELS.headings} — лучшие H2 без штампов.{" "}
                {(s.model !== RECOMMENDED_MODELS.edit || s.headingsModel !== RECOMMENDED_MODELS.headings) && (
                  <button type="button" className="underline" onClick={() => upd({ model: RECOMMENDED_MODELS.edit, headingsModel: RECOMMENDED_MODELS.headings })}>Поставить рекомендованные</button>
                )}
              </p>
              {!hasEditKey && (
                <p className="help mt-1 text-warn">
                  Ключ OpenRouter ещё не подключён к инструменту — {isAdmin ? <Link href="/projects/deepl" className="underline">подключить</Link> : "попросите администратора"}. Без него работает только перевод.
                </p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" checked={s.publish.enabled} onChange={(e) => upd({ publish: { ...s.publish, enabled: e.target.checked } })} />
                Публиковать в WordPress автоматически
              </label>
              {s.publish.enabled && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <select className="input w-auto" value={s.publish.target} onChange={(e) => upd({ publish: { ...s.publish, target: e.target.value as "source" | "new" } })}>
                    <option value="source">в исходный пост (оригинал сохраняется для отката)</option>
                    <option value="new">новым постом</option>
                  </select>
                  <select className="input w-auto" value={s.publish.status} onChange={(e) => upd({ publish: { ...s.publish, status: e.target.value as "draft" | "pending" | "publish" } })}>
                    <option value="draft">черновик</option>
                    <option value="pending">на утверждение</option>
                    <option value="publish">опубликовать</option>
                  </select>
                </div>
              )}
              <p className="help mt-1">Статьи с замечаниями (откат этапа, язык, без правок) автоматически не публикуются — их можно опубликовать вручную после просмотра.</p>
            </div>
          </section>

          <ActionForm action={saveDeeplScenario} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <input type="hidden" name="settings" value={settingsJson} />
            <label className="block grow min-w-[220px]">
              <span className="label">Сохранить настройки как сценарий</span>
              <input name="scenarioName" className="input" value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} placeholder="например: UK → EN → DE → UK" />
            </label>
            <SubmitButton className="btn-ghost" pendingText="…">Сохранить сценарий</SubmitButton>
          </ActionForm>
        </div>
      </Card>

      {/* ---------- 3. Запуск ---------- */}
      <Card title="3. Запуск">
        <ActionForm action={launchDeeplJob} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="accessId" value={site} />
          <input type="hidden" name="settings" value={settingsJson} />
          <input type="hidden" name="posts" value={postsJson} />
          <label className="block grow min-w-[220px]">
            <span className="label">Название прогона (необязательно)</span>
            <input name="name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${siteRow?.name ?? "Сайт"} · ${new Date().toLocaleDateString("ru-RU")}`} />
          </label>
          <SubmitButton className="btn-brand" pendingText="Запускаю…">Запустить ({selected.length})</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
