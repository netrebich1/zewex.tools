import Link from "next/link";
import { keysSummary, fmtChars } from "@/lib/deepl/keys";
import { DeeplNav } from "./DeeplNav";

/** Меню инструмента + полоска «ключи DeepL в работе · осталось символов» на каждой странице DeepL Articler. */
export async function DeeplHeader() {
  const s = await keysSummary();
  const tone = s.working === 0 ? "border-danger/40 bg-danger-soft" : s.remaining != null && s.perArticle && s.remaining / s.perArticle < 20 ? "border-warn/40 bg-warn-soft" : "border-line bg-surface";
  return (
    <>
      <DeeplNav />
      <Link href="/discovery/deepl/keys" className={`mb-5 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border px-4 py-2.5 text-[14px] hover:border-brand ${tone}`}>
        <span className="font-semibold">Ключи DeepL</span>
        {s.total === 0 ? (
          <span>ключей нет — нажмите, чтобы добавить</span>
        ) : (
          <>
            <span>в работе <b>{s.working}</b> из {s.total}</span>
            {s.exhausted > 0 && <span className="text-muted">исчерпано {s.exhausted}</span>}
            {s.off > 0 && <span className="text-muted">выключено {s.off}</span>}
            <span>осталось ≈ <b>{s.remaining == null ? "без лимита" : fmtChars(s.remaining)}</b>{s.remaining != null ? " символов" : ""}</span>
            {s.remaining != null && s.perArticle ? <span className="text-muted">хватит примерно на {Math.floor(s.remaining / s.perArticle).toLocaleString("ru-RU")} статей (≈ {fmtChars(s.perArticle)} на статью)</span> : null}
          </>
        )}
        <span className="ml-auto text-muted">управлять →</span>
      </Link>
    </>
  );
}
