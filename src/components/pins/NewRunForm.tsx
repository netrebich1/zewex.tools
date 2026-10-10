"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Field } from "@/components/ui";
import { launchRun } from "@/actions/pins";
import { RecipeFields, type RecipeFieldsData } from "@/components/pins/RecipeFields";
import { PagesSourceFields } from "@/components/pins/PagesSourceFields";
import { describePagesSource, pagesDateWindow, type PagesSource, type Recipe } from "@/lib/pins/types";

/** recipe — настройки для нового прогона: сайтовые поля сайта + поля прогона из последнего прогона (или по умолчанию). */
export type NewRunSite = { id: string; name: string; per: number; perDay: number; boards: number; hasWp: boolean; aiSets: number; canvasStyles: number; mix: { ai: number; photos: number; canvas: number; pinora: number }; recipe: Recipe; lastRun: { name: string | null; at: string } | null; fields: RecipeFieldsData };
type Post = { id: number; url: string; title: string; date: string; used: boolean };
type Term = { id: number; name: string; count: number };

/**
 * Новый прогон: сайт → режим (автопилот / пошаговый) → откуда ссылки (вручную или из WordPress по REST API:
 * фильтр из рецепта сайта, статьи либо подбираются при запуске, либо выбираются здесь из предпросмотра) → запуск.
 */
export function NewRunForm({ sites, presetSiteId }: { sites: NewRunSite[]; presetSiteId?: string }) {
  const [siteId, setSiteId] = useState(presetSiteId && sites.some((s) => s.id === presetSiteId) ? presetSiteId : sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId);
  const [source, setSource] = useState<"manual" | "wp">(site?.hasWp && site.recipe.pages.source === "wp" ? "wp" : "manual");
  const [mode, setMode] = useState<"auto" | "steps">("auto");

  // --- WordPress: фильтр из рецепта сайта, правится здесь только для этого прогона ---
  const [filter, setFilter] = useState<PagesSource>(site ? { ...site.recipe.pages, source: "wp" } : { source: "manual", postType: "posts", categories: [], excludeCategories: false, period: "all", after: "", before: "", days: 30, limit: 100, skipUsed: true });
  const [search, setSearch] = useState("");
  const [hideUsed, setHideUsed] = useState(true);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [wpError, setWpError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Смена сайта: источник и фильтр берём из его рецепта, найденные статьи сбрасываем.
  useEffect(() => {
    setPosts(null); setPicked(new Set()); setWpError(""); setSearch("");
    if (!site) return;
    setFilter({ ...site.recipe.pages, source: "wp" });
    setSource(site.hasWp && site.recipe.pages.source === "wp" ? "wp" : "manual");
    setHideUsed(site.recipe.pages.skipUsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const loadPosts = async () => {
    setLoading(true); setWpError(""); setPosts(null); setPicked(new Set());
    try {
      const win = pagesDateWindow(filter);
      const q = new URLSearchParams({ site: siteId, limit: String(filter.limit), type: filter.postType });
      if (filter.categories.length) q.set("categories", filter.categories.join(","));
      if (filter.excludeCategories) q.set("exclude", "1");
      if (win.after) q.set("after", win.after);
      if (win.before) q.set("before", win.before);
      if (search.trim()) q.set("search", search.trim());
      const r = await fetch(`/api/pins/wp/posts?${q}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Ошибка");
      const list: Post[] = j.posts ?? [];
      setPosts(list);
      setPicked(new Set(list.filter((p) => !filter.skipUsed || !p.used).map((p) => p.url)));
    } catch (e) { setWpError((e as Error).message); }
    finally { setLoading(false); }
  };
  const visible = useMemo(() => (posts ?? []).filter((p) => !hideUsed || !p.used), [posts, hideUsed]);
  const togglePick = (u: string) => setPicked((p) => { const n = new Set(p); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const pickedList = [...picked];

  const recipeWarnings: string[] = [];
  if (site) {
    if (site.mix.ai > 0 && !site.aiSets) recipeWarnings.push("У сайта не выбран ни один набор ИИ-стилей: прогон с ИИ-пинами будет отклонён. Выберите наборы в настройках сайта или поставьте ИИ-пинов 0.");
    if (site.mix.canvas > 0 && !site.canvasStyles) recipeWarnings.push("Canvas-стили у сайта не выбраны: будут использованы все утверждённые.");
    if (!site.boards) recipeWarnings.push("У сайта нет досок Pinterest: ИИ не сможет назначить доску.");
    if (!site.hasWp) recipeWarnings.push("У сайта нет доступа WordPress: загрузка картинок в медиатеку не пройдёт, импорт статей недоступен.");
  }

  return (
    <ActionForm action={launchRun} className="space-y-5">
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="stepByStep" value={mode === "steps" ? "on" : ""} />

      <section className="space-y-2">
        <div className="font-medium">1. Сайт</div>
        <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name} — ≈{s.per} пинов на ссылку, {s.perDay}/день, досок: {s.boards}</option>)}
        </select>
        {site && (
          <p className="help">Наборов ИИ: {site.aiSets}, Canvas-стилей: {site.canvasStyles || "все"}, досок: {site.boards} · <Link href={`/pinterest/pins/sites/${site.id}?tab=settings`} className="underline">настройки сайта</Link></p>
        )}
        {recipeWarnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      </section>

      <section className="space-y-2">
        <div className="font-medium">2. Режим</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={`rounded-xl border p-3 cursor-pointer ${mode === "auto" ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
            <div className="flex items-center gap-2"><input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} /> <b>Автопилот</b></div>
            <p className="help mt-1">Все этапы идут сами: ключи и доски → фото → план → промты → картинки → Canvas → модерация → тексты → WordPress → расписание. Остановка только на модерации (если она обязательна).</p>
          </label>
          <label className={`rounded-xl border p-3 cursor-pointer ${mode === "steps" ? "border-brand ring-2 ring-brand/30" : "border-line"}`}>
            <div className="flex items-center gap-2"><input type="radio" name="mode" checked={mode === "steps"} onChange={() => setMode("steps")} /> <b>Пошаговый (ручной)</b></div>
            <p className="help mt-1">После каждого этапа прогон встаёт на паузу. Вы смотрите результат и нажимаете «Продолжить» на странице прогона.</p>
          </label>
        </div>
        <Field label="Название прогона (необязательно)"><input name="name" className="input" placeholder="Октябрь, декор" /></Field>
      </section>

      <section className="space-y-3">
        <div className="font-medium">3. Ссылки на статьи</div>
        <div className="flex gap-1.5">
          <button type="button" className={`tab ${source === "manual" ? "active" : ""}`} onClick={() => setSource("manual")}>Вставить вручную</button>
          <button type="button" className={`tab ${source === "wp" ? "active" : ""}`} onClick={() => setSource("wp")} disabled={!site?.hasWp} title={site?.hasWp ? "" : "Нет доступа WordPress"}>Из WordPress (REST API)</button>
        </div>

        {source === "manual" ? (
          <>
            <input type="hidden" name="pagesSource" value="manual" />
            <Field label="Ссылки" hint="По одной в строке. Дубли убираются автоматически.">
              <textarea name="urls" className="input font-mono text-[13px]" rows={10} required placeholder={"https://site.com/article-1\nhttps://site.com/article-2"} />
            </Field>
          </>
        ) : (
          <div className="space-y-3">
            <p className="help">Фильтр взят из последнего прогона сайта ({describePagesSource(site?.recipe.pages ?? filter)}). Здесь его можно поправить для этого прогона. Можно запускать сразу: статьи подтянутся по фильтру при запуске. Или нажмите «Показать статьи», чтобы выбрать нужные вручную.</p>
            {site && <PagesSourceFields compact siteId={site.id} p={filter} hasWp={site.hasWp} onChange={setFilter} />}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Поиск по заголовку (только для предпросмотра)"><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="nails, decor…" /></Field>
              <button type="button" className="btn-primary" onClick={loadPosts} disabled={loading}>{loading ? "Загружаю…" : posts ? "Обновить список" : "Показать статьи"}</button>
              {posts && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => { setPosts(null); setPicked(new Set()); }} title="Вернуться к автоматическому подбору при запуске">Сбросить выбор</button>
              )}
            </div>
            {posts && (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} /> скрыть уже использованные</label>
                <span className="help">Найдено: {posts.length}, использованных: {posts.filter((p) => p.used).length}, выбрано: <b>{picked.size}</b></span>
                <span className="ml-auto flex gap-1.5">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set(visible.map((p) => p.url)))}>Выбрать все</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Снять</button>
                </span>
              </div>
            )}
            {wpError && <Alert tone="danger">{wpError}</Alert>}
            {posts && (
              <div className="max-h-[420px] overflow-auto rounded-xl border border-line divide-y divide-line">
                {visible.map((p) => (
                  <label key={p.url} className={`flex items-center gap-3 px-3 py-2 text-[13px] cursor-pointer hover:bg-ink/3 ${p.used ? "opacity-60" : ""}`}>
                    <input type="checkbox" checked={picked.has(p.url)} onChange={() => togglePick(p.url)} className="h-4 w-4" />
                    <span className="text-muted w-[84px] shrink-0">{p.date}</span>
                    <span className="truncate flex-1" title={p.url}>{p.title || p.url}</span>
                    {p.used && <span className="badge bg-warn-soft text-warn px-2 py-0.5">уже был</span>}
                  </label>
                ))}
                {!visible.length && <p className="help p-3">Ничего не найдено по фильтру.</p>}
              </div>
            )}
            {posts && pickedList.map((u) => <input key={u} type="hidden" name="urlList" value={u} />)}
            {posts && <input type="hidden" name="urls" value={pickedList.join("\n")} />}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="font-medium">4. Сколько пинов, стили и расписание</div>
        <p className="help">{site?.lastRun ? `Заполнено из последнего прогона сайта («${site.lastRun.name || "без названия"}», ${site.lastRun.at}).` : "Первый прогон сайта: значения по умолчанию."} Сколько пинов каждого вида, стили, расписание, модерация и элементы текстов — свои у каждого прогона. Стили по умолчанию отмечены как в настройках сайта; язык и доски берутся из настроек сайта.</p>
        {site && (
          <details open className="rounded-xl border border-line p-3 sm:p-4">
            <summary className="cursor-pointer font-medium text-[14px]">Показать / скрыть настройки</summary>
            <div className="mt-3" key={site.id}><RecipeFields r={site.recipe} data={site.fields} scope="run" /></div>
          </details>
        )}
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton className="btn-brand" pendingText="Запускаю…">{mode === "auto" ? "Запустить автопилот" : "Запустить пошагово"}</SubmitButton>
        <span className="help">{source === "wp" ? (posts ? `${picked.size} выбранных ссылок из WordPress` : `статьи подтянутся из WordPress по фильтру при запуске (${describePagesSource({ ...filter, source: "wp" })})`) : "ссылки из поля выше"}</span>
      </div>
    </ActionForm>
  );
}
