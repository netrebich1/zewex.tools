import Link from "next/link";
import { delta, fmtDuration, fmtInt } from "@/lib/analytics/format";
import type { PageRow } from "@/lib/analytics/query";
import { Delta } from "./Delta";

export type SiteMeta = { id: string; name: string; host: string | null; url: string | null };

/**
 * Таблица страниц за период: заголовок, адрес (ссылка на сайт), сайт, просмотры с изменением, посетители, время.
 * Сортировка и поиск — параметрами адреса (см. страницу), здесь только вывод.
 */
export function PagesTable({ rows, sites, showSite, total, page, perPage, pageHref }: { rows: PageRow[]; sites: Map<string, SiteMeta>; showSite: boolean; total: number; page: number; perPage: number; pageHref: (p: number) => string }) {
  const pagesCount = Math.max(1, Math.ceil(total / perPage));
  return (
    <div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Страница</th>
              {showSite && <th className="hidden md:table-cell">Сайт</th>}
              <th className="text-right">Просмотры</th>
              <th className="text-right">Изменение</th>
              <th className="text-right hidden sm:table-cell">Посетители</th>
              <th className="text-right hidden lg:table-cell">Визиты</th>
              <th className="text-right hidden lg:table-cell">Время</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = sites.get(r.propertyId);
              const full = s?.url ? `${s.url}${r.path}` : null;
              const d = delta(r.pageviews, r.prevViews);
              return (
                <tr key={`${r.propertyId}|${r.pathHash}`}>
                  <td>
                    {/* max-w у td игнорируется — ограничиваем строки внутри. */}
                    <div className="font-medium text-[14px] leading-snug truncate max-w-[60vw] sm:max-w-[520px]" title={r.title}>{r.title || <span className="text-muted">без заголовка</span>}</div>
                    <div className="help truncate max-w-[60vw] sm:max-w-[520px]">
                      {full ? <a href={full} target="_blank" rel="noopener noreferrer" className="hover:text-ink hover:underline" title={full}>{r.path}</a> : r.path}
                    </div>
                  </td>
                  {showSite && <td className="hidden md:table-cell"><Link href={`/analytics/sites/${r.propertyId}`} className="text-[13px] text-ink-2 hover:text-ink hover:underline whitespace-nowrap">{s?.host || s?.name || "—"}</Link></td>}
                  <td className="text-right tabular-nums font-semibold">{fmtInt(r.pageviews)}{r.prevViews != null && <span className="block help tabular-nums">{fmtInt(r.prevViews)}</span>}</td>
                  <td className="text-right"><Delta d={d} /></td>
                  <td className="text-right tabular-nums hidden sm:table-cell">{fmtInt(r.users)}</td>
                  <td className="text-right tabular-nums hidden lg:table-cell">{fmtInt(r.sessions)}</td>
                  <td className="text-right tabular-nums hidden lg:table-cell">{fmtDuration(r.sessions ? r.engagementSec / r.sessions : null)}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={showSite ? 7 : 6} className="text-center text-muted py-10">Страниц за этот период не найдено</td></tr>}
          </tbody>
        </table>
      </div>
      {pagesCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
          <span className="help">Показано {Math.min(total, (page - 1) * perPage + 1)}–{Math.min(total, page * perPage)} из {fmtInt(total)}</span>
          <div className="inline-flex gap-1">
            {page > 1 && <Link href={pageHref(page - 1)} className="btn-ghost btn-sm">← Назад</Link>}
            {page < pagesCount && <Link href={pageHref(page + 1)} className="btn-ghost btn-sm">Дальше →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
