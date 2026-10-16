"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createPromptVariant, savePrompt, setStageModel, setStagePrompt } from "@/actions/articlesRecipes";

/**
 * Редактор промта шага рецепта: варианты набора, активный вариант рецепта, модель шага, system и text,
 * чипы переменных (вставка в курсор), сохранение с записью версии.
 * Оригинал: src/pages/PromptManager.tsx (панель «Редактор») + вкладка «Промты и модели» ScenariosPage.
 */

export type PromptVariant = { id: string; name: string; isActive: boolean; updatedAt: string; versions: number };
export type PromptData = { id: string; name: string; system: string; text: string; isActive: boolean };

type Props = {
  recipeId: string;
  setId: string | null;
  stageKey: string;
  label: string;
  required: boolean;
  variants: PromptVariant[];
  /** Какой вариант открыт в редакторе */
  prompt: PromptData | null;
  /** Какой вариант выбран в рецепте (stagePromptIds) — пусто = первый по дате */
  chosenId: string;
  model: string;
  vars: string[];
  hints: Record<string, string>;
  popularModels: string[];
};

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}|(?<![{\w])\{\s*([A-Za-z0-9_]+)\s*\}(?![}\w])/g;
const usedVars = (t: string) => [...new Set([...t.matchAll(VAR_RE)].map((m) => (m[1] ?? m[2])!))];

export function PromptEditor({ recipeId, setId, stageKey, label, required, variants, prompt, chosenId, model, vars, hints, popularModels }: Props) {
  const [text, setText] = useState(prompt?.text ?? "");
  const [system, setSystem] = useState(prompt?.system ?? "");
  const [showSystem, setShowSystem] = useState(!!prompt?.system);
  const [dirty, setDirty] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const sysRef = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef<"text" | "system">("text");

  const used = useMemo(() => new Set([...usedVars(text), ...usedVars(system)]), [text, system]);
  const unknown = useMemo(() => [...used].filter((v) => !vars.includes(v)), [used, vars]);
  const base = `/pinterest/articles/recipes/${recipeId}?tab=prompts&stage=${encodeURIComponent(stageKey)}`;

  const insert = (name: string) => {
    const ta = lastFocus.current === "system" ? sysRef.current : textRef.current;
    const token = `{{${name}}}`;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const next = ta.value.slice(0, start) + token + ta.value.slice(end);
    if (lastFocus.current === "system") setSystem(next);
    else setText(next);
    setDirty(true);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + token.length, start + token.length);
    });
  };

  if (!setId) {
    return <p className="help">У рецепта не выбран набор промтов. Выберите его на вкладке «Основное» — тогда здесь появятся варианты промтов шага.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="h2">{label}</h3>
        <span className="mono text-muted">{stageKey}</span>
        <span className={`badge ${required ? "bg-warn-soft text-warn" : "bg-ink/5 text-ink-2"}`}>{required ? "обязательный" : "необязательный"}</span>
      </div>

      {/* Варианты */}
      <div className="flex flex-wrap items-center gap-1.5">
        {variants.map((v) => (
          <Link key={v.id} href={`${base}&prompt=${v.id}`} className={`tab ${prompt?.id === v.id ? "active" : ""}`} title={`${v.versions} версий · ${v.isActive ? "активен" : "выключен"}`}>
            {v.name}
            {chosenId === v.id && <span title="Выбран в рецепте">★</span>}
            {!v.isActive && <span className="text-muted">·выкл</span>}
          </Link>
        ))}
        <ActionForm action={createPromptVariant} hidden={{ recipeId, setId, stageKey, fromId: prompt?.id ?? "" }} className="inline">
          <SubmitButton className="btn-ghost btn-sm" pendingText="…">{prompt ? "+ Вариант (копия)" : "+ Вариант"}</SubmitButton>
        </ActionForm>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ActionForm action={setStagePrompt} hidden={{ recipeId, stageKey }} className="card p-3 space-y-2">
          <label className="block">
            <span className="label">Активный вариант в рецепте</span>
            <select name="promptId" className="input" defaultValue={chosenId}>
              <option value="">Первый вариант набора (по дате)</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id} disabled={!v.isActive}>{v.name}{v.isActive ? "" : " (выкл)"}</option>
              ))}
            </select>
          </label>
          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Выбрать</SubmitButton>
        </ActionForm>
        <ActionForm action={setStageModel} hidden={{ recipeId, stageKey }} className="card p-3 space-y-2">
          <label className="block">
            <span className="label">Модель шага (provider:model)</span>
            <input name="model" className="input mono" defaultValue={model} placeholder="пусто — модель правила ключа" list={`models-${stageKey}`} />
            <datalist id={`models-${stageKey}`}>
              {popularModels.map((m) => <option key={m} value={m} />)}
            </datalist>
            <span className="help mt-1 block">Провайдер должен совпадать с ключом слота, иначе возьмётся модель правила (с предупреждением в журнале).</span>
          </label>
          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить модель</SubmitButton>
        </ActionForm>
      </div>

      {!prompt ? (
        <p className="help">{variants.length ? "Выберите вариант выше." : "Вариантов промта для этого шага в наборе нет — создайте первый."}</p>
      ) : (
        <ActionForm key={prompt.id} action={savePrompt} hidden={{ recipeId, promptId: prompt.id, isActivePresent: "1" }} className="card p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block">
              <span className="label">Название варианта</span>
              <input name="name" className="input" defaultValue={prompt.name} onChange={() => setDirty(true)} />
            </label>
            <label className="inline-flex items-center gap-2 text-[14px] pb-2">
              <input type="checkbox" name="isActive" defaultChecked={prompt.isActive} onChange={() => setDirty(true)} /> вариант активен
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="help mr-1">Переменные шага (клик — вставить):</span>
            {vars.map((v) => (
              <button key={v} type="button" className={`badge ${used.has(v) ? "bg-ok-soft text-ok" : "bg-ink/5 text-ink-2 hover:bg-ink/10"}`} onClick={() => insert(v)} title={hints[v] ?? v}>
                {`{{${v}}}`}
              </button>
            ))}
            {unknown.length > 0 && (
              <span className="badge bg-danger-soft text-danger" title="Код их не подставляет — этап упадёт с ошибкой «не подставлены переменные»">
                неизвестные: {unknown.join(", ")}
              </span>
            )}
          </div>

          <label className="inline-flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={showSystem} onChange={(e) => { setShowSystem(e.target.checked); if (!e.target.checked) { setSystem(""); setDirty(true); } }} /> отдельный постоянный блок (system)
          </label>
          {showSystem ? (
            <textarea ref={sysRef} name="system" className="input mono min-h-40" value={system} onChange={(e) => { setSystem(e.target.value); setDirty(true); }} onFocus={() => (lastFocus.current = "system")} placeholder="System-инструкция (персона, правила)" />
          ) : (
            <input type="hidden" name="system" value="" />
          )}
          <textarea ref={textRef} name="text" className="input mono min-h-[420px]" value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} onFocus={() => (lastFocus.current = "text")} placeholder="Текст промта. Переменные — {{name}}." />
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block">
              <span className="label">Что изменили (попадёт в историю версий)</span>
              <input name="changeSummary" className="input" placeholder="например: убрал раздел KEYWORDS, добавил правило про бренды" />
            </label>
            <SubmitButton className={dirty ? "btn-brand" : "btn-primary"} pendingText="Сохраняю…">Сохранить версию</SubmitButton>
          </div>
          <p className="help">{text.length.toLocaleString("ru-RU")} символов{system ? ` + system ${system.length.toLocaleString("ru-RU")}` : ""}. Каждое сохранение — новая версия на вкладке «История».</p>
        </ActionForm>
      )}
    </div>
  );
}
