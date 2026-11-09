"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Field } from "@/components/ui";
import { checkBlogDuplicates } from "@/actions/blog";
import { innerDuplicates, parseKeywordLines, type ParsedKeyword } from "@/lib/articles/keywords";
import type { KeywordInput } from "@/lib/blog/types";

/**
 * Вставка списка ключей: по строке `ключ | тема статьи | фокус-ключ` (или колонки через Tab — из таблицы).
 * Тема статьи — заголовок, который задаёт редактор («25 Clear Skin Tips»): по ней система определяет формат статьи. Показывает разбор, повторы внутри списка и дубликаты по сайту.
 * В форму уходит скрытое поле `keywords` (JSON).
 */
export function KeywordsInput({ siteId, onCount }: { siteId: string; onCount?: (n: number) => void }) {
  const [text, setText] = useState("");
  const [skipDup, setSkipDup] = useState(true);
  const [dups, setDups] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rows: ParsedKeyword[] = useMemo(() => parseKeywordLines(text), [text]);
  const inner = useMemo(() => innerDuplicates(rows.filter((r) => !r.error)), [rows]);
  const valid = rows.filter((r) => !r.error);

  useEffect(() => {
    setDups(new Set()); setCheckErr("");
    if (!siteId || !valid.length) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await checkBlogDuplicates(siteId, [...new Set(valid.map((v) => v.keyword))]);
        if (r.error) setCheckErr(r.error);
        setDups(new Set(r.duplicates));
      } catch { setCheckErr("Не удалось проверить дубликаты: сервер не ответил"); }
      finally { setChecking(false); }
    }, 700);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, text]);

  const seen = new Set<string>();
  const payload: KeywordInput[] = [];
  const dupBySite: string[] = [];
  for (const r of valid) {
    const l = r.keyword.toLowerCase();
    if (seen.has(l)) continue;
    seen.add(l);
    if (dups.has(l)) { dupBySite.push(r.keyword); if (skipDup) continue; }
    payload.push({ keyword: r.keyword, topic: r.seoKeyword || undefined, focusKeyword: r.focusKeyword || undefined });
  }
  useEffect(() => { onCount?.(payload.length); }, [payload.length, onCount]);
  const errors = rows.filter((r) => r.error);

  return (
    <div className="space-y-3">
      <input type="hidden" name="keywords" value={JSON.stringify(payload)} />
      <Field label="Ключи и темы статей" hint="По строке: ключ | тема статьи | фокус-ключ (тема и фокус-ключ — по желанию; можно вставить две колонки из таблицы через Tab). По теме система сама определяет формат: «31 Easy Soup Recipes» — подборка рецептов, «25 Clear Skin Tips» — нумерованный список, «How to …» — инструкция.">
        <textarea className="input font-mono text-[13px]" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"clear skin | 25 Clear Skin Tips That Actually Work\nsoup recipes | 31 Easy Soup Recipes Even Picky Eaters Love\nquestions to ask | 400 Interesting Questions to Ask Anyone\nhow to use hair rollers"} />
      </Field>
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <span>Строк: <b>{rows.length}</b></span>
          <span>К запуску: <b className={payload.length ? "text-ok" : "text-danger"}>{payload.length}</b></span>
          {errors.length > 0 && <span className="text-danger">с ошибкой: {errors.length}</span>}
          {inner.size > 0 && <span className="text-warn">повторов в списке: {inner.size}</span>}
          {checking ? <span className="help">проверяю дубликаты по сайту…</span> : dupBySite.length > 0 ? <span className="text-warn">уже есть у сайта: {dupBySite.length}</span> : siteId && valid.length > 0 && !checkErr ? <span className="text-ok">дубликатов по сайту нет</span> : null}
          {dupBySite.length > 0 && <label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> не запускать дубликаты</label>}
        </div>
      )}
      {checkErr && <Alert tone="warn">{checkErr}</Alert>}
      {dupBySite.length > 0 && (
        <Alert tone="warn">
          <div className="font-medium">У этого сайта уже есть статьи с такими ключами{skipDup ? " — они будут пропущены" : " — будут созданы повторно"}:</div>
          <ul className="mt-1 list-disc pl-5 text-[13px]">{dupBySite.slice(0, 20).map((k) => <li key={k}>{k}</li>)}{dupBySite.length > 20 && <li>…и ещё {dupBySite.length - 20}</li>}</ul>
        </Alert>
      )}
    </div>
  );
}
