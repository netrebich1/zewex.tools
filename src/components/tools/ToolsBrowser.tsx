"use client";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/Icons";
import { toggleFavorite } from "@/actions/favorites";
import { STATUS_LABELS } from "@/lib/utils";

export type ToolItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  url: string | null;
  status: string;
  slots: number;
};
export type ToolSection = { id: string; slug: string; name: string; icon: string; projects: ToolItem[] };

/** Оттенок плитки с иконкой: по разделу, чтобы карточки разных разделов различались с первого взгляда. */
const TILE: Record<string, string> = {
  pinterest: "bg-danger-soft text-danger",
  gambling: "bg-info-soft text-info",
  seo: "bg-ok-soft text-ok",
  discovery: "bg-brand-soft text-warn",
};
const TILE_FALLBACK = ["bg-brand-soft text-warn", "bg-info-soft text-info", "bg-ok-soft text-ok", "bg-danger-soft text-danger"];

function iconOf(name: string): IconName {
  return (name as IconName) in Icon ? (name as IconName) : "grid";
}

function Star({ active, pending, onClick }: { active: boolean; pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      disabled={pending}
      className={`relative z-10 inline-flex h-8 w-8 items-center justify-center rounded-full transition ${active ? "text-brand" : "text-muted/60 hover:text-ink hover:bg-ink/5"}`}
      aria-pressed={active}
      aria-label={active ? "Убрать из избранного" : "В избранное"}
      title={active ? "Убрать из избранного" : "В избранное"}
    >
      <Icon.star width={17} height={17} fill={active ? "currentColor" : "none"} />
    </button>
  );
}

function ToolCard({ tool, section, tile, favorite, pending, isAdmin, onStar }: {
  tool: ToolItem; section: ToolSection; tile: string; favorite: boolean; pending: boolean; isAdmin: boolean; onStar: () => void;
}) {
  const I = Icon[iconOf(section.icon)];
  const live = tool.status === "ACTIVE" || tool.status === "MIGRATING";
  const href = tool.url && live ? tool.url : isAdmin ? `/projects/${tool.slug}` : null;
  const external = !!tool.url && /^https?:\/\//.test(tool.url) && !tool.url.startsWith("/");
  return (
    <div className={`card card-hover group relative p-4 sm:p-5 flex flex-col gap-3 ${live ? "" : "opacity-75"}`}>
      {href && <Link href={href} className="absolute inset-0 rounded-2xl" aria-label={tool.name} />}
      <div className="flex items-start gap-3">
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tile}`}><I width={22} height={22} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-[15.5px] leading-tight truncate">{tool.name}</h3>
            {tool.status !== "ACTIVE" && <span className="badge bg-ink/5 text-ink-2 text-[11px] py-0">{STATUS_LABELS[tool.status] ?? tool.status}</span>}
          </div>
          <div className="text-[12px] text-muted mt-0.5">{section.name}</div>
        </div>
        <Star active={favorite} pending={pending} onClick={onStar} />
      </div>
      {tool.description && <p className="help line-clamp-2">{tool.description}</p>}
      <div className="mt-auto flex items-center justify-between pt-1 text-[12.5px]">
        {isAdmin ? (
          <Link href={`/projects/${tool.slug}`} className="relative z-10 inline-flex items-center gap-1 text-muted hover:text-ink transition"><Icon.settings width={13} height={13} /> Настройки · слотов: {tool.slots}</Link>
        ) : <span className="text-muted">Слотов: {tool.slots}</span>}
        {href && live && (
          <span className="inline-flex items-center gap-1 font-semibold text-ink group-hover:text-brand transition">
            Открыть {external ? <Icon.external width={13} height={13} /> : <Icon.arrow width={13} height={13} />}
          </span>
        )}
      </div>
    </div>
  );
}

/** Главная: вкладки «Избранное / Все / разделы», поиск, карточки инструментов со звёздочками. */
export function ToolsBrowser({ sections, favoriteIds, isAdmin, initialTab }: { sections: ToolSection[]; favoriteIds: string[]; isAdmin: boolean; initialTab?: string }) {
  const [favs, setFavs] = useState<Set<string>>(() => new Set(favoriteIds));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const tabs = useMemo(() => ["favorites", "all", ...sections.map((s) => s.slug)], [sections]);
  const [tab, setTab] = useState<string>(() => (initialTab && tabs.includes(initialTab) ? initialTab : favoriteIds.length ? "favorites" : "all"));

  const tileOf = (s: ToolSection) => TILE[s.slug] ?? TILE_FALLBACK[sections.indexOf(s) % TILE_FALLBACK.length];
  const sectionOf = useMemo(() => new Map(sections.flatMap((s) => s.projects.map((p) => [p.id, s] as const))), [sections]);
  const all = useMemo(() => sections.flatMap((s) => s.projects), [sections]);

  const onStar = (id: string) => {
    const next = new Set(favs);
    if (next.has(id)) next.delete(id); else next.add(id);
    setFavs(next);
    setPendingId(id);
    startTransition(async () => {
      try { const r = await toggleFavorite(id); setFavs((cur) => { const c = new Set(cur); if (r.favorite) c.add(id); else c.delete(id); return c; }); }
      catch { setFavs(favs); }
      finally { setPendingId(null); }
    });
  };

  const query = q.trim().toLowerCase();
  const match = (t: ToolItem) => !query || t.name.toLowerCase().includes(query) || (t.description ?? "").toLowerCase().includes(query) || (sectionOf.get(t.id)?.name.toLowerCase().includes(query) ?? false);

  const groups: { section: ToolSection; tools: ToolItem[] }[] =
    tab === "favorites" ? sections.map((s) => ({ section: s, tools: s.projects.filter((p) => favs.has(p.id) && match(p)) })).filter((g) => g.tools.length)
    : tab === "all" ? sections.map((s) => ({ section: s, tools: s.projects.filter(match) })).filter((g) => g.tools.length)
    : sections.filter((s) => s.slug === tab).map((s) => ({ section: s, tools: s.projects.filter(match) }));
  const shown = groups.reduce((n, g) => n + g.tools.length, 0);

  const Tab = ({ id, label, icon, count }: { id: string; label: string; icon?: IconName; count: number }) => {
    const I = icon ? Icon[icon] : null;
    const active = tab === id;
    return (
      <button type="button" onClick={() => setTab(id)} className={`tab border-line ${active ? "active" : "bg-surface"}`} aria-pressed={active}>
        {I && <I width={15} height={15} fill={id === "favorites" && active ? "currentColor" : "none"} />} {label}
        <span className={`text-[12px] ${active ? "opacity-70" : "text-muted"}`}>{count}</span>
      </button>
    );
  };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
          <div className="flex gap-2 min-w-max">
            <Tab id="favorites" label="Избранное" icon="star" count={all.filter((p) => favs.has(p.id)).length} />
            <Tab id="all" label="Все" icon="grid" count={all.length} />
            {sections.map((s) => <Tab key={s.id} id={s.slug} label={s.name} icon={iconOf(s.icon)} count={s.projects.length} />)}
          </div>
        </div>
        <label className="relative block sm:w-64">
          <Icon.search width={15} height={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} className="input pl-9 py-2 rounded-full" placeholder="Найти инструмент…" aria-label="Поиск по инструментам" />
        </label>
      </div>

      {shown === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          {tab === "favorites" && !query ? (
            <>
              <Icon.star width={28} height={28} className="mx-auto text-muted/60 mb-2" />
              <p className="font-medium">Избранных инструментов пока нет</p>
              <p className="help mt-1">Нажмите звёздочку на карточке, и инструмент появится здесь. Эта вкладка будет открываться первой.</p>
            </>
          ) : (
            <>
              <p className="font-medium">{query ? "Ничего не нашлось" : "В этом разделе пока нет инструментов"}</p>
              <p className="help mt-1">{query ? "Попробуйте другое слово." : "Новые инструменты появятся здесь после запуска."}</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-7">
          {groups.map((g) => (
            <section key={g.section.id}>
              {(tab === "all" || tab === "favorites") && (
                <h2 className="flex items-center gap-2 text-[12.5px] uppercase tracking-wider text-muted font-semibold mb-3">
                  {g.section.name} <span className="h-px flex-1 bg-line" />
                </h2>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {g.tools.map((t) => (
                  <ToolCard key={t.id} tool={t} section={g.section} tile={tileOf(g.section)} favorite={favs.has(t.id)} pending={pendingId === t.id} isAdmin={isAdmin} onStar={() => onStar(t.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
