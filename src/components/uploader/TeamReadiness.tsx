import Link from "next/link";
import type { ReactNode } from "react";
import type { TeamReadiness } from "@/lib/uploader/teams";
import { Card } from "@/components/ui";
import { dt } from "./ui";

/**
 * Готовность команд к заливке: цепочка «токен Dolphin команды → агент команды → профили → сопоставление».
 * Первое звено с ✗ — то, что надо сделать (ссылка ведёт туда, где это делается).
 */
export function TeamReadinessCard({ rows, title = "Готовность команд" }: { rows: TeamReadiness[]; title?: string }) {
  if (!rows.length) return null;
  return (
    <Card title={title} description="У каждой команды свой аккаунт Dolphin: свой токен, свой агент, свои профили и сайты. Первое ✗ — что сделать сейчас.">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map((r) => <TeamBox key={r.teamId} r={r} />)}</div>
    </Card>
  );
}

function TeamBox({ r }: { r: TeamReadiness }) {
  const online = r.agents.filter((a) => a.online);
  const wrong = r.agents.find((a) => a.state && /другой аккаунт/i.test(a.state));
  const steps: Array<{ ok: boolean; label: ReactNode; fix?: ReactNode }> = [
    { ok: !!r.token, label: r.token ? <>Токен Dolphin команды: {r.token}</> : "Токен Dolphin команды не задан",
      fix: <>лид или админ: <Link href="/pinterest/uploader/settings" className="underline">Настройки</Link> → токен для «{r.teamName}»</> },
    { ok: online.length > 0,
      label: r.agents.length ? <>Агенты команды: {r.agents.map((a) => `${a.name}${a.online ? "" : " (не на связи)"}`).join(", ")}</> : "Нет агента этой команды",
      fix: r.agents.length ? "запустите ZewexUploader.cmd на ПК" : <><Link href="/pinterest/uploader/agents" className="underline">Агенты</Link> → добавьте агента с командой «{r.teamName}»</> },
    { ok: r.profiles > 0 && !wrong,
      label: wrong ? <>Dolphin на ПК агента «{wrong.name}» вошёл в чужой аккаунт</> : r.profiles ? <>Профилей Dolphin: {r.profiles} (обновлено {dt(r.profilesAt)})</> : "Профили Dolphin не получены",
      fix: wrong ? "в Dolphin выйдите и войдите в аккаунт этой команды" : "в Dolphin на ПК должен быть открыт аккаунт этой команды; агент присылает список при запуске и раз в час" },
    { ok: r.sites > 0 && r.mapped === r.sites, label: <>Сайтов сопоставлено: {r.mapped} из {r.sites}</>,
      fix: <Link href="/pinterest/uploader/mapping" className="underline">Сопоставление</Link> },
  ];
  const firstBad = steps.findIndex((s) => !s.ok);
  return (
    <div className={`rounded-lg border p-3 ${firstBad === -1 ? "border-ok/40 bg-ok-soft/40" : "border-warn/40 bg-warn-soft/40"}`}>
      <div className="mb-1 font-semibold">{r.teamName}{firstBad === -1 ? <span className="ml-2 text-[12.5px] text-ok">готова</span> : null}</div>
      <ul className="space-y-1 text-[13px]">{steps.map((s, i) => (
        <li key={i} className={i > firstBad && firstBad !== -1 ? "opacity-60" : ""}>
          <span className={s.ok ? "text-ok" : "text-danger"}>{s.ok ? "✓" : "✗"}</span> {s.label}
          {!s.ok && i === firstBad && s.fix ? <div className="ml-4 help">→ {s.fix}</div> : null}
        </li>
      ))}</ul>
    </div>
  );
}
