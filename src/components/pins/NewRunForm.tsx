"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Alert, Field } from "@/components/ui";
import { launchRun } from "@/actions/pins";
import { RecipeFields, type RecipeFieldsData } from "@/components/pins/RecipeFields";
import type { Recipe } from "@/lib/pins/types";

export type NewRunSite = { id: string; name: string; per: number; perDay: number; boards: number; hasWp: boolean; aiSets: number; canvasStyles: number; mix: { ai: number; photos: number; canvas: number; pinora: number }; recipe: Recipe; fields: RecipeFieldsData };
type Post = { id: number; url: string; title: string; date: string; used: boolean };
type Term = { id: number; name: string; count: number };

/**
 * Новый прогон: сайт → режим (автопилот / пошаговый) → откуда ссылки (вручную или из WordPress по REST API) → запуск.
 */
export function NewRunForm({ sites, presetSiteId }: { sites: NewRunSite[]; presetSiteId?: string }) {
  const [siteId, setSiteId] = useState(presetSiteId && sites.some((s) => s.id === presetSiteId) ? presetSiteId : sites[0]?.id ?? "");
  const site = sites.find((s) => s.id === siteId);
  const [source, setSource] = useState<"manual" | "wp">("manual");
  const [mode, setMode] = useState<"auto" | "steps">("auto");

  // --- WordPress ---
  const [cats, setCats] = useState<Term[]>([]);
  const [catId, setCatId] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState("100");
  const [hideUsed, setHideUsed] = useState(true);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [wpError, setWpError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPosts(null); setPicked(new Set()); setCats([]); setCatId(""); setWpError("");
    if (source !== "wp" || !siteId || !site?.hasWp) return;
    fetch(`/api/pins/wp/taxonomies?site=${siteId}`, { cache: "no-store" }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Ошибка");
      setCats(j.categories ?? []);
    }).catch((e) => setWpError(e.message));
  }, [siteId, source, site?.hasWp]);

  const loadPosts = async () => {
    setLoading(true); setWpError(""); setPosts(null); setPicked(new Set());
    try {
      const q = new URLSearchParams({ site: siteId, limit });
      if (catId) q.set("categories", catId);
      if (after) q.set("after", after);
      if (before) q.set("before", before);
      if (search.trim()) q.set("search", search.trim());
      const r = await fetch(`/api/pins/wp/posts?${q}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Ошибка");
      const list: Post[] = j.posts ?? [];
      setPosts(list);
      setPicked(new Set(list.filter((p) => !p.used).map((p) => p.url)));
    } catch (e) { setWpError((e as Error).message); }
    finally { setLoading(false); }
  };
  const visible = useMemo(() => (posts ?? []).filter((p) => !hideUsed || !p.used), [posts, hideUsed]);
  const togglePick = (u: string) => setPicked((p) => { const n = new Set(p); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const pickedList = [...picked];

  const recipeWarnings: string[] = [];
  if (site) {
    if (site.mix.ai > 0 && !site.aiSets) recipeWarnings.push("В рецепте включены ИИ-пины, но не выбран ни один набор ИИ-стилей: запуск будет отклонён.");
    if (site.mix.canvas > 0 && !site.canvasStyles) recipeWarnings.push("Canvas-пины включены, стили не выбраны: будут использованы все утверждённые Canvas-стили.");
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
          <p className="help">Рецепт: ИИ {site.mix.ai}, фото {site.mix.photos}, canvas {site.mix.canvas}, pinora {site.mix.pinora} на ссылку · наборов ИИ: {site.aiSets}, Canvas-стилей: {site.canvasStyles || "все"} · <Link href={`/sites/${site.id}`} className="underline">настройки сайта</Link></p>
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
          <Field label="Ссылки" hint="По одной в строке. Дубли убираются автоматически.">
            <textarea name="urls" className="input font-mono text-[13px]" rows={10} required placeholder={"https://site.com/article-1\nhttps://site.com/article-2"} />
          </Field>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Категория">
                <select className="input" value={catId} onChange={(e) => setCatId(e.target.value)}>
                  <option value="">Все категории</option>
                  {cats.map((c) => <option key={c.id} value={String(c.id)}>{c.name} · {c.count}</option>)}
                </select>
              </Field>
              <Field label="Опубликованы с"><input type="date" className="input" value={after} onChange={(e) => setAfter(e.target.value)} /></Field>
              <Field label="по"><input type="date" className="input" value={before} onChange={(e) => setBefore(e.target.value)} /></Field>
              <Field label="Поиск по заголовку"><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="nails, decor…" /></Field>
              <Field label="Не больше"><input type="number" min={1} max={1000} className="input" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" onClick={loadPosts} disabled={loading}>{loading ? "Загружаю…" : "Загрузить статьи"}</button>
              <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} /> скрыть уже использованные</label>
              {posts && <span className="help">Найдено: {posts.length}, использованных: {posts.filter((p) => p.used).length}, выбрано: <b>{picked.size}</b></span>}
              {posts && (
                <span className="ml-auto flex gap-1.5">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set(visible.map((p) => p.url)))}>Выбрать все</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Снять</button>
                </span>
              )}
            </div>
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
            {pickedList.map((u) => <input key={u} type="hidden" name="urlList" value={u} />)}
            <input type="hidden" name="urls" value={pickedList.join("\n")} />
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="font-medium">4. Настройки прогона</div>
        <p className="help">Заполнены из рецепта сайта «{site?.name}». Здесь их можно изменить только для этого прогона: сколько пинов каждого вида, наборы стилей, тексты, модерация, расписание. Рецепт сайта не меняется.</p>
        {site && (
          <details open className="rounded-xl border border-line p-3 sm:p-4">
            <summary className="cursor-pointer font-medium text-[14px]">Показать / скрыть настройки</summary>
            <div className="mt-3" key={site.id}><RecipeFields r={site.recipe} data={site.fields} /></div>
          </details>
        )}
      </section>

      <div className="flex items-center gap-3">
        <SubmitButton className="btn-brand" pendingText="Запускаю…">{mode === "auto" ? "Запустить автопилот" : "Запустить пошагово"}</SubmitButton>
        <span className="help">{source === "wp" ? `${picked.size} ссылок из WordPress` : "ссылки из поля выше"}</span>
      </div>
    </ActionForm>
  );
}
