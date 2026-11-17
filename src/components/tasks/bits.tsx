import Link from "next/link";
import type { ReactNode } from "react";
import { fmtDay, MODES, PRIORITIES, STATUSES, todayYmd } from "@/lib/tasks/consts";
import type { TaskRow } from "@/lib/tasks/queries";

/** Мелкие элементы задач: приоритет, способ, статус, метка, карточка. Серверные (без хуков). */

export function Pri({ n, withLabel = false }: { n: number; withLabel?: boolean }) {
  const p = PRIORITIES.find((x) => x.n === n) ?? PRIORITIES[2];
  if (!p.icon && !withLabel) return null;
  return <span className={`inline-flex items-center gap-1 text-[12px] font-bold ${p.cls}`} title={p.label}>{p.icon}{withLabel && <span className="font-medium">{p.label}</span>}</span>;
}

const MODE_CLS: Record<string, string> = { do: "bg-ink/5 text-ink-2", delegate: "bg-brand-soft text-warn", ask: "bg-info-soft text-info" };
export function ModeBadge({ mode, counterpart, compact = false }: { mode: string; counterpart?: string | null; compact?: boolean }) {
  if (mode === "do" && !counterpart) return null;
  const m = MODES.find((x) => x.key === mode) ?? MODES[0];
  return <span className={`badge ${MODE_CLS[mode] ?? MODE_CLS.do}`} title={m.hint}>{m.icon} {compact ? m.short : m.label}{counterpart ? ` · ${counterpart}` : ""}</span>;
}

const STATUS_CLS: Record<string, string> = { idea: "bg-[#a855f7]/15 text-[#a855f7]", backlog: "bg-ink/5 text-ink-2", planned: "bg-brand-soft text-warn", doing: "bg-ok-soft text-ok", waiting: "bg-warn-soft text-warn", done: "bg-ok text-white", cancelled: "bg-ink/5 text-muted line-through" };
export function StatusBadge({ status }: { status: string }) {
  const s = STATUSES.find((x) => x.key === status);
  return <span className={`badge ${STATUS_CLS[status] ?? STATUS_CLS.backlog}`}>{s?.label ?? status}</span>;
}

export function LabelChip({ name, color, small = false }: { name: string; color: string; small?: boolean }) {
  return <span className={`inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap ${small ? "px-1.5 py-px text-[10.5px]" : "px-2 py-0.5 text-[12px]"}`} style={{ background: `${color}22`, color }}><span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />{name}</span>;
}

export function ProjectDot({ name, color, href }: { name: string | null; color: string | null; href?: string }) {
  if (!name) return null;
  const inner = <><span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ background: color ?? "#94a3b8" }} /><span className="truncate">{name}</span></>;
  return href ? <Link href={href} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink min-w-0">{inner}</Link> : <span className="inline-flex items-center gap-1.5 text-[12px] text-muted min-w-0">{inner}</span>;
}

export function DayChip({ ymd, kind }: { ymd: string | null; kind: "plan" | "due" | "wait" }) {
  if (!ymd) return null;
  const today = todayYmd();
  const late = ymd < today;
  const cls = late ? "text-danger font-semibold" : ymd === today ? "text-warn font-semibold" : "text-muted";
  const icon = kind === "plan" ? "📅" : kind === "due" ? "⏰" : "⏳";
  const title = kind === "plan" ? "План на день" : kind === "due" ? "Дедлайн" : "Ждём ответа до";
  return <span className={`inline-flex items-center gap-1 text-[12px] whitespace-nowrap ${cls}`} title={title}>{icon} {fmtDay(ymd)}</span>;
}

export function Avatar({ name, size = 22 }: { name: string | null; size?: number }) {
  if (!name) return null;
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="inline-flex items-center justify-center rounded-full text-white font-bold shrink-0" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${h} 55% 45%)` }} title={name}>{initials}</span>;
}

/** Карточка задачи для канбана и списков. */
export function TaskCard({ t, compact = false, extra }: { t: TaskRow; compact?: boolean; extra?: ReactNode }) {
  const doneCls = t.status === "done" || t.status === "cancelled" ? "opacity-60" : "";
  return (
    <div className={`card card-hover p-3 ${doneCls}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/tasks/t/${t.id}`} className={`block text-[14px] font-medium leading-snug hover:underline [overflow-wrap:anywhere] ${t.status === "done" ? "line-through text-muted" : ""}`}><Pri n={t.priority} /> {t.title}</Link>
          {!compact && t.description && <p className="help mt-1 line-clamp-2">{t.description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ModeBadge mode={t.mode} counterpart={t.counterpart} compact />
            <ProjectDot name={t.project} color={t.projectColor} href={t.projectId ? `/tasks/projects/${t.projectId}` : undefined} />
            <DayChip ymd={t.planDate} kind="plan" />
            <DayChip ymd={t.dueAt} kind="due" />
            {t.mode !== "do" && <DayChip ymd={t.waitUntil} kind="wait" />}
            {t.checks.total > 0 && <span className="text-[12px] text-muted">☑ {t.checks.done}/{t.checks.total}</span>}
            {t.children > 0 && <span className="text-[12px] text-muted" title="Подзадачи">⌲ {t.children}</span>}
            {t.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} small />)}
          </div>
        </div>
        <Avatar name={t.assignee} />
      </div>
      {extra}
    </div>
  );
}

/** Строка задачи для плотных списков (экран дня, проект). */
export function TaskLine({ t, extra }: { t: TaskRow; extra?: ReactNode }) {
  return (
    <div className={`flex items-center gap-2.5 py-2 border-b border-line/70 last:border-b-0 ${t.status === "done" ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <Link href={`/tasks/t/${t.id}`} className={`text-[14px] font-medium hover:underline [overflow-wrap:anywhere] ${t.status === "done" ? "line-through text-muted" : ""}`}><Pri n={t.priority} /> {t.title}</Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <StatusBadge status={t.status} />
          <ModeBadge mode={t.mode} counterpart={t.counterpart} compact />
          <ProjectDot name={t.project} color={t.projectColor} href={t.projectId ? `/tasks/projects/${t.projectId}` : undefined} />
          <DayChip ymd={t.dueAt} kind="due" />
          {t.mode !== "do" && <DayChip ymd={t.waitUntil} kind="wait" />}
          {t.checks.total > 0 && <span className="text-[12px] text-muted">☑ {t.checks.done}/{t.checks.total}</span>}
          {t.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} small />)}
        </div>
      </div>
      <Avatar name={t.assignee} size={24} />
      {extra}
    </div>
  );
}
