"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Field } from "@/components/ui";
import { previewBlogSheet, type BlogSheetPreview } from "@/actions/blog";

type Props = {
  siteId: string;
  /** Ссылка из настроек сайта */
  defaultUrl: string;
  /** Домен сайта = название вкладки */
  domain: string;
  sheets: { connected: boolean; email: string | null };
  onCount?: (n: number) => void;
};

/**
 * Ключи и темы из Google Таблицы (шаг «Ключи» нового запуска): ссылка → «Прочитать таблицу» → что пойдёт в работу,
 * какой тип статьи ожидается по теме и что пропустим. Вкладка = домен сайта; берутся строки без «Статуса» и без «Publish URL».
 * В форму уходят скрытые `source=sheet` и `sheetUrl`; при запуске сервер читает таблицу заново и отмечает строки «в работе».
 */
export function BlogSheetImport({ siteId, defaultUrl, domain, sheets, onCount }: Props) {
  const [url, setUrl] = useState(defaultUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<BlogSheetPreview | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ready = preview?.ready.length ?? 0;
  useEffect(() => { onCount?.(ready); }, [ready, onCount]);

  const read = async () => {
    setLoading(true); setError(""); setPreview(null); setShowAll(false);
    try {
      const r = await previewBlogSheet(siteId, url.trim());
      if (r.error) setError(r.error); else setPreview(r.preview ?? null);
    } catch { setError("Не удалось прочитать таблицу: сервер не ответил"); }
    finally { setLoading(false); }
  };

  if (!sheets.connected) {
    return <Alert tone="warn">Google Таблицы ещё не подключены к порталу. Подключение одно на весь портал, его делает администратор в настройках любого сайта сервиса «Pinterest Articles», блок «Google Таблицы» (<Link href="/pinterest/articles/sites" className="underline">сайты «Статей»</Link>).</Alert>;
  }
  const visible = preview ? (showAll ? preview.ready : preview.ready.slice(0, 40)) : [];

  return (
    <div className="space-y-3">
      <input type="hidden" name="source" value="sheet" />
      <Field label="Ссылка на Google Таблицу" hint={`Нужна вкладка с названием «${domain || "домен сайта"}». Доступ «Редактор» для ${sheets.email ?? "сервисного аккаунта портала"} — туда портал запишет тип статьи, статус, ссылку и дату.`}>
        <div className="flex flex-wrap gap-2">
          <input name="sheetUrl" className="input min-w-0 flex-1" value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); setError(""); }} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <button type="button" className="btn-primary" onClick={read} disabled={loading || !url.trim()}>{loading ? "Читаю…" : preview ? "Прочитать заново" : "Прочитать таблицу"}</button>
        </div>
      </Field>
      <p className="help">Колонки: <b>Keyword</b> (обязательно) и <b>Тема статьи</b> (заголовок — по нему система сама выберет формат), по желанию Focus Keyword и Год в URL. Сценарий, режим, гео и язык фото в таблице не нужны. Берутся строки без «Статуса» и без Publish URL.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {preview && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <span>Вкладка: <b>{preview.tab}</b></span>
            <span>Строк с ключом: <b>{preview.total}</b></span>
            <span>К запуску: <b className={ready ? "text-ok" : "text-danger"}>{ready}</b></span>
            {preview.taken > 0 && <span className="help">уже в работе или опубликовано: {preview.taken}</span>}
            {preview.skipped.length > 0 && <span className="text-warn">пропустим: {preview.skipped.length}</span>}
          </div>
          {preview.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
          {preview.skipped.length > 0 && (
            <Alert tone="warn">
              <div className="font-medium">Эти строки не будут взяты:</div>
              <ul className="mt-1 list-disc pl-5 text-[13px]">
                {preview.skipped.slice(0, 15).map((s) => <li key={s.row}>строка {s.row}: {s.keyword} — {s.reason}</li>)}
                {preview.skipped.length > 15 && <li>…и ещё {preview.skipped.length - 15}</li>}
              </ul>
            </Alert>
          )}
          {ready === 0 ? <Alert tone="neutral">Новых строк к запуску нет: у всех строк вкладки уже есть статус или ссылка на публикацию.</Alert> : (
            <div className="rounded-xl border border-line overflow-hidden">
              <div className="table-wrap">
                <table className="table text-[13px]">
                  <thead><tr><th className="w-14">Строка</th><th>Ключ</th><th>Тема статьи</th><th className="hidden md:table-cell">Ожидаемый тип</th></tr></thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.row}>
                        <td className="text-muted tabular-nums">{r.row}</td>
                        <td><div className="truncate max-w-[200px]" title={r.keyword}>{r.keyword}</div></td>
                        <td><div className="truncate max-w-[340px]" title={r.topic}>{r.topic || <span className="text-muted">— по ключу</span>}</div></td>
                        <td className="hidden md:table-cell text-muted whitespace-nowrap">{r.expectedType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.ready.length > visible.length && <button type="button" className="btn-ghost btn-sm m-2" onClick={() => setShowAll(true)}>Показать все {preview.ready.length}</button>}
            </div>
          )}
          <p className="help">«Ожидаемый тип» — по теме, до исследования. Окончательно тип определяется после исследования (тема здоровья добавит осторожность и дисклеймер) и записывается в колонку «Тип статьи».</p>
        </>
      )}
    </div>
  );
}
