"use client";
import { useState } from "react";
import { MAX_YEAR_RULES, type YearRules } from "@/lib/pins/types";
import { pinYearFor } from "@/lib/pins/prompts/elements";

type Row = { key: number; words: string[]; draft: string; year: string };

const splitWords = (s: string) => s.split(/[,;\n]/).map((w) => w.trim().toLocaleLowerCase()).filter(Boolean);

/**
 * «Другой год для отдельных тем»: пока галочка выключена — правил не видно (и они не действуют, но сохраняются).
 * Правило: слова (или части слов) плашками → год. Слово ищется в ключе статьи (и её заголовке), без учёта регистра;
 * первое совпавшее правило задаёт год для пинов статьи, иначе — основной год прогона.
 * Недобавленный текст в поле слова тоже уходит в правило — ничего не теряется при сохранении.
 */
export function YearRulesFields({ value, baseYear }: { value: YearRules; baseYear: string }) {
  const [on, setOn] = useState(value.enabled);
  const [rows, setRows] = useState<Row[]>(() => {
    const list = value.rules.map((r, i) => ({ key: i, words: r.words, draft: "", year: r.year }));
    return list.length ? list : [{ key: 0, words: [], draft: "", year: "" }];
  });
  const [next, setNext] = useState(rows.length);
  const [probe, setProbe] = useState("");
  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const commit = (r: Row) => {
    const add = splitWords(r.draft).filter((w) => !r.words.includes(w));
    patch(r.key, { words: [...r.words, ...add], draft: "" });
  };

  const live = { enabled: true, rules: rows.map((r) => ({ words: [...r.words, ...splitWords(r.draft)], year: r.year })) };
  const probeYear = probe.trim() ? pinYearFor({ year: baseYear, yearRules: live }, { keyword: probe }) : "";
  const probeRule = probe.trim() ? live.rules.find((r) => /^\d{4}$/.test(r.year) && r.words.some((w) => probe.toLocaleLowerCase().includes(w))) : undefined;
  const probeWord = probeRule?.words.find((w) => probe.toLocaleLowerCase().includes(w));

  return (
    <div className="px-3 py-2 space-y-2">
      <input type="hidden" name="yearRulesPresent" value="1" />
      <label className="inline-flex items-center gap-2 text-[13px] font-medium cursor-pointer">
        <input type="checkbox" name="yearRulesOn" checked={on} onChange={(e) => setOn(e.target.checked)} className="h-3.5 w-3.5" />
        Другой год для отдельных тем
        {!on && live.rules.some((r) => r.words.length && r.year) && <span className="help font-normal">· правила сохранены, но выключены</span>}
      </label>
      {/* Поля остаются в форме и при выключенной галочке — правила сохранятся до следующего включения. */}
      <div className={on ? "space-y-2 rounded-lg border border-line p-3" : "hidden"}>
        <p className="help">
          Если в ключе статьи (или её заголовке) встречается слово или <b>часть слова</b> из правила — у пинов этой статьи будет год правила.
          Регистр не важен: «christ» найдёт «Christmas nails», «рожд» — «Рождество». Остальные статьи — основной год {baseYear}.
        </p>
        {rows.map((r, idx) => (
          <div key={r.key} className="rounded-lg border border-line p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted">Правило {idx + 1}</span>
              <button type="button" className="btn-ghost btn-sm" title="Удалить правило" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [{ key: r.key, words: [], draft: "", year: "" }]))}>Удалить</button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px]">Если в ключе есть</span>
              {r.words.map((w) => (
                <span key={w} className="inline-flex items-center gap-1 rounded-full border border-brand bg-brand/10 px-2.5 py-0.5 text-[13px] text-ink">
                  {w}
                  <button type="button" className="text-muted hover:text-ink" title="Убрать слово" onClick={() => patch(r.key, { words: r.words.filter((x) => x !== w) })}>×</button>
                </span>
              ))}
              <input
                value={r.draft}
                onChange={(e) => patch(r.key, { draft: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(r); } }}
                onBlur={() => r.draft.trim() && commit(r)}
                className="input py-1 w-44"
                placeholder={r.words.length ? "ещё слово…" : "christmas или christ"}
              />
              {r.draft.trim() && <button type="button" className="btn-ghost btn-sm" onClick={() => commit(r)}>Добавить</button>}
              <span className="text-[13px]">→ год</span>
              <input
                name="yearRuleYear"
                value={r.year}
                onChange={(e) => patch(r.key, { year: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                inputMode="numeric"
                className={`input w-20 py-1 text-center ${r.words.length && !/^\d{4}$/.test(r.year) ? "border-amber-500" : ""}`}
                placeholder="2026"
              />
              <input type="hidden" name="yearRuleWords" value={[...r.words, ...splitWords(r.draft)].join(",")} />
            </div>
            {!r.words.length && !r.draft.trim() && <p className="help">Впишите слово и нажмите Enter (или запятую) — оно появится плашкой.</p>}
            {(r.words.length > 0 || r.draft.trim()) && !/^\d{4}$/.test(r.year) && <p className="help text-amber-600">Укажите год из 4 цифр, иначе правило не сохранится.</p>}
          </div>
        ))}
        {rows.length < MAX_YEAR_RULES && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => { setRows((rs) => [...rs, { key: next, words: [], draft: "", year: "" }]); setNext(next + 1); }}>+ Ещё правило</button>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="text-[13px]">Проверить ключ:</span>
          <input value={probe} onChange={(e) => setProbe(e.target.value)} className="input py-1 w-64" placeholder="christmas nail ideas" />
          {probeYear && (
            <span className="text-[13px]">
              → год <b>{probeYear}</b>{" "}
              <span className="help">{probeWord ? `(совпало «${probeWord}»)` : "(ни одно правило не совпало — основной год)"}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
