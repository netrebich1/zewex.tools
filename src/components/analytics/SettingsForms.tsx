"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addServiceAccount, createGroup } from "@/actions/analytics";
import { GROUP_COLORS } from "@/lib/analytics/types";

/** Сервисный аккаунт: запасной способ подключения без OAuth (ключ JSON + роль «Читатель» в GA). */
export function ServiceAccountForm() {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>Подключить сервисный аккаунт</button>;
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-4">
      <p className="text-[14px] font-semibold">Сервисный аккаунт Google Cloud</p>
      <p className="help mt-1">Подходит, если не хочется давать доступ к личному Google-аккаунту. Создайте сервисный аккаунт в Google Cloud, скачайте ключ JSON и добавьте его почту в Google Analytics (Администратор → Управление доступом → роль «Читатель») в каждом аккаунте GA.</p>
      <ActionForm action={addServiceAccount} className="mt-3 space-y-3">
        <input name="label" className="input" placeholder="Название (например, «Ключ для аналитики»)" />
        <textarea name="json" required rows={5} className="input font-mono text-[12px]" placeholder='{"type": "service_account", "client_email": "...", "private_key": "..."}' />
        <div className="flex gap-2">
          <SubmitButton pendingText="Проверяем…">Подключить</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button>
        </div>
      </ActionForm>
    </div>
  );
}

export function NewGroupForm() {
  const [color, setColor] = useState(GROUP_COLORS[0]);
  return (
    <ActionForm action={createGroup} className="flex flex-wrap items-end gap-2">
      <input name="name" required className="input !w-56" placeholder="Название группы" />
      <input type="hidden" name="color" value={color} />
      <ColorPicker value={color} onChange={setColor} />
      <SubmitButton className="btn-primary btn-sm" pendingText="…">Создать</SubmitButton>
    </ActionForm>
  );
}

export function ColorPicker({ value, onChange, name }: { value: string; onChange?: (c: string) => void; name?: string }) {
  const [v, setV] = useState(value);
  return (
    <span className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface px-2 py-2">
      {name && <input type="hidden" name={name} value={v} />}
      {GROUP_COLORS.map((c) => (
        <button key={c} type="button" onClick={() => { setV(c); onChange?.(c); }} className={`h-5 w-5 rounded-full border-2 transition ${v === c ? "border-ink scale-110" : "border-transparent"}`} style={{ background: c }} aria-label={c} />
      ))}
    </span>
  );
}
