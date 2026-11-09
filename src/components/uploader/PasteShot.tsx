"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Слот скриншота в инструкции. Есть файл — показывает картинку (по клику в полный размер).
 * Админу без файла (или при наведении) — рамка «кликните и нажмите Ctrl+V»: снимок из буфера (Win+Shift+S)
 * сжимается в JPEG и уходит в POST /api/uploader/guide/shot?name=. Сотрудник пустой слот не видит.
 */
export function PasteShot({ name, src, caption, admin }: { name: string; src: string | null; caption?: string; admin: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!src && !admin) return null;

  async function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) { setMsg("В буфере нет картинки. Снимите экран (Win+Shift+S) и вставьте снова."); return; }
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / bmp.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86));
      if (!blob) throw new Error("не удалось сжать");
      const res = await fetch(`/api/uploader/guide/shot?name=${name}`, { method: "POST", body: blob, headers: { "Content-Type": "image/jpeg" } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      setMsg("Сохранено"); router.refresh();
    } catch (err) {
      setMsg(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setBusy(false); }
  }

  return (
    <figure className="space-y-1">
      <div tabIndex={admin ? 0 : -1} onPaste={admin ? onPaste : undefined}
        className={`relative block overflow-hidden rounded-xl border bg-ink/5 ${admin ? "border-dashed border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand cursor-text" : "border-line"}`}
        title={admin ? "Кликните сюда и нажмите Ctrl+V со скриншотом" : undefined}>
        {src ? (
          <a href={src} target="_blank" rel="noreferrer">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={src} alt={caption ?? name} loading="lazy" className="w-full" /></a>
        ) : (
          <div className="flex h-36 items-center justify-center p-4 text-center text-[13px] text-muted">{busy ? "Сохраняю…" : <>Скриншот «{name}»: кликните сюда и нажмите <b>Ctrl+V</b> (снимок — Win+Shift+S)</>}</div>
        )}
        {admin && src && <span className="absolute right-2 top-2 rounded bg-bg/80 px-1.5 text-[11px] text-muted">кликните и Ctrl+V — заменить</span>}
      </div>
      {(caption || msg) && <figcaption className={`help ${msg?.startsWith("Ошибка") ? "text-danger" : ""}`}>{msg ?? caption}</figcaption>}
    </figure>
  );
}
