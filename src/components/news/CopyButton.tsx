"use client";
import { useState } from "react";

/** Копирование текста (ТЗ) в буфер; запасной путь — выделение текста в скрытом поле. */
export function CopyButton({ text, label = "Скопировать", className = "btn-brand btn-sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  return (
    <button type="button" onClick={copy} className={className}>
      {done ? "Скопировано ✓" : label}
    </button>
  );
}
