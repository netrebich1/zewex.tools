"use client";
import { useActionState, useState } from "react";
import { deleteSiteAccess } from "@/actions/access";
import { Alert, Messages } from "@/components/ui";
import { SubmitButton } from "@/components/ui/SubmitButton";

export type SiteDeletionSummary = { pinRuns: number; pins: number; articles: number; inPins: boolean; inArticles: boolean; busy: string | null };

/**
 * Удаление сайта в два шага: сначала показываем, что именно пропадёт, затем просим ввести название сайта.
 * Сервер проверяет название ещё раз (`deleteSiteAccess`).
 */
export function DeleteSiteForm({ id, name, summary, initialOpen = false }: { id: string; name: string; summary: SiteDeletionSummary; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [typed, setTyped] = useState("");
  const [state, formAction] = useActionState(deleteSiteAccess, {});
  const match = typed.trim().toLowerCase() === name.trim().toLowerCase();

  if (!open) return <button type="button" id="delete" className="btn-danger w-full" onClick={() => setOpen(true)}>Удалить сайт</button>;
  return (
    <form action={formAction} id="delete" className="rounded-2xl border border-danger/30 bg-danger-soft/40 p-4 space-y-3">
      <input type="hidden" name="id" value={id} />
      <div className="text-[15px] font-semibold text-danger">Удалить сайт «{name}»?</div>
      <Messages error={state.error} />
      <div className="text-[14px]">
        Будет удалено безвозвратно:
        <ul className="mt-1 list-disc pl-5 space-y-0.5">
          <li>доступ к сайту (логин и пароль WordPress), команды и видимость;</li>
          {summary.inPins && <li>сайт в Pinterest Pins: доски, наборы стилей, прогонов — {summary.pinRuns}, пинов с картинками — {summary.pins};</li>}
          {summary.inArticles && <li>сайт в Статьях: настройки, статей с фото — {summary.articles}.</li>}
        </ul>
        <p className="help mt-2">На самом сайте в WordPress ничего не удаляется: опубликованные статьи и загруженные картинки останутся.</p>
      </div>
      {summary.busy && <Alert tone="warn">{summary.busy}</Alert>}
      <label className="block">
        <span className="label">Чтобы подтвердить, введите название сайта: <b className="select-all">{name}</b></span>
        <input name="confirm" className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} />
      </label>
      <div className="flex gap-2">
        <SubmitButton className={`btn-danger flex-1 ${match ? "" : "opacity-50 pointer-events-none"}`} pendingText="Удаляю…">Удалить навсегда</SubmitButton>
        <button type="button" className="btn-ghost" onClick={() => { setOpen(false); setTyped(""); }}>Отмена</button>
      </div>
    </form>
  );
}
