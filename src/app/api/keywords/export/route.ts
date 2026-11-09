import { prisma } from "@/lib/db";
import { keywordsUser } from "@/lib/keywords/access";
import { competitors } from "@/lib/keywords/competitors";
import { FIELDS } from "@/lib/keywords/fields";
import { keywordOrder, keywordWhere, toTableRow, type Tab } from "@/lib/keywords/query";
import { flagLabel, NICHES, nicheLabel, nicheScenario, seasonLabel, sourceLabel, statusLabel, verdictLabel, type KwMetrics } from "@/lib/keywords/types";

export const dynamic = "force-dynamic";

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(";")).join("\n");
const pct = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? `${Math.round((100 * a) / b)}%` : "");

/**
 * GET /api/keywords/export?tab=main|new&<фильтры как на экране>[&format=articles] → CSV (разделитель «;»).
 * format=articles — колонки листа Google Таблицы для запуска статей: Keyword / SEO Keyword / Focus Keyword / Сценарий / Режим.
 * format=competitors — вкладка «Конкуренты» (niche, kind, q), колонки как в paste_comp.tsv прототипа.
 */
export async function GET(req: Request) {
  const me = await keywordsUser();
  if (!me) return new Response("Нет доступа", { status: 401 });
  const p = Object.fromEntries(new URL(req.url).searchParams);
  const tab: Tab = p.tab === "new" ? "new" : "main";
  const now = new Date();
  if (p.format === "competitors") {
    const { rows } = await competitors({ niche: p.niche, kind: p.kind, q: p.q }, now);
    const out: unknown[][] = [[
      "Домен", "Тип", "В топ-10 ключей", "В топ-10 ключей %", "Пинов в топ-10 всего", "Средняя позиция в топ-10", "Суммарная частотность их ключей",
      ...NICHES.flatMap((n) => [`${n.label} (ключей)`, `${n.label} %`]),
      "Медиана сохранений их пинов", "Самая свежая статья (мес)", "Самая старая статья (мес)", "Средний возраст статей (мес)", "Статей с датой", "Статей с датой %", "Примеры ключей",
    ]];
    for (const r of rows) {
      out.push([
        r.host, r.kind === "platform" ? "платформа/магазин" : "сайт/блог", r.kws, `${r.kwsPct}%`, r.pins, r.avgPos, r.vol,
        ...NICHES.flatMap((n) => [r.niches[n.key], r.kws ? `${Math.round((100 * r.niches[n.key]) / r.kws)}%` : ""]),
        r.medSaves ?? "", r.ageNewest ?? "", r.ageOldest ?? "", r.ageAvg ?? "", r.dated, `${r.datedPct}%`, r.examples.join("; "),
      ]);
    }
    return new Response(csv(out), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="keywords_competitors_${now.toISOString().slice(0, 10)}.csv"` } });
  }
  const rows = await prisma.kwKeyword.findMany({ where: keywordWhere(tab, p, now), orderBy: keywordOrder(p), take: 20_000 });
  const accounts = new Map((await prisma.kwAccount.findMany({ select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const stamp = now.toISOString().slice(0, 10);
  const file = (name: string, body: string) => new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}_${stamp}.csv"` } });

  if (p.format === "articles") {
    const out: unknown[][] = [["Keyword", "SEO Keyword", "Focus Keyword", "Сценарий", "Режим"]];
    for (const r of rows) out.push([r.articleKeyword ?? `${r.phrase} 2027`, r.seoKeyword ?? `${r.phrase} 2027`, r.phrase, r.scenario ?? nicheScenario(r.niche), r.mode ?? "2"]);
    return file("keywords_articles", csv(out));
  }

  // Полная выгрузка: служебные колонки + каждая метрика реестра (как в таблице: число и, где есть, количество) + тексты.
  const head: unknown[] = ["Ключ", "Ниша", "Источник", "Сезонность", "Статус", "Вердикт", "Прошлый вердикт", "Флаги", "Ищут с годом", "Выдача снята с аккаунта", "Дата снимка"];
  for (const f of FIELDS) {
    if (f.count) head.push(`${f.label} (шт)`);
    head.push(`${f.label}${f.unit ? `, ${f.unit}` : ""}`);
  }
  head.push("Вариация 1", "Вариация 2", "Вариация 3", "Вариация 4", "Вариация 5", "Подсказки поиска", "Уточнения", "Топ-10: ссылка | дата пина | сохранения | заголовок статьи | слов");
  const out: unknown[][] = [head];
  for (const r of rows) {
    const m = r.metrics as KwMetrics | null;
    const tr = toTableRow(r as unknown as Record<string, unknown>, accounts, now);
    const line: unknown[] = [
      r.phrase, nicheLabel(r.niche), sourceLabel(r.source), seasonLabel(r.season), statusLabel(r.status), verdictLabel(r.verdict), verdictLabel(r.prevVerdict),
      r.flags ? r.flags.split(",").map(flagLabel).join(", ") : "", r.withYear ? "да" : "", tr.account ?? "", r.serpAt?.toISOString().slice(0, 10) ?? "",
    ];
    for (const f of FIELDS) {
      if (f.count) line.push(tr.counts[f.count] ?? "");
      const v = f.key === "volume" && r.volNone ? 0 : tr.v[f.key];
      line.push(v == null ? "" : f.unit === "%" ? Math.round(v) : v);
    }
    line.push(...[...(m?.variants ?? []), "", "", "", "", ""].slice(0, 5), (m?.suggestions ?? []).join("; "), (m?.guides ?? []).join(", "),
      (m?.top ?? []).map(([u, d, s], i) => { const x = m?.topArt?.[i]; return `${u || "без ссылки"} | ${d} | ${s}${x ? ` | ${x.title ?? ""} | ${x.words ?? ""}` : ""}`; }).join(" || "));
    out.push(line);
  }
  return file(tab === "new" ? "keywords_new" : "keywords", csv(out));
}
