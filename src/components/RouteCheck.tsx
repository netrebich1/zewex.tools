"use client";
import { useState } from "react";
import { Badge } from "@/components/ui";
import { SCOPE_LABELS } from "@/lib/utils";

type Result = {
  binding: null | { scope: string; provider: { name: string }; model: { modelId: string } | null; apiKey: { label: string; secretHint: string } };
  steps: { scope: string; label: string; matched: boolean; note?: string }[];
  warnings: string[];
  slot: { name: string };
};

export function RouteCheck({ slots, users, meId }: { slots: { id: string; name: string }[]; users: { id: string; name: string }[]; meId: string }) {
  const [slotId, setSlotId] = useState(slots[0]?.id ?? "");
  const [userId, setUserId] = useState(meId);
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/check-route?slotId=${encodeURIComponent(slotId)}&userId=${encodeURIComponent(userId)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Ошибка");
      setRes(j);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <select className="input" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
          {slots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button className="btn-brand" onClick={run} disabled={loading || !slotId}>{loading ? "Проверяю…" : "Какой ключ применится?"}</button>
      </div>
      {err && <p className="text-danger text-[14px]">{err}</p>}
      {res && (
        <div className="rounded-xl border border-line p-4 space-y-3">
          {res.binding ? (
            <div className="flex flex-wrap items-center gap-2 text-[14px]">
              <Badge tone="ok">Найдено</Badge>
              <span><b>{res.binding.provider.name}</b>{res.binding.model ? ` · ${res.binding.model.modelId}` : ""} · ключ «{res.binding.apiKey.label}» {res.binding.apiKey.secretHint}</span>
              <Badge tone="brand">{SCOPE_LABELS[res.binding.scope]}</Badge>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[14px]"><Badge tone="danger">Правило не найдено</Badge> Инструмент получит ошибку при вызове этого слота.</div>
          )}
          <ol className="space-y-1 text-[13px]">
            {res.steps.map((s, i) => (
              <li key={i} className={`flex items-center gap-2 ${s.matched ? "text-ok font-medium" : "text-muted"}`}>
                <span className="w-4 text-center">{s.matched ? "●" : "○"}</span>{s.label}{s.note ? ` (${s.note})` : ""}
              </li>
            ))}
          </ol>
          {res.warnings.map((w, i) => <p key={i} className="text-warn text-[13px]">⚠ {w}</p>)}
        </div>
      )}
    </div>
  );
}
