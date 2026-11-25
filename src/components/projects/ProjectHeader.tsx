import Link from "next/link";
import { Badge } from "@/components/ui";
import { AutoForm } from "./AutoForm";
import { setProjectOwner, setProjectStatus } from "@/actions/projects";
import { PROJECT_STATUSES, statusTone } from "@/lib/projects/steps";
import type { Alert } from "@/lib/projects/alerts";

/** Шапка карточки: статус и ответственный меняются одним кликом, стратегии, «что дальше», сигналы. */
export function ProjectHeader({ accessId, card, members, alerts }: {
  accessId: string;
  card: { status: string; ownerId: string | null; strategies: unknown; nextAction: string | null; nextDueAt: Date | null; niche: string | null; pinAccount: string | null; pinUrl: string | null; pinStatus: string | null };
  members: Array<{ id: string; name: string }>;
  alerts: Alert[];
}) {
  const strategies = (card.strategies as string[] | null) ?? [];
  const now = Date.now();
  return (
    <div className="card p-4 sm:p-5 mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <AutoForm action={setProjectStatus} hidden={{ accessId }} className="flex items-center gap-2">
          <span className="label !mb-0">Статус</span>
          <select name="status" defaultValue={card.status} className={`input py-1.5 pr-8 text-[13.5px] font-medium ${statusTone(card.status) === "ok" ? "text-ok" : statusTone(card.status) === "warn" ? "text-warn" : ""}`}>
            {PROJECT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </AutoForm>
        <AutoForm action={setProjectOwner} hidden={{ accessId }} className="flex items-center gap-2">
          <span className="label !mb-0">Ответственный</span>
          <select name="ownerId" defaultValue={card.ownerId ?? ""} className="input py-1.5 pr-8 text-[13.5px]">
            <option value="">— никто —</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </AutoForm>
        {card.niche && <Badge>{card.niche}</Badge>}
        {card.pinAccount && <span className="text-[13px] text-muted">Pinterest: {card.pinUrl ? <a href={card.pinUrl} target="_blank" rel="noreferrer" className="hover:underline">{card.pinAccount}</a> : card.pinAccount}{card.pinStatus && card.pinStatus !== "ok" && card.pinStatus !== "none" ? <Badge tone={card.pinStatus === "banned" ? "danger" : "warn"}>{card.pinStatus === "banned" ? "заблокирован" : "ограничен"}</Badge> : null}</span>}
        <div className="flex flex-wrap gap-1 ml-auto">{strategies.map((s) => <Badge key={s} tone="brand">{s}</Badge>)}</div>
      </div>
      {(card.nextAction || alerts.length > 0) && (
        <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2">
          {card.nextAction && <div className="text-[14px]"><span className="text-muted">Что дальше: </span><span className="font-medium">{card.nextAction}</span>{card.nextDueAt && <span className={`ml-2 text-[13px] ${card.nextDueAt.getTime() < now ? "text-danger" : "text-muted"}`}>до {card.nextDueAt.toLocaleDateString("ru-RU")}</span>}</div>}
          {alerts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {alerts.map((a) => {
                const cls = a.tone === "danger" ? "bg-danger-soft text-danger" : a.tone === "warn" ? "bg-warn-soft text-warn" : "bg-ink/5 text-ink-2";
                const href = a.href?.startsWith("?") ? `/pinterest/projects/${accessId}${a.href}` : a.href;
                return href ? <Link key={a.key} href={href} className={`badge ${cls} hover:opacity-80`}>{a.text}</Link> : <span key={a.key} className={`badge ${cls}`}>{a.text}</span>;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
