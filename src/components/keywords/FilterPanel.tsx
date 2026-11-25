"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { FIELDS, GROUPS, filterSpec, toggles, type Field } from "@/lib/keywords/fields";
import { FLAGS, MIN_VOLUME, NICHES, SEASONS, SOURCES, STATUSES, VERDICTS } from "@/lib/keywords/types";
import { Chip, Hint, useQueryNav } from "./kwui";

type Opt = { value: string; label: string };
type Draft = Record<string, string>;

/** Строка «метрика: от – до» в единицах выбранного режима (проценты или штуки). */
function RangeRow({ f, mode, lo, hi, onLo, onHi }: { f: Field; mode: "pct" | "cnt"; lo?: string; hi?: string; onLo: (v: string) => void; onHi: (v: string) => void }) {
  const s = filterSpec(f, mode);
  const unit = s.unit === "%" ? "%" : s.unit;
  const bad = over(s.max, lo);
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_96px_12px_96px] items-center gap-2">
        <span className="text-[13.5px]">{f.label}{unit ? <span className={`${toggles(f) ? "font-semibold text-ink-2" : "text-muted"}`}>, {unit}{s.max != null && s.unit !== "%" ? ` (0–${s.max})` : ""}</span> : null}<Hint text={f.desc} /></span>
        <input type="number" inputMode="decimal" min={0} max={s.max} className={`input !py-1 sm:!text-[13.5px] tabular-nums ${bad ? "!border-danger" : ""}`} placeholder={f.key === "volume" ? String(MIN_VOLUME) : "от"} value={lo ?? ""} onChange={(e) => onLo(e.target.value)} />
        <span className="text-center text-muted">–</span>
        <input type="number" inputMode="decimal" min={0} max={s.max} className="input !py-1 sm:!text-[13.5px] tabular-nums" placeholder={s.max != null ? String(s.max) : "до"} value={hi ?? ""} onChange={(e) => onHi(e.target.value)} />
      </div>
      {bad && <p className="mt-1 text-right text-[12px] text-danger">Бывает не больше {s.max}{s.unit === "%" ? "%" : ` ${s.unit}`} — с таким «от» не будет ни одного ключа</p>}
    </div>
  );
}

/** Параметры, которыми управляет панель (остальные — сортировка, страница, вкладка — не трогаем). */
const LIST_KEYS = ["verdict", "niche", "season", "status", "source", "acc", "prev", "flag", "noflag"] as const;
const OTHER_KEYS = ["q", "qx", "changed", "data", "fu"] as const;
export const FILTER_KEYS: string[] = [...LIST_KEYS, ...OTHER_KEYS, ...FIELDS.flatMap((f) => [`${f.key}_min`, `${f.key}_max`])];

/** «от» больше возможного максимума метрики (например, 50 ссылок из 10). */
const over = (max: number | undefined, v: string | undefined) => max != null && v != null && v !== "" && Number(v) > max;
const split = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);

function MultiChips({ value, options, onChange }: { value: string; options: Opt[]; onChange: (v: string) => void }) {
  const cur = split(value);
  const toggle = (k: string) => onChange((cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]).join(","));
  return <div className="flex flex-wrap gap-1.5">{options.map((o) => <Chip key={o.value} on={cur.includes(o.value)} onClick={() => toggle(o.value)}>{o.label}</Chip>)}</div>;
}

function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group border-b border-line py-3 last:border-0">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-bold uppercase tracking-wider text-muted">
        {title}<span className="text-[11px] transition group-open:rotate-180">▾</span>
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

/**
 * Панель всех фильтров (выезжает справа). Правки копятся в черновике и применяются кнопкой «Применить» —
 * страница не перерисовывается на каждую цифру.
 */
export function FilterPanel({ open, onClose, accounts }: { open: boolean; onClose: () => void; accounts: Opt[] }) {
  const { sp, replaceAll } = useQueryNav();
  const [d, setD] = useState<Draft>({});
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  // Фокус в поиск только на широком экране: на телефоне он сразу открывает клавиатуру на пол-экрана.
  useEffect(() => {
    if (open && window.matchMedia("(min-width: 640px)").matches) findRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const x: Draft = {};
    for (const k of FILTER_KEYS) { const v = sp.get(k); if (v != null) x[k] = v; }
    setD(x);
    setFind("");
  }, [open, sp]);
  const set = (k: string, v: string) => setD((p) => ({ ...p, [k]: v }));
  const mode: "pct" | "cnt" = d.fu === "cnt" ? "cnt" : "pct";
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  const apply = () => {
    const q = new URLSearchParams(sp.toString());
    for (const k of FILTER_KEYS) q.delete(k);
    for (const [k, v] of Object.entries(d)) if (v !== "" && v != null) q.set(k, v);
    q.delete("pg");
    replaceAll(q.toString());
    onClose();
  };
  const reset = () => setD({});
  const f = find.trim().toLowerCase();
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, fields: FIELDS.filter((x) => x.group === g.key && (!f || x.label.toLowerCase().includes(f) || x.desc.toLowerCase().includes(f))) })).filter((g) => g.fields.length), [f]);
  const flagState = (k: string) => (split(d.flag).includes(k) ? "in" : split(d.noflag).includes(k) ? "out" : "");
  const cycleFlag = (k: string) => {
    const st = flagState(k);
    const inn = split(d.flag).filter((x) => x !== k), out = split(d.noflag).filter((x) => x !== k);
    if (st === "") inn.push(k); else if (st === "in") out.push(k);
    setD((p) => ({ ...p, flag: inn.join(","), noflag: out.join(",") }));
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-[620px] flex-col bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 className="text-[17px] font-bold">Фильтры</h2>
          <input ref={findRef} className="input !py-1.5 sm:!text-[13.5px] flex-1 min-w-0" placeholder="Найти метрику: видео, возраст, блоги…" value={find} onChange={(e) => setFind(e.target.value)} />
          <button type="button" onClick={onClose} className="p-2 -m-2 text-[22px] leading-none text-muted hover:text-ink" aria-label="Закрыть">×</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5">
          <div className="sticky top-0 z-10 -mx-5 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-2.5">
            <span className="text-[13px] font-semibold">Значения в фильтрах:</span>
            <div className="inline-flex gap-1 rounded-xl bg-ink/5 p-1">
              {([["pct", "в процентах"], ["cnt", "в штуках"]] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => set("fu", k === "cnt" ? "cnt" : "")} className={`rounded-lg px-3 py-1 text-[13px] font-semibold transition ${mode === k ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{l}</button>
              ))}
            </div>
            <span className="help">{mode === "pct" ? "«Ссылок ≥ 50%» = 5+ ссылок из 10 мест топа." : "Точное количество: «Реклама ≥ 3 шт», «Видео ≤ 2 шт»."} Единица переключаемых метрик выделена.</span>
          </div>
          {!f && (
            <>
              <Section title="Ключ">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block"><span className="label">Содержит</span><input className="input !py-1.5" value={d.q ?? ""} onChange={(e) => set("q", e.target.value)} placeholder="nails" /></label>
                  <label className="block"><span className="label">Не содержит (через запятую)</span><input className="input !py-1.5" value={d.qx ?? ""} onChange={(e) => set("qx", e.target.value)} placeholder="men, kids, wedding" /></label>
                </div>
              </Section>
              <Section title="Вердикт, ниша, статус">
                <div><span className="label">Вердикт</span><MultiChips value={d.verdict ?? ""} onChange={(v) => set("verdict", v)} options={[...VERDICTS.map((v) => ({ value: v.key, label: v.label }))]} /></div>
                <div><span className="label">Ниша</span><MultiChips value={d.niche ?? ""} onChange={(v) => set("niche", v)} options={NICHES.map((n) => ({ value: n.key, label: n.label }))} /></div>
                <div><span className="label">Сезонность (если ничего не выбрано — все, кроме сезонных)</span><MultiChips value={d.season ?? ""} onChange={(v) => set("season", v)} options={SEASONS.map((s) => ({ value: s.key, label: s.label }))} /></div>
                <div><span className="label">Статус</span><MultiChips value={d.status ?? ""} onChange={(v) => set("status", v)} options={STATUSES.map((s) => ({ value: s.key, label: s.label }))} /></div>
                <div><span className="label">Источник</span><MultiChips value={d.source ?? ""} onChange={(v) => set("source", v)} options={SOURCES.map((s) => ({ value: s.key, label: s.label }))} /></div>
                {accounts.length > 0 && <div><span className="label">Выдача снята с аккаунта</span><MultiChips value={d.acc ?? ""} onChange={(v) => set("acc", v)} options={accounts} /></div>}
                <div>
                  <span className="label">Данные</span>
                  <MultiChips value={d.data ?? ""} onChange={(v) => set("data", split(v).pop() ?? "")} options={[{ value: "serp", label: "Выдача снята" }, { value: "noserp", label: "Выдача не снята" }, { value: "novol", label: "Нет частотности" }]} />
                </div>
              </Section>
              <Section title="Флаги">
                <p className="help">Нажимайте: первый раз — флаг должен быть, второй — исключить ключи с этим флагом, третий — неважно.</p>
                <div className="flex flex-wrap gap-1.5">
                  {FLAGS.map((x) => {
                    const st = flagState(x.key);
                    return <Chip key={x.key} on={st !== ""} tone={st === "out" ? "danger" : undefined} onClick={() => cycleFlag(x.key)}>{st === "out" ? "без: " : ""}{x.label}</Chip>;
                  })}
                </div>
              </Section>
              <Section title="Изменения с прошлого снимка" open={false}>
                <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={d.changed === "1"} onChange={(e) => set("changed", e.target.checked ? "1" : "")} /> Только ключи, у которых сменился вердикт</label>
                <div><span className="label">Прошлый вердикт</span><MultiChips value={d.prev ?? ""} onChange={(v) => set("prev", v)} options={VERDICTS.map((v) => ({ value: v.key, label: v.label }))} /></div>
              </Section>
            </>
          )}
          {groups.map((g) => (
            <Section key={g.key} title={g.label} open={!!f || g.key === "demand" || g.key === "serp" || g.key === "fresh"}>
              <div className="space-y-2">
                {g.fields.map((x) => (
                  <RangeRow key={x.key} f={x} mode={mode} lo={d[`${x.key}_min`]} hi={d[`${x.key}_max`]} onLo={(v) => set(`${x.key}_min`, v)} onHi={(v) => set(`${x.key}_max`, v)} />
                ))}
              </div>
            </Section>
          ))}
          {f && !groups.length && <p className="help py-6 text-center">Такой метрики нет.</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={reset} className="btn-ghost btn-sm">Очистить всё</button>
          <span className="help flex-1">Пустое поле — без ограничения. Частотность без «от» = от {MIN_VOLUME.toLocaleString("ru-RU")}; поставьте 0, чтобы видеть все.</span>
          <button type="button" onClick={apply} className="btn-brand btn-sm">Применить</button>
        </div>
      </div>
    </div>
  );
}
