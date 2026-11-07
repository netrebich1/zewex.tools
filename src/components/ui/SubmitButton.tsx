"use client";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export function SubmitButton({ children, className = "btn-primary", pendingText, confirm, formAction }: { children: ReactNode; className?: string; pendingText?: string; confirm?: string; formAction?: (form: FormData) => void | Promise<void> }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      formAction={formAction}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "…") : children}
    </button>
  );
}
