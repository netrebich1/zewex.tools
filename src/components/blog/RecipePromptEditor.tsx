"use client";
import { useMemo, useRef, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { saveBlogPrompt, setBlogStageModel } from "@/actions/blogRecipes";

type Props = { recipeId: string; stageKey: string; label: string; required: boolean; system: string; text: string; model: string; vars: string[]; hints: Record<string, string>; popularModels: string[]; builtIn?: string };

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}|(?<![{\w])\{\s*([A-Za-z0-9_]+)\s*\}(?![}\w])/g;
const usedVars = (t: string) => [...new Set([...t.matchAll(VAR_RE)].map((m) => (m[1] ?? m[2])!))];

/** Редактор промта шага сценария: модель шага, system и text, чипы переменных (вставка в курсор), версия при сохранении. */
export function RecipePromptEditor({ recipeId, stageKey, label, required, system: s0, text: t0, model, vars, hints, popularModels, builtIn }: Props) {
  const [text, setText] = useState(t0);
  const [system, setSystem] = useState(s0);
  const [dirty, setDirty] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const sysRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"text" | "system">("text");
  const used = useMemo(() => new Set([...usedVars(text), ...usedVars(system)]), [text, system]);
  const unknown = useMemo(() => [...used].filter((v) => !vars.includes(v)), [used, vars]);
  const insert = (name: string) => {
    const ta = lastFocus.current === "system" ? sysRef.current : textRef.current;
    const token = `{{${name}}}`;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const next = ta.value.slice(0, start) + token + ta.value.slice(end);
    if (lastFocus.current === "system") setSystem(next); else setText(next);
    setDirty(true);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="h2">{label}</h3>
        <span className="mono text-muted">{stageKey}</span>
        <span className={`badge ${required ? "bg-warn-soft text-warn" : "bg-ink/5 text-ink-2"}`}>{required ? "обязательный" : "необязательный: пусто — встроенный промт"}</span>
      </div>
      <ActionForm action={setBlogStageModel} hidden={{ recipeId, stageKey }} className="card p-3 space-y-2">
        <label className="block">
          <span className="label">Модель шага (provider:model)</span>
          <input name="model" className="input mono" defaultValue={model} placeholder="пусто — модель правила ключа" list={`models-${stageKey}`} />
          <datalist id={`models-${stageKey}`}>{popularModels.map((m) => <option key={m} value={m} />)}</datalist>
          <span className="help mt-1 block">Провайдер должен совпадать с ключом слота, иначе возьмётся модель правила.</span>
        </label>
        <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить модель</SubmitButton>
      </ActionForm>
      <ActionForm action={saveBlogPrompt} hidden={{ recipeId, stageKey }} className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="help mr-1">Переменные шага (клик — вставить):</span>
          {vars.map((v) => <button key={v} type="button" className={`badge ${used.has(v) ? "bg-ok-soft text-ok" : "bg-ink/5 text-ink-2 hover:bg-ink/10"}`} onClick={() => insert(v)} title={hints[v] ?? v}>{`{{${v}}}`}</button>)}
          {unknown.length > 0 && <span className="badge bg-danger-soft text-danger" title="Код их не подставляет — этап упадёт с ошибкой">неизвестные: {unknown.join(", ")}</span>}
        </div>
        <label className="block"><span className="label">Постоянный блок (system)</span>
          <textarea ref={sysRef} name="system" className="input mono min-h-40" value={system} onChange={(e) => { setSystem(e.target.value); setDirty(true); }} onFocus={() => (lastFocus.current = "system")} placeholder="Персона, правила, формат ответа" />
        </label>
        <label className="block"><span className="label">Текст запроса (text)</span>
          <textarea ref={textRef} name="text" className="input mono min-h-[360px]" value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} onFocus={() => (lastFocus.current = "text")} placeholder={builtIn ? "Пусто — используется встроенный промт (ниже)" : "Текст промта. Переменные — {{name}}."} />
        </label>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block"><span className="label">Что изменили (в историю версий)</span><input name="changeSummary" className="input" placeholder="например: добавил правило про таблицы" /></label>
          <SubmitButton className={dirty ? "btn-brand" : "btn-primary"} pendingText="Сохраняю…">Сохранить версию</SubmitButton>
        </div>
        <p className="help">{text.length.toLocaleString("ru-RU")} символов{system ? ` + system ${system.length.toLocaleString("ru-RU")}` : ""}.</p>
      </ActionForm>
      {builtIn && !text.trim() && (
        <details className="card p-3"><summary className="help cursor-pointer">Встроенный промт этого шага (используется, пока поле пустое)</summary><pre className="mono mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[11.5px]">{builtIn}</pre></details>
      )}
    </div>
  );
}
