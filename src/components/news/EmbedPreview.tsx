"use client";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";

type Embed = { kind: string; url: string; code: string; from: string };

/** Живой предпросмотр вставок Instagram / X / YouTube / TikTok и код для копирования в WordPress. */
export function EmbedPreview({ embeds }: { embeds: Embed[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="space-y-2">
      {embeds.map((e) => (
        <li key={e.url} className="rounded-lg border border-line p-2">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="badge bg-ink/5 text-ink-2">{e.kind}</span>
            <a href={e.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-info hover:underline">{e.url}</a>
            <span className="help">из {e.from}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(open === e.url ? null : e.url)}>{open === e.url ? "Скрыть превью" : "Показать, как будет выглядеть"}</button>
            <CopyButton text={e.code} label="Скопировать код" className="btn-primary btn-sm" />
          </div>
          {open === e.url && <Live code={e.code} />}
        </li>
      ))}
    </ul>
  );
}

function Live({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = code.replace(/<script[\s\S]*?<\/script>/gi, "");
    // Скрипты платформ подхватывают blockquote на странице (Instagram, X, Threads, TikTok, Pinterest) или сами рисуют
    // виджет на месте тега (Telegram): создаём <script> со всеми атрибутами внутри контейнера; повторный вызов — process().
    const w = window as unknown as { instgrm?: { Embeds: { process: () => void } }; twttr?: { widgets: { load: (n?: Element) => void } } };
    for (const m of code.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = [...m[1].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)];
      const src = attrs.find((a) => a[1] === "src")?.[2] ?? "";
      const dataAttrs = attrs.filter((a) => a[1].startsWith("data-"));
      if (src && !dataAttrs.length && document.querySelector(`script[src="${src}"]`)) {
        w.instgrm?.Embeds?.process();
        w.twttr?.widgets?.load(el);
        continue;
      }
      const s = document.createElement("script");
      s.async = true;
      if (src) s.src = src;
      for (const a of dataAttrs) s.setAttribute(a[1], a[2] ?? "");
      el.appendChild(s);
    }
  }, [code]);
  return (
    <div className="mt-2 rounded-lg bg-surface-2 p-2">
      <div ref={ref} className="min-h-[120px] overflow-hidden" />
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-2 text-[11.5px]">{code}</pre>
    </div>
  );
}
