"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { pollWhileVisible } from "@/lib/poll";
import { Alert } from "@/components/ui";
import { WorkerPill } from "./ArticlesBoard";
import { Fold, More } from "@/components/ui/Fold";
import type { AutomationPayload, AutostartCounts, SiteAutomationPatch, SiteAutostartRow, ArtGlobalSettings } from "@/lib/articles/automation";
import { SITE_LIMITS as L } from "@/lib/articles/types";

/**
 * Экран «Автозапуск сайтов»: 8 плиток-счётчиков по шагам пути статьи, легенда, таблица сайтов с переключателями
 * и лимитами (сохраняются сразу: переключатели — по клику, числа — по blur/Enter), строка «Все сайты» с панелью
 * подтверждения, диагностика «что мешает сейчас». Данные обновляются каждые 30 с из /api/articles/automation.
 * Те же поля и пределы (SITE_LIMITS), что в форме настроек сайта. Цепочки сами не выключаются (с 2026-10-15).
 * Оригинал: src/pages/SitesAutostartPage.tsx.
 */
export function AutomationTable({ initial }: { initial: AutomationPayload }) {
  const [data, setData] = useState<AutomationPayload>(initial);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; hint: string; body: object } | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    try {
      const res = await fetch("/api/articles/automation", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setData((await res.json()) as AutomationPayload);
      setErr("");
    } catch {
      setErr("Нет связи с сервером, показаны последние данные");
    }
  }, []);

  useEffect(() => {
    return pollWhileVisible(refresh, 30_000);
  }, [refresh]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const send = useCallback(async (body: object, key: string, okText = "Сохранено") => {
    busy.current = true;
    setSaving(key);
    try {
      const res = await fetch("/api/articles/automation", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as AutomationPayload & { error?: string };
      if (!res.ok) throw new Error(j.error || "Не удалось сохранить");
      setData(j);
      setErr("");
      setFlash(okText);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(null);
      busy.current = false;
    }
  }, []);

  /** Оптимистично меняем строку сайта, затем шлём патч. */
  const saveSite = (site: SiteAutostartRow, patch: SiteAutomationPatch, key: string) => {
    setData((d) => ({ ...d, sites: d.sites.map((s) => (s.id === site.id ? { ...s, autostart: { ...s.autostart, ...(patch.autostart ?? {}) }, aiModeration: { ...s.aiModeration, ...(patch.aiModeration ?? {}) } } : s)) }));
    void send({ siteId: site.id, patch }, key);
  };

  const askAll = (title: string, hint: string, patch: SiteAutomationPatch) => setConfirm({ title, hint, body: { all: true, patch } });
  const applyConfirm = async () => {
    if (!confirm) return;
    const body = confirm.body;
    setConfirm(null);
    await send(body, "all", "Сохранено для всех сайтов");
  };

  const saveGlobal = (patch: Partial<ArtGlobalSettings>, key: string) => {
    setData((d) => ({ ...d, global: { ...d.global, ...patch } }));
    void send({ global: patch }, key);
  };

  const { sites, totals, global, worker, canEditGlobal } = data;
  const n = sites.length;
  const every = (f: (s: SiteAutostartRow) => boolean) => n > 0 && sites.every(f);
  const allPhoto = (v: boolean) => askAll(`${v ? "Включить" : "Выключить"} поиск фото на всех сайтах?`, v ? "Воркер начнёт брать статьи, ждущие поиска фото, на каждом сайте." : "Новые статьи перестанут уходить в поиск фото; текущие доработают этап. Сами этапы не включатся — только вручную.", { autostart: { photoEnabled: v } });
  const allWriting = (v: boolean) => askAll(`${v ? "Включить" : "Выключить"} написание на всех сайтах?`, v ? "Статьи с одобренными фото пойдут в текст на каждом сайте." : "Новые статьи перестанут уходить в написание; текущие доработают этап. Сами этапы не включатся — только вручную.", { autostart: { writingEnabled: v } });
  const allAi = (v: boolean) => askAll(`${v ? "Включить" : "Выключить"} ИИ-проверку фото на всех сайтах?`, v ? "Фото каждой статьи после отбора будет проверять ИИ, сразу, без пачек. Новые запуски получат «модерацию фото до текста» автоматически." : "Все статьи с подобранными фото будут ждать сотрудника.", { aiModeration: { enabled: v } });
  const aiTotals = sites.reduce((acc, s) => ({ checking: acc.checking + (s.ai?.checking ?? 0), waiting: acc.waiting + (s.ai?.waiting ?? 0), staff: acc.staff + (s.ai?.staff ?? s.counts.review) }), { checking: 0, waiting: 0, staff: 0 });

  const tiles: Array<{ step: string; label: string; value: number; detail: string; problem?: boolean; href?: string }> = [
    { step: "1", label: "Ждут поиска фото", value: totals.photoWait, detail: "Ещё не запущены" },
    { step: "1", label: "Фото ищутся сейчас", value: totals.photoRun, detail: "Обрабатываются" },
    { step: "2", label: "Ждут проверки фото", value: totals.review, detail: aiTotals.checking + aiTotals.waiting > 0 ? `ИИ: ${aiTotals.checking} проверяет, ${aiTotals.waiting} ждёт` : "ИИ или сотрудник", href: "/pinterest/articles/moderation/articles" },
    { step: "2", label: "Недостаточно фото", value: totals.few, detail: "Нужен добор или решение", problem: true, href: "/pinterest/articles/moderation/articles?tab=low" },
    { step: "3", label: "Ждут написания", value: totals.writeWait, detail: "Фото уже одобрены" },
    { step: "3", label: "Пишутся сейчас", value: totals.writeRun, detail: "Текст создаётся" },
    { step: "4", label: "Ждут публикации", value: totals.publishWait, detail: "Статья готова", href: "/pinterest/articles/publications" },
    { step: "!", label: "Пауза или ошибка", value: totals.problems, detail: `${totals.paused} на паузе · ${totals.failed} с ошибкой`, problem: true, href: "/pinterest/articles/journal" },
  ];

  return (
    <div className="space-y-4">
      {/* Плитки */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {tiles.map((t) => {
          const bad = t.problem && t.value > 0;
          const inner = (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className={`kpi-value ${bad ? "text-danger" : ""}`}>{t.value}</p>
                <span className="text-[10px] font-semibold text-muted">ШАГ {t.step}</span>
              </div>
              <p className="mt-1 text-[12.5px] font-medium leading-tight">{t.label}</p>
              <p className="help !text-[11px]">{t.detail}</p>
            </>
          );
          const cls = `kpi !p-3 ${bad ? "border-danger/40" : ""}`;
          return t.href ? <Link key={t.label} href={t.href} className={`${cls} card-hover`}>{inner}</Link> : <div key={t.label} className={cls}>{inner}</div>;
        })}
      </div>

      {/* Легенда */}
      <Fold className="bg-surface-2/60 text-[13px]" title="Как читать таблицу" summary="Ждут · Сейчас · Ждут проверки фото">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px] text-muted">
        <span><b className="text-ink">Ждут</b> — этап ещё не начался</span>
        <span><b className="text-brand">Сейчас</b> — обрабатываются в данный момент</span>
        <span><b className="text-ink">Ждут проверки фото</b> — фото подобраны; проверяет ИИ (если включена ИИ-проверка) или сотрудник</span>
        <span>Этапы сами <b className="text-ink">не выключаются</b> — только переключателями</span>
      </div>
      </Fold>

      {/* Воркер и мастер-выключатели */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2">
        <WorkerPill w={{ running: worker.running, alive: worker.runningTotal, pending: worker.pending, stuck: worker.running > 0 && worker.runningTotal === 0 }} />
        {worker.cap > 0 && (
          <span
            className={`badge px-2.5 py-1 tabular-nums !whitespace-normal !rounded-lg text-left ${worker.runningTotal >= worker.cap ? "bg-warn-soft text-warn" : "bg-ink/5"}`}
            title={`Потолок воркера (ARTICLES_WORKER_CONCURRENCY в службе zewex-worker): больше ${worker.cap} статей сразу не идёт на всех сайтах вместе — поиск, написание и публикация делят эти места. Лимиты сайтов действуют внутри него.`}
          >
            Потолок воркера: {worker.runningTotal} / {worker.cap}
          </span>
        )}
        {worker.disk && (
          <span
            className={`badge px-2.5 py-1 tabular-nums !whitespace-normal !rounded-lg text-left ${worker.disk.freeMb < worker.disk.totalMb * 0.15 ? "bg-danger-soft text-danger" : "bg-ink/5"}`}
            title={`Файлы статей хранятся (фото статей и одобренные ИИ кандидаты); удаляются только отклонённые. Свободно ${gb(worker.disk.freeMb)} из ${gb(worker.disk.totalMb)} на диске сервера. Замер ${new Date(worker.disk.at).toLocaleString("ru-RU")}, обновляется раз в 30 мин.`}
          >
            Диск: статьи {gb(worker.disk.storageMb)} · свободно {gb(worker.disk.freeMb)} из {gb(worker.disk.totalMb)}
          </span>
        )}
        <span className="help">Мастер-выключатели (все сайты сразу):</span>
        <MasterSwitch label="Поиск фото" on={global.photoMaster} disabled={!canEditGlobal} saving={saving === "g-photo"} onChange={(v) => saveGlobal({ photoMaster: v }, "g-photo")} />
        <MasterSwitch label="Написание" on={global.writingMaster} disabled={!canEditGlobal} saving={saving === "g-writing"} onChange={(v) => saveGlobal({ writingMaster: v }, "g-writing")} />
        <MasterSwitch label="Публикация" on={global.publishMaster} disabled={!canEditGlobal} saving={saving === "g-publish"} onChange={(v) => saveGlobal({ publishMaster: v }, "g-publish")} />
        <MasterSwitch label="ИИ-проверка фото" title="Выключено — ИИ не проверяет фото ни на одном сайте, статьи ждут сотрудника. Включено — ИИ проверяет на сайтах, где включена «ИИ-проверка фото»." on={global.aiModMaster} disabled={!canEditGlobal} saving={saving === "g-aimod"} onChange={(v) => saveGlobal({ aiModMaster: v }, "g-aimod")} />
        <label className="inline-flex items-center gap-1.5 text-[12.5px]" title={`Свой потолок одновременных статей «В работе» на всех сайтах (меньше потолка воркера). 0 — только потолок воркера${worker.cap ? ` (${worker.cap})` : ""}.`}>
          <span className="text-muted">Общий потолок</span>
          <NumInput value={global.maxConcurrent} min={0} max={300} disabled={!canEditGlobal} onSave={(v) => saveGlobal({ maxConcurrent: v }, "g-max")} />
        </label>
        {!canEditGlobal && <span className="help">Мастер-выключатели меняет администратор или лидер команды.</span>}
      </div>

      {(err || flash) && (
        <div className="flex flex-wrap items-center gap-2">
          {err && <Alert tone="danger">{err}</Alert>}
          {flash && <Alert tone="ok">{flash}</Alert>}
        </div>
      )}

      {confirm && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[14px]">
          <p className="font-medium">{confirm.title}</p>
          <p className="help mt-0.5">{confirm.hint}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={applyConfirm} disabled={saving === "all"}>Да, применить ко всем ({n})</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirm(null)}>Отмена</button>
          </div>
        </div>
      )}

      {/* Телефон: карточки вместо таблицы на 19 колонок */}
      <div className="md:hidden space-y-2">
        <div className="card p-3 space-y-2 text-[13px]">
          <p className="font-semibold">Все сайты</p>
          <CardRow title="Поиск фото" info={<>ждут {num(totals.photoWait)} · сейчас {num(totals.photoRun, "run")}</>}>
            <Switch label="Поиск фото на всех сайтах" on={every((s) => s.autostart.photoEnabled)} disabled={!n || saving === "all"} onChange={allPhoto} />
          </CardRow>
          <CardRow title="Проверка фото" info={<>ждут {num(totals.review)} · мало фото {num(totals.few, "bad")}</>} />
          <CardRow title="Написание" info={<>ждут {num(totals.writeWait)} · сейчас {num(totals.writeRun, "run")}</>}>
            <Switch label="Написание на всех сайтах" on={every((s) => s.autostart.writingEnabled)} disabled={!n || saving === "all"} onChange={allWriting} />
          </CardRow>
          <CardRow title="Публикация" info={<>ждут {num(totals.publishWait)}</>} />
          <CardRow title="ИИ-проверка фото">
            <Switch label="ИИ-проверка фото на всех сайтах" on={every((s) => s.aiModeration.enabled)} disabled={!n || saving === "all"} onChange={allAi} />
          </CardRow>
          <CardRow title="Пауза / ошибка" info={num(totals.problems, "bad")} />
        </div>
        {n === 0 && <p className="card p-5 text-center help">Сайтов в сервисе нет. <Link href="/pinterest/articles/sites" className="underline">Подключить сайт</Link></p>}
        {sites.map((s) => <SiteCard key={s.id} s={s} saving={saving} onSave={(patch, key) => saveSite(s, patch, key)} />)}
      </div>

      {/* Таблица */}
      <div className="card overflow-x-auto hidden md:block">
        <table className="w-full min-w-[1560px] text-[12.5px]">
          <thead className="text-muted">
            <tr className="border-b border-line [&>th]:px-2 [&>th]:pt-2.5 [&>th]:pb-1 [&>th]:text-center [&>th]:font-semibold [&>th]:text-ink">
              <th rowSpan={2} className="!text-left min-w-44 pl-3">Сайт</th>
              <th colSpan={4} className="border-l border-line/60">1. Поиск фото</th>
              <th colSpan={2} className="border-l border-line/60">2. Проверка фото</th>
              <th colSpan={4} className="border-l border-line/60">3. Написание</th>
              <th colSpan={2} className="border-l border-line/60">4. Публикация</th>
              <th colSpan={4} className="border-l border-line/60">ИИ-проверка фото</th>
              <th rowSpan={2} className="border-l border-line/60" title="На паузе, остановлены, с ошибкой">Пауза / ошибка</th>
              <th rowSpan={2} className="!text-left min-w-72 border-l border-line/60">Что мешает сейчас</th>
            </tr>
            <tr className="border-b border-line [&>th]:px-2 [&>th]:py-1.5 [&>th]:text-center [&>th]:font-medium [&>th]:whitespace-nowrap">
              <th className="border-l border-line/60">Включён</th><th title={`Одновременно статей сайта в поиске фото (${L.photoLimit[0]}–${L.photoLimit[1]})`}>Лимит</th><th>Ждут</th><th className="text-brand">Сейчас</th>
              <th className="border-l border-line/60" title="Фото подобраны: проверяет ИИ (если включена) или сотрудник">Ждут проверки</th><th>Мало фото</th>
              <th className="border-l border-line/60">Включено</th><th title={`Одновременно статей сайта в написании (${L.writingLimit[0]}–${L.writingLimit[1]})`}>Лимит</th><th>Ждут</th><th className="text-brand">Сейчас</th>
              <th className="border-l border-line/60" title={`Одновременно публикаций (${L.publishLimit[0]}–${L.publishLimit[1]}): загрузка фото нагружает хостинг`}>Лимит</th><th>Ждут</th>
              <th className="border-l border-line/60" title="Включено — фото каждой статьи сайта после отбора проверяет ИИ (в течение ~20 с)">Включена</th>
              <th title={`Сколько статей ИИ проверяет параллельно (${L.concurrency[0]}–${L.concurrency[1]})`}>Параллельно</th>
              <th title={`Запуск от (статей): новый запуск ИИ, когда ждут столько статей (${L.batchFrom[0]}–${L.batchFrom[1]}). 1 — сразу. К идущему запуску новые статьи добавляются без ожидания`}>Запуск от</th>
              <th title={`ИИ-проверка ждёт, если в публикации столько статей и больше (${L.backlogThreshold[0]}–${L.backlogThreshold[1]}). 0 — не ждать`}>Ждать, если в публ. ≥</th>
            </tr>
            {/* Все сайты */}
            <tr className="border-b border-line bg-surface-2/60 [&>th]:px-2 [&>th]:py-2 [&>th]:text-center">
              <th className="!text-left pl-3 text-ink">Все сайты</th>
              <th className="border-l border-line/60"><Switch label="Поиск фото на всех сайтах" on={every((s) => s.autostart.photoEnabled)} disabled={!n || saving === "all"} onChange={allPhoto} /></th>
              <th /><th>{num(totals.photoWait)}</th><th>{num(totals.photoRun, "run")}</th>
              <th className="border-l border-line/60">{num(totals.review)}</th><th>{num(totals.few, "bad")}</th>
              <th className="border-l border-line/60"><Switch label="Написание на всех сайтах" on={every((s) => s.autostart.writingEnabled)} disabled={!n || saving === "all"} onChange={allWriting} /></th>
              <th /><th>{num(totals.writeWait)}</th><th>{num(totals.writeRun, "run")}</th>
              <th className="border-l border-line/60" /><th>{num(totals.publishWait)}</th>
              <th className="border-l border-line/60"><Switch label="ИИ-проверка фото на всех сайтах" on={every((s) => s.aiModeration.enabled)} disabled={!n || saving === "all"} onChange={allAi} /></th>
              <th /><th /><th />
              <th className="border-l border-line/60">{num(totals.problems, "bad")}</th>
              <th className="border-l border-line/60" />
            </tr>
          </thead>
          <tbody>
            {n === 0 && <tr><td colSpan={19} className="p-5 text-center help">Сайтов в сервисе нет. <Link href="/pinterest/articles/sites" className="underline">Подключить сайт</Link></td></tr>}
            {sites.map((s) => <SiteRow key={s.id} s={s} saving={saving} onSave={(patch, key) => saveSite(s, patch, key)} />)}
          </tbody>
        </table>
      </div>
      <More short={<>Этапы работают, пока включены: сами они не выключаются и не включаются. Обновлено: {new Date(data.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.</>}>
        Мастер-выключатели сверху останавливают этап на всех сайтах сразу, не меняя настроек сайтов.
        ИИ-проверка фото: включена на сайте и мастер-выключатель включён — фото каждой новой статьи ИИ берёт в течение ~20 секунд; сомнительные отдаёт сотруднику. Те же настройки — в настройках сайта.
      </More>
    </div>
  );
}

/* ───────── Строка сайта ───────── */

function SiteRow({ s, saving, onSave }: { s: SiteAutostartRow; saving: string | null; onSave: (patch: SiteAutomationPatch, key: string) => void }) {
  const c = s.counts;
  const a = s.autostart;
  const m = s.aiModeration;
  const ai = s.ai ?? { on: false, checking: 0, waiting: 0, staff: c.review };
  const k = (f: string) => `${s.id}:${f}`;
  const sub = (text: string, cls = "text-muted") => <span className={`block text-[10px] leading-tight whitespace-nowrap ${cls}`}>{text}</span>;
  return (
    <tr className={`border-b border-line/70 last:border-b-0 hover:bg-surface-2/70 [&>td]:px-2 [&>td]:py-2 [&>td]:text-center ${s.isActive ? "" : "opacity-60"}`}>
      <td className="!text-left pl-3 whitespace-nowrap">
        <Link href={`/pinterest/articles/sites/${s.id}?tab=settings`} className="font-medium hover:underline">{s.name}</Link>
        {!s.isActive && <span className="block text-[10px] text-muted">в архиве</span>}
      </td>
      <td className="border-l border-line/60"><Switch label={`Поиск фото: ${s.name}`} on={a.photoEnabled} disabled={saving === k("photoEnabled")} onChange={(v) => onSave({ autostart: { photoEnabled: v } }, k("photoEnabled"))} /></td>
      <td><NumInput value={a.photoLimit} min={L.photoLimit[0]} max={L.photoLimit[1]} onSave={(v) => onSave({ autostart: { photoLimit: v } }, k("photoLimit"))} /></td>
      <td>{num(c.photoWait)}</td>
      <td>{num(c.photoRun, "run")}</td>
      <td className="border-l border-line/60">
        {num(c.review)}
        {c.review > 0 && (ai.on ? sub(`ИИ ${ai.checking + ai.waiting} · сотр. ${ai.staff}`) : sub("сотрудник"))}
      </td>
      <td>{num(c.few, "bad")}</td>
      <td className="border-l border-line/60"><Switch label={`Написание: ${s.name}`} on={a.writingEnabled} disabled={saving === k("writingEnabled")} onChange={(v) => onSave({ autostart: { writingEnabled: v } }, k("writingEnabled"))} /></td>
      <td><NumInput value={a.writingLimit} min={L.writingLimit[0]} max={L.writingLimit[1]} onSave={(v) => onSave({ autostart: { writingLimit: v } }, k("writingLimit"))} /></td>
      <td>{num(c.writeWait)}</td>
      <td>{num(c.writeRun, "run")}</td>
      <td className="border-l border-line/60"><NumInput value={a.publishLimit} min={L.publishLimit[0]} max={L.publishLimit[1]} onSave={(v) => onSave({ autostart: { publishLimit: v } }, k("publishLimit"))} /></td>
      <td>{num(c.publishWait)}{c.publishRun > 0 && sub(`сейчас ${c.publishRun}`, "text-brand")}</td>
      <td className="border-l border-line/60">
        <Switch label={`ИИ-проверка фото: ${s.name}`} on={m.enabled} disabled={saving === k("aiEnabled")} onChange={(v) => onSave({ aiModeration: { enabled: v } }, k("aiEnabled"))} />
        {m.enabled && !ai.on && sub("мастер выкл.", "text-danger")}
        {ai.on && (ai.checking > 0 || ai.waiting > 0) && sub(`проверяет ${ai.checking} · ждёт ${ai.waiting}`, "text-brand")}
      </td>
      <td><NumInput value={m.concurrency} min={L.concurrency[0]} max={L.concurrency[1]} onSave={(v) => onSave({ aiModeration: { concurrency: v } }, k("aiConc"))} /></td>
      <td><NumInput value={m.batchFrom} min={L.batchFrom[0]} max={L.batchFrom[1]} onSave={(v) => onSave({ aiModeration: { batchFrom: v } }, k("aiBatch"))} /></td>
      <td><NumInput value={m.backlogThreshold} min={L.backlogThreshold[0]} max={L.backlogThreshold[1]} onSave={(v) => onSave({ aiModeration: { backlogThreshold: v } }, k("aiBacklog"))} /></td>
      <td className="border-l border-line/60">{num(c.problems, "bad")}</td>
      <td className="!text-left border-l border-line/60 text-[11.5px] leading-snug">
        {s.blockers.map((b, i) => <p key={i} className={b.bad ? "text-danger" : "text-muted"}>{b.text}</p>)}
      </td>
    </tr>
  );
}

/* ───────── Карточка сайта (телефон): те же переключатели, поля и ключи сохранения, что в строке таблицы ───────── */

function SiteCard({ s, saving, onSave }: { s: SiteAutostartRow; saving: string | null; onSave: (patch: SiteAutomationPatch, key: string) => void }) {
  const c = s.counts;
  const a = s.autostart;
  const m = s.aiModeration;
  const ai = s.ai ?? { on: false, checking: 0, waiting: 0, staff: c.review };
  const k = (f: string) => `${s.id}:${f}`;
  return (
    <div className={`card p-3 space-y-2 text-[13px] ${s.isActive ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/pinterest/articles/sites/${s.id}?tab=settings`} className="font-semibold hover:underline min-w-0 [overflow-wrap:anywhere]">{s.name}</Link>
        {c.problems > 0 && <span className="badge bg-danger-soft text-danger">пауза / ошибка {c.problems}</span>}
        {!s.isActive && <span className="text-[11.5px] text-muted">в архиве</span>}
      </div>
      <CardRow title="Поиск фото" info={<>ждут {num(c.photoWait)} · сейчас {num(c.photoRun, "run")}</>}>
        <Switch label={`Поиск фото: ${s.name}`} on={a.photoEnabled} disabled={saving === k("photoEnabled")} onChange={(v) => onSave({ autostart: { photoEnabled: v } }, k("photoEnabled"))} />
        <NumInput value={a.photoLimit} min={L.photoLimit[0]} max={L.photoLimit[1]} onSave={(v) => onSave({ autostart: { photoLimit: v } }, k("photoLimit"))} />
      </CardRow>
      <CardRow
        title="Проверка фото"
        info={
          <>
            ждут {num(c.review)}
            {c.review > 0 && <span className="text-muted">{ai.on ? ` (ИИ ${ai.checking + ai.waiting} · сотр. ${ai.staff})` : " (сотрудник)"}</span>} · мало фото {num(c.few, "bad")}
          </>
        }
      />
      <CardRow title="Написание" info={<>ждут {num(c.writeWait)} · сейчас {num(c.writeRun, "run")}</>}>
        <Switch label={`Написание: ${s.name}`} on={a.writingEnabled} disabled={saving === k("writingEnabled")} onChange={(v) => onSave({ autostart: { writingEnabled: v } }, k("writingEnabled"))} />
        <NumInput value={a.writingLimit} min={L.writingLimit[0]} max={L.writingLimit[1]} onSave={(v) => onSave({ autostart: { writingLimit: v } }, k("writingLimit"))} />
      </CardRow>
      <CardRow title="Публикация" info={<>ждут {num(c.publishWait)} · сейчас {num(c.publishRun, "run")}</>}>
        <NumInput value={a.publishLimit} min={L.publishLimit[0]} max={L.publishLimit[1]} onSave={(v) => onSave({ autostart: { publishLimit: v } }, k("publishLimit"))} />
      </CardRow>
      <CardRow
        title="ИИ-проверка"
        info={
          m.enabled && !ai.on ? <span className="text-danger">мастер выкл.</span> : ai.on && (ai.checking > 0 || ai.waiting > 0) ? <span className="text-brand">проверяет {ai.checking} · ждёт {ai.waiting}</span> : null
        }
      >
        <Switch label={`ИИ-проверка фото: ${s.name}`} on={m.enabled} disabled={saving === k("aiEnabled")} onChange={(v) => onSave({ aiModeration: { enabled: v } }, k("aiEnabled"))} />
      </CardRow>
      <details>
        <summary className="cursor-pointer text-muted">Настройки ИИ-проверки</summary>
        <div className="mt-2 space-y-2">
          <CardRow title="Параллельно" info={`${L.concurrency[0]}–${L.concurrency[1]}`}>
            <NumInput value={m.concurrency} min={L.concurrency[0]} max={L.concurrency[1]} onSave={(v) => onSave({ aiModeration: { concurrency: v } }, k("aiConc"))} />
          </CardRow>
          <CardRow title="Запуск от" info="статей в ожидании">
            <NumInput value={m.batchFrom} min={L.batchFrom[0]} max={L.batchFrom[1]} onSave={(v) => onSave({ aiModeration: { batchFrom: v } }, k("aiBatch"))} />
          </CardRow>
          <CardRow title="Ждать, если в публ. ≥" info="0 — не ждать">
            <NumInput value={m.backlogThreshold} min={L.backlogThreshold[0]} max={L.backlogThreshold[1]} onSave={(v) => onSave({ aiModeration: { backlogThreshold: v } }, k("aiBacklog"))} />
          </CardRow>
        </div>
      </details>
      {s.blockers.length > 0 && (
        <div className="border-t border-line/70 pt-2 text-[12px] leading-snug">
          {s.blockers.map((b, i) => <p key={i} className={b.bad ? "text-danger" : "text-muted"}>{b.text}</p>)}
        </div>
      )}
    </div>
  );
}

/** Строка карточки: название и счётчики слева, переключатель и лимит справа. */
function CardRow({ title, info, children }: { title: string; info?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {info != null && <p className="text-[12px] text-muted">{info}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/* ───────── Примитивы ───────── */

function num(v: number, tone: "wait" | "run" | "bad" = "wait"): ReactNode {
  const cls = tone === "run" ? "text-brand" : tone === "bad" && v > 0 ? "text-danger" : v === 0 ? "text-muted" : "text-ink";
  return <span className={`tabular-nums font-semibold ${cls}`}>{v}</span>;
}

/** Переключатель-пилюля (без внешних библиотек). */
function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 sm:h-5 sm:w-9 shrink-0 items-center rounded-full border transition ${on ? "bg-ok border-ok" : "bg-ink/10 border-line-2"} ${disabled ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-5 w-5 sm:h-4 sm:w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px] sm:translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

function MasterSwitch({ label, on, onChange, disabled, saving, title }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean; saving?: boolean; title?: string }) {
  return (
    // label: касание по всей пилюле (и по подписи) переключает
    <label title={title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] ${disabled || saving ? "" : "cursor-pointer"} ${on ? "border-line" : "border-danger/40 bg-danger-soft"}`}>
      <Switch label={`Мастер-выключатель: ${label}`} on={on} onChange={onChange} disabled={disabled || saving} />
      <span className={on ? "" : "text-danger"}>{label}</span>
    </label>
  );
}

/** Число: сохраняется по blur или Enter, если изменилось; снаружи обновляется только когда поле не в фокусе. */
function NumInput({ value, min, max, onSave, disabled }: { value: number; min: number; max: number; onSave: (v: number) => void; disabled?: boolean }) {
  const [local, setLocal] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(String(value)); }, [value, focused]);
  const commit = () => {
    const raw = Number(local);
    const v = Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.round(raw))) : value;
    setLocal(String(v));
    if (v !== value) onSave(v);
  };
  return (
    <input
      type="number" min={min} max={max} value={local} disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
      className="input !w-16 !py-1 !px-1.5 text-center sm:!text-[12.5px] tabular-nums disabled:opacity-50"
    />
  );
}

/** МБ → «1,2 ГБ» / «850 МБ». */
function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ` : `${mb} МБ`;
}
