"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptAllSureAction, acceptSuggestionAction } from "@/actions/uploader";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return { pending, msg, run: (fn: () => Promise<{ error?: string; ok?: string }>) => start(async () => { const r = await fn(); setMsg(r.error ?? r.ok ?? null); router.refresh(); }) };
}

/** «Принять» одно предложение автосопоставления. */
export function AcceptSuggestion({ pinSiteId, profileId, profileName, sure }: { pinSiteId: string; profileId: string; profileName: string; sure: boolean }) {
  const { pending, msg, run } = useRun();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[12.5px]">
      <span className={sure ? "text-ok" : "text-warn"} title={sure ? "Однозначная пара: домен сайта найден в этом профиле, и только в нём" : "Похоже, но не однозначно — проверьте"}>{sure ? "✓" : "?"} {profileName}</span>
      <button type="button" disabled={pending} className="btn-ghost btn-sm" onClick={() => run(() => acceptSuggestionAction(pinSiteId, profileId))}>{pending ? "…" : "Принять"}</button>
      {msg && <span className="help">{msg}</span>}
    </span>
  );
}

/** «Принять все однозначные» — верх страницы сопоставления. */
export function AcceptAllSure({ count }: { count: number }) {
  const { pending, msg, run } = useRun();
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={pending} className="btn-brand btn-sm" onClick={() => run(() => acceptAllSureAction())}>{pending ? "…" : `Принять все однозначные (${count})`}</button>
      {msg && <span className="help">{msg}</span>}
    </span>
  );
}
