"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Field } from "@/components/ui";
import { checkKeywordDuplicates } from "@/actions/articles";
import { innerDuplicates, parseKeywordLines, type ParsedKeyword } from "@/lib/articles/keywords";
import type { KeywordInput } from "@/lib/articles/types";
import type { FailedHint } from "@/lib/articles/failedKeywordsView";

type Props = { siteId: string; onCount?: (n: number) => void };

/**
 * Вставка списка ключей: по строке `ключ | seo | focus | количество фото` (разделители: «|», табуляция, «;», CSV).
 * Показывает разбор, ошибки строк, повторы внутри списка и дубликаты по сайту (проверка на сервере) — списком, без confirm.
 * В форму уходит скрытое поле `keywords` (JSON готовых строк).
 */
export function KeywordsInput({ siteId, onCount }: Props) {
  const [text, setText] = useState("");
  const [skipDup, setSkipDup] = useState(true);
  const [dups, setDups] = useState<Set<string>>(new Set());
  // Ключи из списка «Неудачные ключи» сайта (нормализованные) — только предупреждение, запуск не блокируют
  const [failed, setFailed] = useState<Map<string, FailedHint>>(new Map());
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState("");
  const [showAll, setShowAll] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rows: ParsedKeyword[] = useMemo(() => parseKeywordLines(text), [text]);
  const inner = useMemo(() => innerDuplicates(rows.filter((r) => !r.error)), [rows]);
  const valid = rows.filter((r) => !r.error);

  // Проверка дубликатов по сайту: через 700 мс после последней правки (и при смене сайта)
  useEffect(() => {
    setDups(new Set()); setFailed(new Map()); setCheckErr("");
    if (!siteId || !valid.length) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await checkKeywordDuplicates(siteId, [...new Set(valid.map((v) => v.keyword))]);
        if (r.error) setCheckErr(r.error);
        setDups(new Set(r.duplicates));
        setFailed(new Map((r.failed ?? []).map((h) => [h.keyword, h])));
      } catch { setCheckErr("Не удалось проверить дубликаты: сервер не ответил"); }
      finally { setChecking(false); }
    }, 700);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, text]);

  // Что реально уйдёт в запуск: без ошибок, без повторов внутри списка (первое вхождение остаётся), при skipDup — без дубликатов по сайту
  const seen = new Set<string>();
  const payload: KeywordInput[] = [];
  const dupBySite: string[] = [];
  for (const r of valid) {
    const l = r.keyword.toLowerCase();
    if (seen.has(l)) continue;
    seen.add(l);
    if (dups.has(l)) { dupBySite.push(r.keyword); if (skipDup) continue; }
    payload.push({ keyword: r.keyword, seoKeyword: r.seoKeyword, focusKeyword: r.focusKeyword, photoCount: r.photoCount });
  }
  useEffect(() => { onCount?.(payload.length); }, [payload.length, onCount]);

  const errors = rows.filter((r) => r.error);
  const failedOf = (k: string) => failed.get(k.toLowerCase().replace(/\s+/g, " ").trim());
  const failedInPayload = payload.flatMap((p) => { const h = failedOf(p.keyword); return h ? [{ keyword: p.keyword, h }] : []; });
  const visible = showAll ? rows : rows.slice(0, 60);

  return (
    <div className="space-y-3">
      <input type="hidden" name="keywords" value={JSON.stringify(payload)} />
      <Field label="Ключи" hint="По одному в строке. Можно добавить колонки через « | » или табуляцию: ключ | SEO-ключ | фокус-ключ | количество фото. Пометки NEW/OLD/TEST в скобках убираются сами.">
        <textarea className="input font-mono text-[13px]" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"short acrylic nails ideas\ncoffin nails fall 2026 | coffin nails | fall coffin nails | 24\nalmond nails spring"} />
      </Field>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <span>Строк: <b>{rows.length}</b></span>
          <span>К запуску: <b className={payload.length ? "text-ok" : "text-danger"}>{payload.length}</b></span>
          {errors.length > 0 && <span className="text-danger">с ошибкой: {errors.length}</span>}
          {inner.size > 0 && <span className="text-warn">повторов в списке: {inner.size}</span>}
          {checking ? <span className="help">проверяю дубликаты по сайту…</span> : dupBySite.length > 0 ? <span className="text-warn">уже есть у сайта: {dupBySite.length}</span> : siteId && valid.length > 0 && !checkErr ? <span className="text-ok">дубликатов по сайту нет</span> : null}
          {dupBySite.length > 0 && (
            <label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> не запускать дубликаты</label>
          )}
        </div>
      )}
      {checkErr && <Alert tone="warn">{checkErr}</Alert>}
      {failedInPayload.length > 0 && (
        <Alert tone="warn">
          <div className="font-medium">Уже были неудачными на этом сайте ({failedInPayload.length}) — запуск не блокируется, но фото по ним может снова не хватить:</div>
          <ul className="mt-1 list-disc pl-5 text-[13px]">
            {failedInPayload.slice(0, 20).map(({ keyword, h }) => <li key={keyword}>{keyword} — {h.label.toLowerCase()}, итог {h.finalPhotos} из {h.photoTarget}{h.occurrences > 1 ? `, раз: ${h.occurrences}` : ""}</li>)}
            {failedInPayload.length > 20 && <li>…и ещё {failedInPayload.length - 20}</li>}
          </ul>
          <a href={`/pinterest/articles/failed-keywords?site=${siteId}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[13px] underline underline-offset-2">Список «Неудачные ключи»</a>
        </Alert>
      )}
      {dupBySite.length > 0 && (
        <Alert tone="warn">
          <div className="font-medium">У этого сайта уже есть статьи с такими ключами{skipDup ? " — они будут пропущены" : " — будут созданы повторно"}:</div>
          <ul className="mt-1 list-disc pl-5 text-[13px]">{dupBySite.slice(0, 20).map((k) => <li key={k}>{k}</li>)}{dupBySite.length > 20 && <li>…и ещё {dupBySite.length - 20}</li>}</ul>
        </Alert>
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-line overflow-hidden">
          <div className="table-wrap">
            <table className="table text-[13px]">
              <thead><tr><th className="w-10">№</th><th>Ключ (тема статьи)</th><th className="hidden md:table-cell">SEO-ключ</th><th className="hidden md:table-cell">Фокус-ключ</th><th className="hidden sm:table-cell">Фото</th><th>Проверка</th></tr></thead>
              <tbody>
                {visible.map((r) => {
                  const l = r.keyword.toLowerCase();
                  const isDup = dups.has(l);
                  const isInner = inner.has(l) && valid.find((v) => v.keyword.toLowerCase() === l) !== r;
                  const fh = !r.error && !isInner && !isDup ? failedOf(r.keyword) : undefined;
                  const note = r.error ?? (isInner ? "повтор в списке" : isDup ? (skipDup ? "уже есть у сайта · пропустим" : "уже есть у сайта · создадим снова") : fh ? `был неудачным: ${fh.label.toLowerCase()}` : "ок");
                  const cls = r.error ? "text-danger" : isDup || isInner || fh ? "text-warn" : "text-ok";
                  return (
                    <tr key={r.line} className={r.error ? "bg-danger-soft/40" : isDup || isInner ? "bg-warn-soft/40" : ""}>
                      <td className="text-muted tabular-nums">{r.line}</td>
                      <td><div className="truncate max-w-[320px]" title={r.raw}>{r.keyword || <span className="text-muted">{r.raw}</span>}</div></td>
                      <td className="hidden md:table-cell text-muted truncate max-w-[200px]">{r.seoKeyword ?? "—"}</td>
                      <td className="hidden md:table-cell text-muted truncate max-w-[200px]">{r.focusKeyword ?? "—"}</td>
                      <td className="hidden sm:table-cell text-muted">{r.photoCount ?? <span title="Из настроек запуска">по умолч.</span>}</td>
                      <td className={cls}>{note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > visible.length && <button type="button" className="btn-ghost btn-sm m-2" onClick={() => setShowAll(true)}>Показать все {rows.length}</button>}
        </div>
      )}
    </div>
  );
}
