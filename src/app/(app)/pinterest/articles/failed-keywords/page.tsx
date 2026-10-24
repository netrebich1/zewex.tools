import Link from "next/link";
import type { ArtStatus } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader, type SearchParams } from "@/components/ui";
import { FAILED_REASONS, FEW_FINAL, reasonLabel, type FailedReason } from "@/lib/articles/failedKeywords";
import { failedQuery, failedSummary, listFailedKeywords, parseFailedFilters, visibleArtSites, type FailedFilters, type FailedSort } from "@/lib/articles/failedKeywordsView";
import { statusLabel } from "@/lib/articles/labels";
import { FailedKeywordIgnoreToggle, FailedKeywordNote } from "@/components/articles/FailedKeywordRowActions";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE = "/pinterest/articles/failed-keywords";
const SHOW_MAX = 500;
const PERIODS: Array<{ v: number; label: string }> = [{ v: 7, label: "7 дн." }, { v: 30, label: "30 дн." }, { v: 90, label: "90 дн." }, { v: 0, label: "всё время" }];
const TONES: Record<FailedReason, "danger" | "warn" | "brand" | "neutral"> = { no_photos: "danger", insufficient: "warn", few_final: "brand", ai_removed_many: "neutral" };

export default async function FailedKeywordsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const f = parseFailedFilters(await searchParams);
  const sites = await visibleArtSites(me);
  const siteIds = sites.map((s) => s.id);
  if (f.siteId && !siteIds.includes(f.siteId)) f.siteId = undefined;
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const [{ rows, total }, sum] = await Promise.all([listFailedKeywords(f, siteIds, SHOW_MAX), failedSummary(f, siteIds)]);
  const href = (patch: Partial<FailedFilters>) => {
    const s = failedQuery(f, patch);
    return `${PAGE}${s ? `?${s}` : ""}`;
  };
  const exportQs = failedQuery(f);
  const sortLink = (key: FailedSort, label: string, cls = "") => {
    const active = f.sort === key;
    const dir = active && f.dir === "desc" ? "asc" : "desc";
    return (
      <th className={cls}>
        <Link href={href({ sort: key, dir: key === "keyword" && !active ? "asc" : dir })} className={`hover:text-ink ${active ? "text-ink" : ""}`}>
          {label}{active ? (f.dir === "desc" ? " ↓" : " ↑") : ""}
        </Link>
      </th>
    );
  };
  const filtered = !!(f.siteId || f.reason || f.recipe || f.days || f.minTimes > 1 || f.q || f.ignored !== "hide");

  return (
    <>
      <PageHeader
        back={{ href: "/pinterest/articles", label: "Статьи" }}
        title="Неудачные ключи"
        subtitle={`Ключи, по которым не нашли фото, набрали мало, после модерации осталось меньше ${FEW_FINAL} или модерация убрала много. Список пополняется сам раз в 10 минут — по нему решаем, какие ключи больше не запускать.`}
        actions={
          <>
            <a href={`/api/articles/failed-keywords/export${exportQs ? `?${exportQs}` : ""}`} className="btn-primary">Выгрузить в Excel</a>
            <a href={`/api/articles/failed-keywords/export?${exportQs ? `${exportQs}&` : ""}format=csv`} className="btn-ghost">CSV</a>
          </>
        }
      />

      <div className="mb-4 grid gap-3 grid-cols-2 lg:grid-cols-5">
        <Link href={href({ reason: undefined })} className={`card p-4 hover:bg-surface-2/70 ${!f.reason ? "ring-2 ring-ink/15" : ""}`}>
          <div className="help">Всего ключей</div>
          <div className="text-[26px] font-semibold tabular-nums">{sum.total}</div>
          <div className="help">статей: {sum.articles}{sum.ignored > 0 && <> · «не считать»: {sum.ignored}</>}</div>
        </Link>
        {FAILED_REASONS.map((r) => (
          <Link key={r.value} href={href({ reason: f.reason === r.value ? undefined : r.value })} title={r.help} className={`card p-4 hover:bg-surface-2/70 ${f.reason === r.value ? "ring-2 ring-ink/15" : ""}`}>
            <div className="help">{r.label}</div>
            <div className="text-[26px] font-semibold tabular-nums">{sum.byReason[r.value] ?? 0}</div>
            <div className="help line-clamp-1">{r.short}</div>
          </Link>
        ))}
      </div>

      <Card className="mb-4">
        <form method="get" action={PAGE} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_0.7fr_auto]">
          {f.reason && <input type="hidden" name="reason" value={f.reason} />}
          {f.sort !== "last" && <input type="hidden" name="sort" value={f.sort} />}
          {f.dir !== "desc" && <input type="hidden" name="dir" value={f.dir} />}
          <input name="q" className="input py-2" defaultValue={f.q ?? ""} placeholder="Поиск по ключу" />
          <select name="site" className="input py-2" defaultValue={f.siteId ?? ""}>
            <option value="">Все сайты</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select name="recipe" className="input py-2" defaultValue={f.recipe ?? ""}>
            <option value="">Все сценарии</option>
            {sum.recipes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select name="ignored" className="input py-2" defaultValue={f.ignored}>
            <option value="hide">Без «не считать»</option>
            <option value="only">Только «не считать»</option>
            <option value="all">Все строки</option>
          </select>
          <input name="min" type="number" min={1} className="input py-2" defaultValue={f.minTimes > 1 ? f.minTimes : ""} placeholder="Раз ≥" title="Сколько раз ключ был неудачным (минимум)" />
          <div className="flex gap-2">
            {f.days > 0 && <input type="hidden" name="days" value={String(f.days)} />}
            <button type="submit" className="btn-primary">Показать</button>
            {filtered && <Link href={PAGE} className="btn-ghost">Сбросить</Link>}
          </div>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="help">Последний раз:</span>
          {PERIODS.map((p) => (
            <Link key={p.v} href={href({ days: p.v })} className={`btn-ghost btn-sm ${f.days === p.v ? "bg-ink/10" : ""}`}>{p.label}</Link>
          ))}
          <span className="help ml-auto">
            {f.reason && <>причина: <b>{reasonLabel(f.reason)}</b> · </>}
            найдено {total}{total > rows.length && <> · показаны первые {rows.length}, в Excel — все</>}
            {sum.lastCollected && <> · обновлено {fmtDate(sum.lastCollected)}</>}
          </span>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Empty
          title={filtered ? "По фильтрам ничего нет" : "Неудачных ключей пока нет"}
          hint={filtered ? "Измените фильтры или нажмите «Сбросить»." : "Список собирает воркер по статьям: ключи появятся, когда по ним не найдётся достаточно фото."}
        />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table text-[13px]">
              <thead>
                <tr>
                  {sortLink("keyword", "Ключ")}
                  {sites.length > 1 && sortLink("site", "Сайт", "hidden md:table-cell")}
                  {sortLink("reason", "Причина")}
                  {sortLink("found", "Найдено → фильтр → ИИ → отбор", "hidden lg:table-cell")}
                  {sortLink("final", "Итог / цель")}
                  {sortLink("removed", "Убрано", "hidden sm:table-cell")}
                  {sortLink("times", "Раз")}
                  {sortLink("last", "Последний раз", "hidden md:table-cell")}
                  <th className="hidden xl:table-cell">Заметка</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.ignored ? "opacity-55" : ""}>
                    <td>
                      {r.lastArticleId ? (
                        <Link href={`/pinterest/articles/articles/${r.lastArticleId}`} className="block font-medium max-w-[320px] truncate hover:underline underline-offset-2" title={`${r.keywordRaw} — открыть последнюю статью`}>{r.keywordRaw || r.keyword}</Link>
                      ) : (
                        <div className="font-medium max-w-[320px] truncate" title={r.keywordRaw}>{r.keywordRaw || r.keyword}</div>
                      )}
                      <div className="help max-w-[320px] truncate" title={r.detail ?? undefined}>
                        {r.recipeName || "—"}
                        {r.detail && <> · {r.detail}</>}
                      </div>
                    </td>
                    {sites.length > 1 && <td className="hidden md:table-cell text-muted whitespace-nowrap">{siteName.get(r.siteId) ?? "—"}</td>}
                    <td><Badge tone={TONES[r.reason as FailedReason] ?? "neutral"}>{reasonLabel(r.reason)}</Badge></td>
                    <td className="hidden lg:table-cell tabular-nums text-muted whitespace-nowrap" title="Найдено кандидатов → прошло техфильтр → одобрено ИИ-оценкой → отобрано в статью">
                      {r.candidatesFound} → {r.passedFilter} → {r.approvedByRating} → {r.selected}
                    </td>
                    <td className="tabular-nums whitespace-nowrap">
                      <b className={r.finalPhotos < FEW_FINAL ? "text-danger" : ""}>{r.finalPhotos}</b>
                      <span className="text-muted"> / {r.photoTarget}</span>
                    </td>
                    <td className="hidden sm:table-cell tabular-nums text-muted whitespace-nowrap" title="Убрала ИИ-модерация / убрал модератор при одобрении">
                      {r.aiRemoved || r.humanRemoved ? <>ИИ {r.aiRemoved} · чел. {r.humanRemoved}</> : "—"}
                    </td>
                    <td className="tabular-nums">{r.occurrences > 1 ? <b className="text-warn">{r.occurrences}</b> : r.occurrences}</td>
                    <td className="hidden md:table-cell whitespace-nowrap">
                      <div>{fmtDate(r.lastSeenAt)}</div>
                      {r.lastArticleId && (
                        <Link href={`/pinterest/articles/articles/${r.lastArticleId}`} className="help hover:text-ink underline-offset-2 hover:underline">
                          статья{r.lastStatus ? ` · ${statusLabel(r.lastStatus as ArtStatus)}` : ""}
                        </Link>
                      )}
                    </td>
                    <td className="hidden xl:table-cell"><FailedKeywordNote id={r.id} note={r.note} /></td>
                    <td><FailedKeywordIgnoreToggle id={r.id} ignored={r.ignored} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
