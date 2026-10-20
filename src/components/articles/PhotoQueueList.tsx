"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PhotoQueue, PhotoQueueGroup, PhotoQueueItem } from "@/lib/articles/moderation";
import { moderationApi } from "./PhotoModerationGrid";

/**
 * Очередь модерации фото списком: вкладки «От ИИ» / «Новые» / «Мало фото», поиск по ключу.
 * Список ничего не закрепляет; клик по статье открывает её в режиме проверки (закрепление — при открытии).
 * «Мало фото»: действия «Вернуть на модерацию» / «Добрать фото» / «Закрыть» прямо в строке.
 */

const BASE = "/pinterest/articles/moderation/articles";

const GROUPS: Array<{ key: PhotoQueueGroup; label: string; hint: string }> = [
  { key: "ai", label: "От ИИ", hint: "ИИ проверил и отдал людям (или только предложил правки в тест-режиме). Причина — в строке." },
  { key: "new", label: "Новые", hint: "ИИ эти статьи не смотрел: проверка ИИ выключена или ещё не дошла." },
  { key: "low", label: "Мало фото", hint: "Подходящих кадров не хватило. Верните на модерацию, отправьте добирать или закройте." },
];

function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

type Props = {
  queue: PhotoQueue;
  siteId?: string;
  initialGroup?: PhotoQueueGroup;
  minPhotos: number;
  /** Показать одну группу без вкладок (страница «Модерация», вкладка «Мало фото») */
  only?: PhotoQueueGroup;
};

export function PhotoQueueList({ queue, siteId, initialGroup, minPhotos, only }: Props) {
  const router = useRouter();
  const firstNonEmpty = GROUPS.find((g) => queue.counts[g.key] > 0)?.key ?? "ai";
  const [group, setGroup] = useState<PhotoQueueGroup>(only ?? initialGroup ?? firstNonEmpty);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);

  const pick = (g: PhotoQueueGroup) => {
    setGroup(g);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("group", g);
      window.history.replaceState(null, "", u.toString());
    } catch {
      /* пусто */
    }
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return queue.items.filter((i) => i.group === group && (!needle || i.keyword.toLowerCase().includes(needle) || i.keywordRu.toLowerCase().includes(needle) || i.siteName.toLowerCase().includes(needle)));
  }, [queue.items, group, q]);

  const openHref = (i: PhotoQueueItem) => `${BASE}?tab=${i.group}&article=${i.id}${siteId ? `&site=${siteId}` : ""}`;

  const lowAction = async (i: PhotoQueueItem, action: "return_review" | "topup" | "close" | "delete", ok: string) => {
    if (action === "close" && !window.confirm(`Закрыть статью «${i.keyword}»? Она не будет написана, фото и резерв останутся.`)) return;
    if (action === "delete" && !window.confirm(`Удалить статью «${i.keyword}» из системы совсем? Фото, оценки и история пропадут, вернуть нельзя.`)) return;
    setBusy(`${action}:${i.id}`);
    setMsg(null);
    try {
      await moderationApi({ action, articleId: i.id, reason: action === "topup" ? "добор из списка «Мало фото»" : undefined });
      setMsg({ text: ok, tone: "ok" });
      router.refresh();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const hint = GROUPS.find((g) => g.key === group)?.hint;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        {!only && GROUPS.map((g) => (
          <button key={g.key} type="button" className={`tab ${group === g.key ? "active" : ""}`} onClick={() => pick(g.key)}>
            {g.label} · {queue.counts[g.key]}
          </button>
        ))}
        <input className="input ml-auto w-full sm:w-64" placeholder="Поиск по ключу или сайту" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="px-4 py-2 help flex flex-wrap gap-x-3">
        <span>{hint}</span>
        {queue.counts.aiBusy > 0 && <span>Ещё {queue.counts.aiBusy} сейчас проверяет ИИ — появятся здесь после решения.</span>}
        {msg && <span className={msg.tone === "danger" ? "text-danger" : "text-ok"}>{msg.text}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-6 pt-2 help">{q ? "По запросу ничего не найдено." : group === "low" ? "Статей с пометкой «Мало фото» нет." : "В этой группе статей нет."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((i) => {
            const need = Math.min(minPhotos, Math.max(1, i.norm));
            const tone = i.photos < need ? "text-danger" : i.norm > 0 && i.photos > i.norm ? "text-warn" : "text-ok";
            const heldByOther = !!i.claimedByName && !i.claimedMine;
            const body = (
              <>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium truncate">{i.keyword}</span>
                    {i.keywordRu && <span className="text-[12.5px] text-muted truncate">{i.keywordRu}</span>}
                  </div>
                  <div className="text-[12.5px] text-muted flex flex-wrap gap-x-2">
                    <span>{i.siteName}</span>
                    <span>· ждёт {ago(i.waitingSince)}</span>
                    {i.claimedByName && <span className={heldByOther ? "text-warn" : ""}>· 🔒 {i.claimedByName}</span>}
                  </div>
                  {i.group === "ai" && i.aiNote && (
                    <div className="mt-1 text-[12.5px] text-warn">
                      {i.aiNote}
                      {i.aiConfidence != null && <span className="text-muted"> · уверенность {i.aiConfidence}</span>}
                    </div>
                  )}
                  {i.group === "new" && i.aiNote && <div className="mt-1 text-[12.5px] text-muted">{i.aiNote}</div>}
                  {i.group === "low" && (
                    <div className="mt-1 text-[12.5px] text-muted">
                      {i.lowReason || "Причина не указана"}
                      {i.lowByAi && " · отметил ИИ"}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right text-[12.5px]">
                  <div className={`font-semibold tabular-nums ${tone}`} title={`В статье ${i.photos} фото, план ${i.norm}, одобрить можно при ${need}+`}>
                    {i.photos} / {i.norm}
                  </div>
                  <div className="text-muted">фото / план</div>
                </div>
              </>
            );
            if (i.group === "low") {
              return (
                <li key={i.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void lowAction(i, "return_review", "Возвращено на модерацию фото")}>
                      На модерацию
                    </button>
                    <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void lowAction(i, "topup", "Добор запущен — статья вернётся с пополненным резервом")}>
                      Добрать фото
                    </button>
                    <button type="button" className="btn-ghost btn-sm text-danger" disabled={!!busy} onClick={() => void lowAction(i, "close", "Статья закрыта")}>
                      Закрыть
                    </button>
                    <button type="button" className="btn-ghost btn-sm text-danger" disabled={!!busy} onClick={() => void lowAction(i, "delete", "Статья удалена")}>
                      Удалить
                    </button>
                    <Link href={`/pinterest/articles/articles/${i.id}`} className="btn-ghost btn-sm">
                      Карточка
                    </Link>
                  </div>
                </li>
              );
            }
            return (
              <li key={i.id}>
                <Link href={openHref(i)} className="flex items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.03]" title={heldByOther ? `Статью сейчас модерирует ${i.claimedByName}` : "Открыть и проверить"}>
                  {body}
                  <span className="shrink-0 text-muted" aria-hidden>
                    →
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
