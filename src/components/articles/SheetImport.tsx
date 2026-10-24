"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Field } from "@/components/ui";
import { previewSheetImport, type SheetPreview } from "@/actions/articles";

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
 * Ключи из Google Таблицы (шаг «Ключи» нового запуска): ссылка → «Прочитать таблицу» → что пойдёт в работу и что пропустим.
 * Вкладка = домен сайта; берутся строки без статуса и без Publish URL; сценарий — по номеру в колонке «Сценарий», режим — из «Режим».
 * В форму уходят скрытые `source=sheet` и `sheetUrl`; при запуске сервер читает таблицу заново и отмечает взятые строки «в работе».
 */
export function SheetImport({ siteId, defaultUrl, domain, sheets, onCount }: Props) {
  const [url, setUrl] = useState(defaultUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [showAll, setShowAll] = useState(false);

  const ready = preview?.ready.length ?? 0;
  useEffect(() => { onCount?.(ready); }, [ready, onCount]);

  const read = async () => {
    setLoading(true); setError(""); setPreview(null); setShowAll(false);
    try {
      const r = await previewSheetImport(siteId, url.trim());
      if (r.error) setError(r.error);
      else setPreview(r.preview ?? null);
    } catch { setError("Не удалось прочитать таблицу: сервер не ответил"); }
    finally { setLoading(false); }
  };

  if (!sheets.connected) {
    return (
      <Alert tone="warn">
        Google Таблицы ещё не подключены к порталу. Подключение делается один раз администратором — в <Link href={`/pinterest/articles/sites/${siteId}?tab=settings#sheets`} className="underline">настройках сайта, блок «Google Таблицы»</Link>.
      </Alert>
    );
  }

  const visible = preview ? (showAll ? preview.ready : preview.ready.slice(0, 40)) : [];

  return (
    <div className="space-y-3">
      <input type="hidden" name="source" value="sheet" />
      <Field label="Ссылка на Google Таблицу" hint={`Нужна вкладка с названием «${domain || "домен сайта"}». У таблицы должен быть доступ «Редактор» для ${sheets.email ?? "сервисного аккаунта портала"} — туда же портал запишет статус, ссылку и дату.`}>
        <div className="flex flex-wrap gap-2">
          <input name="sheetUrl" className="input min-w-0 flex-1" value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); setError(""); }} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <button type="button" className="btn-primary" onClick={read} disabled={loading || !url.trim()}>{loading ? "Читаю…" : preview ? "Прочитать заново" : "Прочитать таблицу"}</button>
        </div>
      </Field>
      <p className="help">Берутся строки без «Статуса» и без Publish URL. Сценарий — номер в колонке «Сценарий», режим — колонка «Режим» (2 — сначала модерация фото, 1 — текст сразу); без них строка не берётся. Колонки «Год в URL», «Гео», «Язык», «Свежесть» — необязательные.</p>

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

          {preview.skipped.length > 0 && (
            <Alert tone="warn">
              <div className="font-medium">Эти строки не будут взяты — исправьте их в таблице и нажмите «Прочитать заново»:</div>
              <ul className="mt-1 list-disc pl-5 text-[13px]">
                {preview.skipped.slice(0, 15).map((s) => <li key={s.row}>строка {s.row}: {s.keyword} — {s.reason}</li>)}
                {preview.skipped.length > 15 && <li>…и ещё {preview.skipped.length - 15}</li>}
              </ul>
            </Alert>
          )}

          {preview.failed && preview.failed.length > 0 && (
            <Alert tone="warn">
              <div className="font-medium">Уже были неудачными на этом сайте ({preview.failed.length}) — строки возьмём, но фото по ним может снова не хватить:</div>
              <ul className="mt-1 list-disc pl-5 text-[13px]">
                {preview.failed.slice(0, 15).map((h) => <li key={h.keyword}>{h.keyword} — {h.label.toLowerCase()}, итог {h.finalPhotos} из {h.photoTarget}{h.occurrences > 1 ? `, раз: ${h.occurrences}` : ""}</li>)}
                {preview.failed.length > 15 && <li>…и ещё {preview.failed.length - 15}</li>}
              </ul>
              <a href={`/pinterest/articles/failed-keywords?site=${siteId}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[13px] underline underline-offset-2">Список «Неудачные ключи»</a>
            </Alert>
          )}

          {ready === 0 ? (
            <Alert tone="neutral">Новых строк к запуску нет: у всех строк вкладки уже есть статус или ссылка на публикацию.</Alert>
          ) : (
            <div className="rounded-xl border border-line overflow-hidden">
              <div className="table-wrap">
                <table className="table text-[13px]">
                  <thead><tr><th className="w-14">Строка</th><th>Ключ (тема статьи)</th><th>Сценарий</th><th className="hidden sm:table-cell">Режим</th><th className="hidden md:table-cell">Из таблицы</th></tr></thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.row}>
                        <td className="text-muted tabular-nums">{r.row}</td>
                        <td><div className="truncate max-w-[320px]" title={r.keyword}>{r.keyword}</div></td>
                        <td className="text-muted"><div className="truncate max-w-[220px]" title={r.recipe}>{r.recipe}</div></td>
                        <td className="hidden sm:table-cell text-muted whitespace-nowrap">{r.photoReview ? "2 · сначала фото" : "1 · текст сразу"}</td>
                        <td className="hidden md:table-cell text-muted">{r.extras || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.ready.length > visible.length && <button type="button" className="btn-ghost btn-sm m-2" onClick={() => setShowAll(true)}>Показать все {preview.ready.length}</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
