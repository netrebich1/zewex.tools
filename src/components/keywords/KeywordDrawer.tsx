"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { setKeywordStatus } from "@/actions/keywords";
import type { SnapSummary } from "@/lib/keywords/recompute";
import { flagLabel, nicheLabel, seasonLabel, sourceLabel, statusLabel, verdictLabel, type KwMetrics, type MinAvgMax } from "@/lib/keywords/types";
import { KeywordQueueButtons } from "./CollectControls";
import { Bar, verdictCls } from "./DataTable";
import { fmt, pctOf } from "./kwui";

type Item = {
  keyword: Record<string, unknown> & { id: string; phrase: string; status: string; niche: string; source: string; season: string; verdict: string | null; flags: string; account: string | null };
  metrics: KwMetrics | null;
  history: SnapSummary[];
  volumes: Array<{ takenAt: string; value: number | null }>;
  /** Авторы топ-10 по местам (снимки через расширение) */
  authors: Array<{ position: number; username: string | null; saveType: string | null; domain: string | null; saves: number | null; createdAt: string | null; title: string | null; followers: number | null; views: number | null; reach: number | null; pins: number | null; boards: number | null; business: boolean | null; domainVerified: boolean | null; merchant: boolean | null; site: string | null }> | null;
  /** Профили авторов по порядку без логинов (снимки ручного сбора) */
  ul: Array<{ views: number | null; reach: number | null; followers: number | null; pins: number | null; boards: number | null; business: boolean; domainVerified: boolean; merchant: boolean }>;
};

const SAVE_TYPE: Record<string, [string, string]> = {
  own: ["владелец сайта", "Пин со ссылкой сохранил сам владелец сайта"],
  resaved: ["пересохранение", "Пин со ссылкой сохранил другой пользователь, не владелец сайта"],
  upload: ["без ссылки", "Пин загружен пользователем без ссылки на сайт"],
};
const Acc = ({ biz }: { biz: boolean | null }) => (biz == null ? <span className="text-muted">—</span> : biz ? <span className="badge bg-info-soft text-info">бизнес</span> : <span className="badge bg-ink/5 text-muted">личный</span>);

/** Вкладка «Авторы»: кто стоит в топ-10, сколько у них аудитории и подписчиков, бизнес или личный, тип пина. */
function Authors({ item }: { item: Item }) {
  const pr = item.metrics?.prof;
  const th = "px-2 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap";
  return (
    <div className="space-y-3">
      {item.authors ? (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2"><tr><th className={th}>#</th><th className={th}>Аккаунт</th><th className={`${th} text-right`}>Подписчики</th><th className={`${th} text-right`} title="Просмотры профиля в месяц">Аудитория/мес</th><th className={`${th} text-right`}>Охват/мес</th><th className={th}>Тип аккаунта</th><th className={th}>Тип пина</th><th className={th}>Сайт</th><th className={`${th} text-right`}>Сохр.</th></tr></thead>
            <tbody>
              {item.authors.map((a) => (
                <tr key={a.position} className="border-t border-line">
                  <td className="px-2 py-1.5 tabular-nums text-muted">{a.position}</td>
                  <td className="px-2 py-1.5">{a.username ? <a href={`https://www.pinterest.com/${a.username}/`} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">@{a.username}</a> : <span className="text-muted">—</span>}{a.domainVerified && <span className="help block" title="Подтверждённый сайт">✓ {a.site ?? "сайт подтверждён"}</span>}{a.merchant && <span className="help block">проверенный магазин</span>}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.followers)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.views)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.reach)}</td>
                  <td className="px-2 py-1.5"><Acc biz={a.business} /></td>
                  <td className="px-2 py-1.5 whitespace-nowrap" title={a.saveType ? SAVE_TYPE[a.saveType]?.[1] : undefined}>{a.saveType ? SAVE_TYPE[a.saveType]?.[0] ?? a.saveType : "—"}</td>
                  <td className="px-2 py-1.5 text-[12.5px] text-ink-2">{a.domain ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(a.saves)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : item.ul.length ? (
        <>
          <p className="help">Этот снимок снят вручную: профили авторов топ-10 есть по порядку, но без логинов и без типа каждого пина. Полная таблица (логин, тип пина «владелец / пересохранение / без ссылки») появится после пересъёма через расширение.</p>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2"><tr><th className={th}>#</th><th className={`${th} text-right`}>Подписчики</th><th className={`${th} text-right`}>Аудитория/мес</th><th className={`${th} text-right`}>Охват/мес</th><th className={`${th} text-right`}>Пинов</th><th className={`${th} text-right`}>Досок</th><th className={th}>Тип аккаунта</th><th className={th}>Сайт</th></tr></thead>
              <tbody>
                {item.ul.map((u, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-2 py-1.5 tabular-nums text-muted">{i + 1}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(u.followers)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(u.views)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(u.reach)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(u.pins)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(u.boards)}</td>
                    <td className="px-2 py-1.5"><Acc biz={u.business} /></td>
                    <td className="px-2 py-1.5 text-[12.5px]">{u.domainVerified ? "✓ подтверждён" : "—"}{u.merchant ? " · магазин" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <p className="help">Профили авторов в этом снимке не собирались.</p>}
      {item.metrics?.agg && (
        <Block title="Тип пинов в выдаче (первый экран)">
          {(() => { const a = item.metrics!.agg!; return (
            <div className="grid gap-x-6 sm:grid-cols-3">
              <Stat label="Сохранил владелец сайта" value={a.own ?? "—"} p={pctOf(a.own, a.org)} />
              <Stat label="Пересохранения" value={a.resaved ?? "—"} p={pctOf(a.resaved, a.org)} />
              <Stat label="Без ссылки (загружены)" value={a.upload ?? "—"} p={pctOf(a.upload, a.org)} />
            </div>
          ); })()}
        </Block>
      )}
      {pr && (
        <Block title="Сводка по авторам топ-10">
          <div className="grid gap-x-6 sm:grid-cols-2">
            <Stat label="Бизнес-аккаунты" value={pr.biz} p={pctOf(pr.biz, pr.n)} />
            <Stat label="Личные аккаунты" value={pr.personal} p={pctOf(pr.personal, pr.n)} />
            <Stat label="Бизнес: аудитория/мес мин/ср/макс" value={trio(pr.views)} />
            <Stat label="Бизнес: охват/мес" value={trio(pr.reach)} />
            <Stat label="Бизнес: подписчики" value={trio(pr.followers)} />
            <Stat label="С подтверждённым сайтом" value={pr.dv} p={pctOf(pr.dv, pr.n)} />
          </div>
        </Block>
      )}
    </div>
  );
}

const n = (x: unknown) => (typeof x === "number" ? x : null);
const P = ({ p }: { p: number | null | undefined }) => (p == null ? null : <span className="font-normal text-muted"> · {Math.round(p)}%</span>);
function Stat({ label, value, p }: { label: string; value: ReactNode; p?: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="text-right text-[13px] font-semibold tabular-nums">{value}<P p={p} /></span>
    </div>
  );
}
function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border border-line p-3"><h4 className="mb-1.5 text-[12px] font-bold uppercase tracking-wider text-muted">{title}</h4>{children}</section>;
}
const Chips = ({ items, empty }: { items: string[]; empty: string }) =>
  items.length ? <div className="flex flex-wrap gap-1.5">{items.map((x) => <span key={x} className="rounded-md bg-ink/5 px-2 py-0.5 text-[12.5px]">{x}</span>)}</div> : <p className="help">{empty}</p>;
const trio = (t: MinAvgMax) => (t ? `${fmt(t.min)} / ${fmt(t.avg)} / ${fmt(t.max)}` : "—");
const STYLE_BADGE: Record<string, string> = { collage: "коллаж", text: "надпись", photo: "фото" };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const day = (s: string) => new Date(s).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });

const TABS = [["serp", "Выдача"], ["top", "Топ-10 и статьи"], ["authors", "Авторы"], ["history", "История"], ["words", "Вариации"]] as const;

/** Боковая карточка ключа: всё по последнему снимку и история пересъёмов. */
export function KeywordDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const router = useRouter();
  const [item, setItem] = useState<Item | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("serp");
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!id) return;
    setItem(null);
    setErr("");
    fetch(`/api/keywords/item?id=${encodeURIComponent(id)}`).then(async (r) => (r.ok ? setItem(await r.json()) : setErr((await r.json().catch(() => ({}))).error || `Ошибка ${r.status}`))).catch((e) => setErr(String(e)));
  }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  if (!id) return null;
  const k = item?.keyword;
  const m = item?.metrics;
  const a = m?.agg;
  const pr = m?.prof;
  const setStatus = (s: string) => start(async () => { await setKeywordStatus(id, s); setItem((x) => (x ? { ...x, keyword: { ...x.keyword, status: s } } : x)); router.refresh(); });
  const fl = k?.flags ? k.flags.split(",") : [];
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-ink/25" onClick={onClose} />
      {/* на телефоне прокручивается вся карточка: закреплённая шапка занимала пол-экрана */}
      <div className="relative flex h-full w-full max-w-[880px] flex-col overflow-y-auto sm:overflow-y-visible bg-surface shadow-[var(--shadow-pop)]">
        <div className="border-b border-line px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[19px] font-bold leading-snug break-words">{k?.phrase ?? "…"}</h2>
              {k && <p className="help mt-0.5">{nicheLabel(k.niche)} · {sourceLabel(k.source)} · {seasonLabel(k.season)}{k.account ? ` · выдача с ${k.account}` : ""} · {statusLabel(k.status)}</p>}
            </div>
            <button type="button" onClick={onClose} className="p-2 -m-2 text-[24px] leading-none text-muted hover:text-ink" aria-label="Закрыть">×</button>
          </div>
          {k && (
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
              <span>{k.verdict ? <span className={`badge ${verdictCls(k.verdict)}`}>{verdictLabel(k.verdict)}</span> : <span className="help">нет выдачи</span>}</span>
              <span className="text-muted">Частотность <b className="text-ink">{k.volNone ? "≈0" : fmt(n(k.volume))}</b></span>
              <span className="inline-flex items-center gap-1 text-muted">Оценка <Bar v={n(k.score)} /></span>
              <span className="inline-flex items-center gap-1 text-muted">Новый блог <Bar v={n(k.entryNew)} /></span>
              <span className="inline-flex items-center gap-1 text-muted">Старый блог <Bar v={n(k.entryOld)} /></span>
            </div>
          )}
          {fl.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{fl.map((f) => <span key={f} className="rounded-md bg-ink/5 px-2 py-0.5 text-[12px]">{flagLabel(f)}</span>)}</div>}
          {k && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {k.status !== "picked" && <button type="button" disabled={pending} onClick={() => setStatus("picked")} className="btn-brand btn-sm">В работу</button>}
              {k.status !== "rejected" && <button type="button" disabled={pending} onClick={() => setStatus("rejected")} className="btn-ghost btn-sm">Отклонить</button>}
              {k.status !== "new" && <button type="button" disabled={pending} onClick={() => setStatus("new")} className="btn-ghost btn-sm">В неразобранные</button>}
              <KeywordQueueButtons id={id} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1">
            {TABS.map(([key, label]) => <button key={key} type="button" onClick={() => setTab(key)} className={`tab ${tab === key ? "active" : ""}`}>{label}{key === "history" && item ? ` · ${item.history.length}` : ""}</button>)}
          </div>
        </div>
        <div className="sm:flex-1 sm:overflow-y-auto p-5">
          {err && <p className="text-danger">{err}</p>}
          {!item && !err && <p className="help">Загружаю…</p>}
          {item && tab === "serp" && (
            <div className="grid gap-3 md:grid-cols-2">
              <Block title="Первый экран">
                {a ? (
                  <>
                    <Stat label="Пинов" value={a.n} />
                    <Stat label="Реклама" value={a.ad} p={pctOf(a.ad, a.n)} />
                    <Stat label="Товары" value={a.prod} p={pctOf(a.prod, a.n)} />
                    <Stat label="Инфо-пины со ссылкой" value={a.info} p={pctOf(a.info, a.n)} />
                    <Stat label="Без ссылки" value={a.nolink} p={pctOf(a.nolink, a.n)} />
                    <Stat label="Видео" value={a.video} p={pctOf(a.video, a.n)} />
                    <Stat label="Ключ в заголовке" value={a.tmatch} p={pctOf(a.tmatch, a.org)} />
                    {a.ty != null && <Stat label="С годом в заголовке" value={a.ty} p={pctOf(a.ty, a.org)} />}
                    {a.own != null && <Stat label="От владельца сайта" value={a.own} p={pctOf(a.own, a.org)} />}
                    {a.resaved != null && <Stat label="Пересохранения" value={a.resaved} p={pctOf(a.resaved, a.org)} />}
                    <Stat label="Сохранения (медиана)" value={fmt(a.med)} />
                    <Stat label="Подписчики авторов (медиана)" value={fmt(a.fol)} />
                    <Stat label="Число в заголовках" value={fmt(a.listn)} />
                  </>
                ) : <p className="help">Выдача ещё не снята.</p>}
              </Block>
              <Block title="Свежесть (с весом места)">
                {a && <Stat label="Пинов < 3 мес" value={a.fresh3} p={pctOf(a.fresh3, a.n)} />}
                {a && <Stat label="Пинов < 6 мес" value={a.fresh} p={pctOf(a.fresh, a.n)} />}
                {m?.pos ? (
                  <>
                    <Stat label="Свежие вверху (вес места)" value={`${Math.round(m.pos.freshW)}%`} />
                    <Stat label="Свежих на местах 1–3" value={m.pos.freshTop3} />
                    <Stat label="Со ссылкой на местах 1–5" value={m.pos.linkTop5} />
                    <Stat label="Сохранения мест 1–3" value={fmt(m.pos.savesTop3)} />
                  </>
                ) : <p className="help">Нет дат пинов.</p>}
                <Stat label="Возраст пинов: свежий / медиана / старый, мес" value={`${fmt(n(k?.pinAgeMin), 1)} / ${fmt(n(k?.pinAgeMed), 1)} / ${fmt(n(k?.pinAgeMax), 1)}`} />
              </Block>
              <Block title="Ссылки и блоги">
                {m?.blogs ? (
                  <>
                    <Stat label="Ссылок в топ-10" value={m.blogs.links} />
                    <Stat label="Из них блоги" value={m.blogs.blogs} p={pctOf(m.blogs.blogs, m.blogs.links)} />
                    <Stat label="Платформы и магазины" value={m.blogs.platforms} p={pctOf(m.blogs.platforms, m.blogs.links)} />
                    <Stat label="Разных блогов" value={m.blogs.domains} />
                    <Stat label="Блогов на местах 1–5" value={m.blogs.top5} />
                    {a && <Stat label="Крупные СМИ и магазины" value={a.big} />}
                  </>
                ) : <p className="help">—</p>}
              </Block>
              <Block title="Оформление топ-10">
                {m?.style ? (
                  <>
                    <Stat label="Коллажи" value={m.style.collage} p={pctOf(m.style.collage, m.style.n)} />
                    <Stat label="Фото с надписью" value={m.style.text} p={pctOf(m.style.text, m.style.n)} />
                    <Stat label="Чистые фото" value={m.style.photo} p={pctOf(m.style.photo, m.style.n)} />
                  </>
                ) : <p className="help">Не определено: нужен новый снимок через расширение и ключ ИИ со зрением в слоте «Оформление пинов».</p>}
              </Block>
            </div>
          )}
          {item && tab === "top" && (
            <div className="space-y-3">
              <Block title="Статьи блогов в топ-10">
                {m?.art ? (
                  <div className="grid gap-x-6 sm:grid-cols-2">
                    <Stat label="Самая свежая, мес" value={m.art.newest} />
                    <Stat label="Самая старая, мес" value={m.art.oldest} />
                    <Stat label="Средний возраст, мес" value={m.art.avg} />
                    <Stat label="С датой" value={m.art.count} />
                    <Stat label="Устаревший год в заголовке" value={fmt(n(k?.oldYears))} />
                    <Stat label="Слов / фото (медиана)" value={`${fmt(n(k?.artWords))} / ${fmt(n(k?.artImages))}`} />
                  </div>
                ) : <p className="help">Дат статей блогов нет.</p>}
              </Block>
              <Block title="Топ-10 органики">
                {m?.top.length ? (
                  <ol className="space-y-2">
                    {m.top.map(([u, d, s], i) => {
                      const art = m.topArt?.[i];
                      const st = m.topStyle?.[i];
                      return (
                        <li key={i} className="text-[13px]">
                          <div className="flex items-baseline gap-2">
                            <span className="w-5 text-right text-muted tabular-nums">{i + 1}</span>
                            <span className="min-w-0 flex-1 break-all">{u ? <a href={u} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" title={u}>{host(u)}</a> : <span className="text-muted">без ссылки</span>}</span>
                            {art && art.blog === false && <span className="rounded bg-ink/5 px-1 text-[11px] text-muted">платформа</span>}
                            {st && STYLE_BADGE[st] && <span className="rounded bg-ink/5 px-1 text-[11px] font-bold text-ink-2">{STYLE_BADGE[st]}</span>}
                            {art?.year != null && <span className={`rounded px-1 text-[11px] font-bold tabular-nums ${art.outdated ? "bg-danger-soft text-danger" : "bg-ink/5 text-muted"}`}>{art.year}</span>}
                            <span className="whitespace-nowrap text-muted tabular-nums">{d || "—"}</span>
                            <span className="w-16 whitespace-nowrap text-right tabular-nums" title="сохранения">{s === "" ? "—" : fmt(s)}</span>
                          </div>
                          {art && (art.title || art.words != null) && <div className="pl-7 text-[12.5px] text-muted">{art.title ?? ""}{art.words != null ? `${art.title ? " · " : ""}${fmt(art.words)} слов, ${fmt(art.images)} фото` : ""}</div>}
                        </li>
                      );
                    })}
                  </ol>
                ) : <p className="help">Нет данных топа.</p>}
              </Block>
            </div>
          )}
          {item && tab === "authors" && <Authors item={item} />}
          {item && tab === "history" && <History item={item} />}
          {item && tab === "words" && (
            <div className="space-y-3">
              <Block title="Вариации для заголовков"><Chips items={m?.variants ?? []} empty="Для вопросов и гайдов вариации не делаем: модификатор сдвинет интент." /></Block>
              <Block title="Подсказки поиска Pinterest"><Chips items={m?.suggestions ?? []} empty="Нет подсказок." /></Block>
              <Block title="Уточнения (чипсы)"><Chips items={m?.guides ?? []} empty="Нет уточнений." /></Block>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** История пересъёмов: каждая строка — снимок, изменения к предыдущему подсвечены. */
function History({ item }: { item: Item }) {
  const h = item.history;
  if (!h.length) return <p className="help">Снимков выдачи нет.</p>;
  const rows = h.map((s, i) => {
    const prev = h[i + 1];
    const b = prev ? new Set(prev.keys) : null;
    const overlap = b ? pctOf(s.keys.filter((x) => b.has(x)).length, Math.max(s.keys.length, prev!.keys.length)) : null;
    return { s, prev, overlap };
  });
  const d = (a: number | null, b: number | null | undefined, invert = false) => {
    if (a == null || b == null || a === b) return null;
    const up = a > b;
    const good = invert ? !up : up;
    return <span className={`ml-1 text-[11.5px] ${good ? "text-ok" : "text-danger"}`}>{up ? "▲" : "▼"}{Math.abs(Math.round(a - b))}</span>;
  };
  return (
    <div className="space-y-3">
      {h.length < 2 && <p className="help">Пока один снимок. После пересъёма здесь будет видно, что изменилось: вердикт, оценка, коммерция, свежесть, сколько пинов топа сменилось.</p>}
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-surface-2 text-[11.5px] uppercase tracking-wide text-muted">
            <tr><th className="px-2 py-2 text-left">Снимок</th><th className="px-2 py-2 text-left">Вердикт</th><th className="px-2 py-2 text-right">Оценка</th><th className="px-2 py-2 text-right">Реклама+товары</th><th className="px-2 py-2 text-right">Свежие</th><th className="px-2 py-2 text-right">Видео</th><th className="px-2 py-2 text-right">Блоги</th><th className="px-2 py-2 text-right">Сохр.</th><th className="px-2 py-2 text-right" title="Сколько пинов топ-10 осталось с предыдущего снимка">Топ как раньше</th></tr>
          </thead>
          <tbody>
            {rows.map(({ s, prev, overlap }) => (
              <tr key={s.takenAt} className="border-t border-line">
                <td className="px-2 py-1.5 whitespace-nowrap">{day(s.takenAt)} <span className="text-muted">{new Date(s.takenAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span><span className="help block">{s.account ?? ""}</span></td>
                <td className="px-2 py-1.5 whitespace-nowrap">{s.verdict ? <span className={`badge ${verdictCls(s.verdict)}`}>{verdictLabel(s.verdict)}</span> : "—"}{prev && prev.verdict !== s.verdict && <span className="help block">было: {verdictLabel(prev.verdict) || "—"}</span>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(s.score)}{d(s.score, prev?.score)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{s.com != null ? `${Math.round(s.com)}%` : "—"}{d(s.com, prev?.com, true)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{s.fresh3 != null ? `${Math.round(s.fresh3)}%` : "—"}{d(s.fresh3, prev?.fresh3)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{s.video != null ? `${Math.round(s.video)}%` : "—"}{d(s.video, prev?.video)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{s.blogs != null ? `${Math.round(s.blogs)}%` : "—"}{d(s.blogs, prev?.blogs)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmt(s.saves)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{overlap != null ? `${overlap}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Block title="Частотность по замерам">
        {item.volumes.length ? item.volumes.map((v) => <Stat key={v.takenAt} label={day(v.takenAt)} value={v.value === 0 ? "≈0" : fmt(v.value)} />) : <p className="help">Замеров нет.</p>}
      </Block>
      <p className="help">Оценка в истории считается по выдаче и позициям (без данных статей), чтобы снимки сравнивались одинаково; поэтому она может немного отличаться от оценки в таблице.</p>
    </div>
  );
}
