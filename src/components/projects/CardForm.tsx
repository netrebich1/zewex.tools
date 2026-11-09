import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field } from "@/components/ui";
import { saveProjectCard } from "@/actions/projects";
import { PIN_ACCOUNT_STATUSES } from "@/lib/projects/steps";

const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : "");

/** Ручные поля карточки одной формой: что дальше, стратегии, ниша, описание, Pinterest-аккаунт. */
export function CardForm({ accessId, card, strategyHints }: {
  accessId: string;
  card: { niche: string | null; nextAction: string | null; nextDueAt: Date | null; strategies: unknown; summary: string | null; pinAccount: string | null; pinUrl: string | null; pinStartedAt: Date | null; pinStatus: string | null; pinNotes: string | null; priority: number };
  strategyHints: string[];
}) {
  return (
    <ActionForm action={saveProjectCard} hidden={{ accessId }} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
        <Field label="Что дальше"><input name="nextAction" className="input" defaultValue={card.nextAction ?? ""} placeholder="Следующий шаг по проекту одной строкой" /></Field>
        <Field label="Срок"><input type="date" name="nextDueAt" className="input" defaultValue={d(card.nextDueAt)} /></Field>
      </div>
      <Field label="Стратегии" hint={strategyHints.length ? `Уже используются: ${strategyHints.join(", ")}` : "Через запятую: например «пины 2/день», «кластеры 2027», «видео-статьи»"}>
        <input name="strategies" className="input" defaultValue={((card.strategies as string[] | null) ?? []).join(", ")} list={`strategies-${accessId}`} />
        <datalist id={`strategies-${accessId}`}>{strategyHints.map((s) => <option key={s} value={s} />)}</datalist>
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Ниша"><input name="niche" className="input" defaultValue={card.niche ?? ""} placeholder="женское, кулинария, декор…" /></Field>
        <Field label="Приоритет" hint="0 — обычный, выше — важнее"><input type="number" name="priority" className="input" defaultValue={card.priority} /></Field>
      </div>
      <Field label="О проекте"><textarea name="summary" className="input min-h-[70px]" defaultValue={card.summary ?? ""} placeholder="Коротко: что за сайт, на что ставка, особенности" /></Field>
      <div className="rounded-xl border border-line p-3">
        <div className="label">Pinterest-аккаунт</div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_150px_150px]">
          <input name="pinAccount" className="input" defaultValue={card.pinAccount ?? ""} placeholder="Имя / логин" />
          <input name="pinUrl" className="input" defaultValue={card.pinUrl ?? ""} placeholder="https://pinterest.com/…" />
          <input type="date" name="pinStartedAt" className="input" defaultValue={d(card.pinStartedAt)} title="Дата старта аккаунта" />
          <select name="pinStatus" className="input" defaultValue={card.pinStatus ?? ""}><option value="">— состояние —</option>{PIN_ACCOUNT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        </div>
        <textarea name="pinNotes" className="input mt-2 min-h-[50px]" defaultValue={card.pinNotes ?? ""} placeholder="Заметки по аккаунту: доски, лимиты, что было" />
      </div>
      <SubmitButton pendingText="Сохраняю…">Сохранить</SubmitButton>
    </ActionForm>
  );
}
