"use client";
import { useState } from "react";

// Без похожих знаков (0/O, 1/l/I), чтобы пароль можно было продиктовать или перепечатать.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Поле пароля, который задаёт админ: виден целиком (его потом пересылают сотруднику), рядом кнопка «Сгенерировать». */
export function PasswordInput({ value, onChange, name = "password" }: { value?: string; onChange?: (v: string) => void; name?: string }) {
  const [own, setOwn] = useState("");
  const current = value ?? own;
  const set = (v: string) => { setOwn(v); onChange?.(v); };
  return (
    <div className="flex gap-2">
      <input name={name} type="text" className="input font-mono" required minLength={8} autoComplete="off" spellCheck={false} placeholder="не короче 8 символов" value={current} onChange={(e) => set(e.target.value)} />
      <button type="button" className="btn-ghost shrink-0" onClick={() => set(generatePassword())}>Сгенерировать</button>
    </div>
  );
}
