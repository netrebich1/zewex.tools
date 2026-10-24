"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import type { ServerStatus } from "@/lib/serverStatus";

/** Цвет по занятости: до 60 % — норма, до 85 % — внимание, выше — плохо. Для диска пороги по свободному месту. */
function tone(pct: number) {
  if (pct >= 85) return "text-danger";
  if (pct >= 60) return "text-warn";
  return "text-ok";
}
function diskTone(freePct: number) {
  if (freePct < 10) return "text-danger";
  if (freePct < 20) return "text-warn";
  return "text-ok";
}
const bar = (pct: number, cls: string) => (
  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/5">
    <div className={`h-full rounded-full ${cls.replace("text-", "bg-")}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
  </div>
);

/** Простыми словами: что сейчас с сервером и чего ждать. */
function verdict(s: ServerStatus): { text: string; cls: string } {
  const freePct = 100 - s.disk.usedPct;
  const overload = s.cpu.load5 / Math.max(1, s.cpu.cores);
  if (freePct < 10) return { text: `Мало места на диске: осталось ${s.disk.freeGb} ГБ. Новые картинки и статьи могут перестать сохраняться — скажите администратору.`, cls: "text-danger" };
  if (s.memory.usedPct >= 90) return { text: "Память почти закончилась: задачи могут падать. Скажите администратору.", cls: "text-danger" };
  if (s.cpu.busyPct >= 85 || overload >= 3) return { text: "Сервер сильно загружен: прогоны и статьи идут медленнее обычного, страницы открываются дольше. Это не ошибка — работа продолжится.", cls: "text-warn" };
  if (s.cpu.ioWaitPct >= 25) return { text: "Сервер ждёт диск (много чтения и записи файлов): возможны задержки.", cls: "text-warn" };
  if (freePct < 20) return { text: `Место на диске заканчивается: свободно ${s.disk.freeGb} ГБ. Пора чистить старые файлы.`, cls: "text-warn" };
  if (s.cpu.busyPct >= 60 || overload >= 1.5) return { text: "Сервер заметно загружен, но справляется.", cls: "text-muted" };
  return { text: "Всё в порядке: запас по месту, процессору и памяти есть.", cls: "text-ok" };
}

/** Плашка «Сервер» рядом с балансами: свободное место, загрузка процессора и памяти; по клику — подробности. Обновляется раз в 30 с, пока вкладка открыта. */
export function HeaderServer() {
  const [s, setS] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/server-status", { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setS((await res.json()) as ServerStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const freePct = s ? 100 - s.disk.usedPct : 0;
  const v = s ? verdict(s) : null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="flex shrink-0 items-center gap-2 h-9 whitespace-nowrap rounded-full border border-line bg-surface px-3 hover:border-line-2 transition text-[13px]"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Состояние сервера"
      >
        <Icon.server width={15} height={15} className={`shrink-0 ${v ? v.cls : "text-muted"} ${busy && !s ? "animate-pulse" : ""}`} />
        {s ? (
          <span className="hidden lg:flex items-center gap-2 tabular-nums whitespace-nowrap">
            {[
              { k: "disk", label: "Диск", value: `${Math.round(s.disk.freeGb)} ГБ`, cls: diskTone(freePct) },
              { k: "cpu", label: "CPU", value: `${s.cpu.busyPct}%`, cls: tone(s.cpu.busyPct) },
              { k: "ram", label: "RAM", value: `${s.memory.usedPct}%`, cls: tone(s.memory.usedPct) },
            ].map((x, i) => (
              <span key={x.k} className="inline-flex items-baseline gap-1">
                {i > 0 && <span className="mr-1 h-3 w-px self-center bg-line" aria-hidden />}
                <span className="text-muted font-medium">{x.label}</span>
                <span className={`font-semibold ${x.cls}`}>{x.value}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="hidden lg:block text-muted">{error ? "ошибка" : "…"}</span>
        )}
      </button>

      {open && (
        <div className="menu popover !p-0 sm:!w-[320px]" role="dialog" aria-label="Состояние сервера">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
            <div>
              <div className="text-[14px] font-semibold">Сервер</div>
              <div className="help">{s ? `Обновлено ${new Date(s.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · раз в 30 с` : "Загружаем…"}</div>
            </div>
            <button type="button" onClick={() => void load()} disabled={busy} className="btn-ghost btn-sm" title="Замерить заново">
              <Icon.refresh width={14} height={14} className={busy ? "animate-spin" : ""} /> Обновить
            </button>
          </div>
          {error && <div className="px-4 py-3 text-[13px] text-danger">{error}</div>}
          {s && v && (
            <>
              <div className={`px-4 py-3 border-b border-line text-[13px] ${v.cls}`}>{v.text}</div>
              <div className="px-4 py-3 border-b border-line">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold">Свободно на диске</span>
                  <span className={`text-[18px] font-bold tabular-nums ${diskTone(freePct)}`}>{s.disk.freeGb} ГБ</span>
                </div>
                {bar(s.disk.usedPct, diskTone(freePct))}
                <div className="mt-1 help">Занято {s.disk.usedPct}% из {s.disk.totalGb} ГБ. Сюда сохраняются картинки пинов, фото статей и база.</div>
              </div>
              <div className="px-4 py-3 border-b border-line">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold">Процессор</span>
                  <span className={`text-[18px] font-bold tabular-nums ${tone(s.cpu.busyPct)}`}>{s.cpu.busyPct}%</span>
                </div>
                {bar(s.cpu.busyPct, tone(s.cpu.busyPct))}
                <div className="mt-1 help">
                  Ядер: {s.cpu.cores}. Очередь задач за 1 / 5 / 15 мин: {s.cpu.load1} / {s.cpu.load5} / {s.cpu.load15}
                  {s.cpu.load5 > s.cpu.cores ? ` — больше числа ядер, задачи ждут своей очереди.` : "."}
                  {s.cpu.ioWaitPct > 0 && ` Ожидание диска: ${s.cpu.ioWaitPct}%.`}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold">Память</span>
                  <span className={`text-[18px] font-bold tabular-nums ${tone(s.memory.usedPct)}`}>{s.memory.usedPct}%</span>
                </div>
                {bar(s.memory.usedPct, tone(s.memory.usedPct))}
                <div className="mt-1 help">Свободно {s.memory.availableGb} ГБ из {s.memory.totalGb} ГБ. Сервер работает без перезагрузки {s.uptimeHours >= 48 ? `${Math.round(s.uptimeHours / 24)} дн.` : `${s.uptimeHours} ч`}</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
