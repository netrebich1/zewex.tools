"use client";
import { useState } from "react";
import { Alert, Badge, Card } from "@/components/ui";
import { countryByCode } from "@/lib/domains/countries";
import { parseList } from "@/lib/domains/generator";
import { defaultCountryPreset } from "@/lib/domains/presets";
import type { CountryPreset } from "@/lib/domains/types";

/** Набор страны в форме: редактируются только доп. зоны, гео-приставки — из встроенной базы. */
export type PresetDraft = { tlds: string };

export const draftFromPreset = (p: CountryPreset): PresetDraft => ({ tlds: p.tlds.join(", ") });

export const presetFromDraft = (code: string, d: PresetDraft): CountryPreset => defaultCountryPreset(code, parseList(d.tlds));

const TIER_NAMES = ["Уровень 1", "Уровень 2", "Уровень 3"];

/**
 * Наборы стран пачки: гео-приставки по уровням из встроенной базы (только просмотр) и доп. зоны страны.
 * «Сохранить зоны» — доп. зоны будут подставляться при каждом выборе этой страны (для всех сотрудников).
 */
export function CountryPresetsPanel({
  countries,
  drafts,
  saved,
  onChange,
  onSaved,
}: {
  countries: string[];
  drafts: Record<string, PresetDraft>;
  saved: Set<string>;
  onChange: (code: string, draft: PresetDraft) => void;
  onSaved: (code: string, preset: CountryPreset, isSaved: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  async function save(code: string) {
    setBusy(code);
    setMsg(null);
    try {
      const res = await fetch("/api/domains/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ country: code, preset: presetFromDraft(code, drafts[code]!) }) });
      const body = (await res.json()) as { preset?: CountryPreset; error?: string };
      if (!res.ok || !body.preset) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSaved(code, body.preset, true);
      setMsg({ tone: "ok", text: `Зоны ${code.toUpperCase()} сохранены — они будут подставляться при выборе этой страны.` });
    } catch (e) {
      setMsg({ tone: "danger", text: `Не сохранилось: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function reset(code: string) {
    setBusy(code);
    setMsg(null);
    try {
      const res = await fetch(`/api/domains/presets?country=${encodeURIComponent(code)}`, { method: "DELETE" });
      const body = (await res.json()) as { preset?: CountryPreset; error?: string };
      if (!res.ok || !body.preset) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSaved(code, body.preset, false);
    } catch (e) {
      setMsg({ tone: "danger", text: `Не сбросилось: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
    }
  }

  if (!countries.length) return null;
  return (
    <Card title="2. Наборы стран" description="Гео-приставки каждой страны берутся из встроенной базы: код (nl), местное и английское название (nederland, netherlands), трёхбуквенный код (nld) и распространённые варианты (holland, dutch). Они идут в уровни каждого бренда этой страны вместе с общими приставками.">
      <div className="space-y-3">
        {countries.map((code) => {
          const d = drafts[code];
          if (!d) return null;
          const c = countryByCode(code);
          const geo = defaultCountryPreset(code).tiers;
          return (
            <div key={code} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <b className="text-[14.5px]">{c?.name ?? code.toUpperCase()}</b>
                <span className="help uppercase">{code}</span>
                {saved.has(code) && <Badge tone="ok">сохранённые зоны</Badge>}
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_200px]">
                {geo.map((list, i) => (
                  <div key={i} className="min-w-0">
                    <span className="label">{TIER_NAMES[i]}</span>
                    <div className="break-words font-mono text-[13px] leading-6">{list.join(", ") || "—"}</div>
                  </div>
                ))}
                <div>
                  <label className="block">
                    <span className="label">Доп. зоны страны</span>
                    <input className="input font-mono text-[13px]" value={d.tlds} onChange={(e) => onChange(code, { tlds: e.target.value })} placeholder={code} />
                  </label>
                  <div className="mt-1.5 flex gap-1.5">
                    <button type="button" className="btn-ghost btn-sm" disabled={busy === code} onClick={() => save(code)}>{busy === code ? "…" : "Сохранить зоны"}</button>
                    {saved.has(code) && <button type="button" className="btn-ghost btn-sm" disabled={busy === code} onClick={() => reset(code)}>Сбросить</button>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Card>
  );
}
