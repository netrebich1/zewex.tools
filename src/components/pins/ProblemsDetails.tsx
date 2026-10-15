import { healthOf, verdict, type Problem } from "@/lib/pins/runs/problems";

/**
 * Проблемы прогона одной раскрывающейся плашкой: жёлтая — не критично, можно работать; красная — прогон стоит.
 * По клику — тезисно: что случилось, что это значит, что сделать. Без состояния: работает и на сервере, и в клиенте.
 */
export function ProblemsDetails({ problems, runStatus, open = false }: { problems: Problem[]; runStatus: string; open?: boolean }) {
  if (!problems.length) return null;
  const health = healthOf(problems);
  const crit = problems.filter((p) => p.severity === "critical").length;
  const warn = problems.length - crit;
  const tone = health === "critical" ? "border-danger/40 bg-danger/10 text-danger" : "border-warn/40 bg-warn-soft text-warn";
  const label = health === "critical" ? `Критично: ${crit}${warn ? ` · предупреждений: ${warn}` : ""}` : `Предупреждений: ${warn} · можно работать`;
  return (
    <details open={open} className="group w-full">
      <summary className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${tone}`}>
        <span>{health === "critical" ? "⛔" : "⚠"}</span>{label}<span className="opacity-70 group-open:hidden">· показать</span><span className="hidden opacity-70 group-open:inline">· скрыть</span>
      </summary>
      <div className="mt-2 space-y-2 rounded-xl border border-line p-3 text-[13px]">
        <p className={health === "critical" ? "font-medium text-danger" : "font-medium text-warn"}>{verdict(health, runStatus, problems)}</p>
        <ul className="space-y-2">
          {problems.map((p, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${p.severity === "critical" ? "bg-danger" : "bg-warn"}`} />
              <div className="min-w-0 space-y-0.5">
                <div className="font-medium text-ink">{p.title}</div>
                <div className="text-ink-2">{p.meaning}</div>
                <div className="text-ink-2"><b>Что делать:</b> {p.action}</div>
                {p.raw && <div className="truncate text-[11.5px] text-muted" title={p.raw}>Ответ провайдера: {p.raw}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
