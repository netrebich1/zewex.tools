"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { approveAllReviewAction } from "@/actions/blog";

/** «Одобрить все» на странице проверки: подтверждение вторым нажатием, затем все статьи «ждёт проверки» уходят в публикацию. */
export function ApproveAllButton({ count, siteId }: { count: number; siteId?: string }) {
  const [confirm, setConfirm] = useState(false);
  if (!count) return null;
  return (
    <ActionForm action={approveAllReviewAction} className="flex flex-wrap items-center gap-2">
      {siteId && <input type="hidden" name="siteId" value={siteId} />}
      {!confirm ? (
        <button type="button" className="btn-primary btn-sm" onClick={() => setConfirm(true)}>Одобрить все ({count})</button>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5 rounded-lg bg-brand/10 px-2 py-1 text-[13px]">
          Опубликовать все {count} статей без просмотра?
          <button type="submit" className="btn-primary btn-sm" onClick={() => setTimeout(() => setConfirm(false), 0)}>Да, одобрить</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirm(false)}>Отмена</button>
        </span>
      )}
    </ActionForm>
  );
}
