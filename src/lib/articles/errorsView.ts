/**
 * Подробный разбор ошибок конвейера статей для журнала, страницы запуска и сайта.
 *
 * Два источника:
 *  - ArtError — окончательные ошибки (статья упала в FAILED, ошибки модерации и ИИ-модерации). Группируем по сигнатуре
 *    (текст без чисел/id/URL — считает worker/articles/journal.ts errorSignature).
 *  - ArtStageLog со status=error и текстом «Временная ошибка, повтор через …» — временные сбои, которые воркер повторил сам.
 *    В ArtError они не попадают, но показывают, где конвейер «спотыкается» и теряет время/деньги.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { ArtStatus, Prisma } from "@prisma/client";
import { artSiteWhere } from "./access";
import { STATUS_LABELS, type Tone } from "./labels";

/** Понятные названия и подсказки частых ошибок (оригинал ErrorsPage.tsx:31-52, адаптировано к текстам наших этапов). */
export const KNOWN_ERRORS: Array<{ re: RegExp; title: string; hint: string; kind: "bug" | "external" }> = [
  { re: /sections still empty|пустые секции|incomplete content|не дописал/i, kind: "bug", title: "ИИ не дописал часть секций текста", hint: "Обычно разовый сбой модели. «Вернуть в работу» — готовые секции сохранятся." },
  { re: /лимиту токенов|finish_reason=length|оборвался/i, kind: "bug", title: "Ответ ИИ оборвался (слишком длинный)", hint: "Разовый сбой. «Вернуть в работу» обычно помогает." },
  { re: /не подставлены переменные|Нет промта для шага/i, kind: "bug", title: "Промт сценария не готов", hint: "Откройте сценарий → Промты: добавьте промт шага или уберите неизвестные переменные. Затем «Вернуть в работу»." },
  { re: /не удалось скачать фото/i, kind: "external", title: "Сайт-источник не отдал фото", hint: "Чужой сайт блокирует скачивание. Выберите другое фото." },
  { re: /Мало фото|не хватило фото|WAITING_FOR_PHOTOS/i, kind: "external", title: "Не хватает хороших фото", hint: "Не поломка. Статья в разделе «Мало фото»: добрать фото или отложить." },
  { re: /BILLING|баланс|402|insufficient|no_credits|закончился/i, kind: "external", title: "У ИИ-провайдера закончились деньги", hint: "Пополните баланс или включите другой ключ в разделе «Ключи». Статьи вернутся в работу кнопкой." },
  { re: /401|ключ отклон|auth|нет правила|no_binding|Не назначен ключ|Нет рабочего ключа/i, kind: "external", title: "Ключ ИИ не назначен или отклонён", hint: "Проверьте на странице ключа галочку «Статьи» и слот. Затем «Вернуть в работу»." },
  { re: /429|rate limit|лимит запросов|слишком много/i, kind: "external", title: "Провайдер ограничил частоту запросов", hint: "Временно. Воркер повторит сам; если висит — «Вернуть в работу»." },
  { re: /All providers failed|AI не ответил|timeout|таймаут|ECONN|fetch failed/i, kind: "bug", title: "Модель ИИ или сеть не ответили", hint: "Временный сбой. Если много подряд — сообщите. Иначе «Вернуть в работу»." },
  { re: /media|upload|wp-json|WordPress|HTTP 5\d\d|rest_/i, kind: "external", title: "Ошибка сайта WordPress при публикации", hint: "Проблема на стороне хостинга (место, права, PHP) или доступа. Проверьте сайт в разделе «Сайты» → «Проверить»." },
];
export const explainError = (msg: string) => KNOWN_ERRORS.find((k) => k.re.test(msg)) ?? null;

/** Подписи «этапов» ошибок, которых нет в реестре этапов. */
export const EXTRA_ERROR_STAGES: Record<string, string> = { moderation: "Модерация", ai_moderation: "ИИ-модерация" };

export type ErrorState = "open" | "resolved" | "all";

export type ErrorFilter = {
  siteId?: string;
  runId?: string;
  stage?: string;
  since?: Date;
  state?: ErrorState;
  signature?: string;
};

/** Условие видимости + фильтра для ArtError (то же правило, что errorGroupWhere в actions/articlesModeration.ts). */
export async function errorWhere(me: CurrentUser, f: ErrorFilter): Promise<Prisma.ArtErrorWhereInput> {
  const and: Prisma.ArtErrorWhereInput[] = [];
  if (me.role !== "ADMIN") {
    const sites = await prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true } });
    and.push({ OR: [{ siteId: { in: sites.map((s) => s.id) } }, { siteId: null, teamId: { in: me.teamIds } }] });
  }
  if (f.siteId) and.push({ siteId: f.siteId });
  if (f.runId) and.push({ article: { runId: f.runId } });
  if (f.stage) and.push({ stage: f.stage });
  if (f.since) and.push({ createdAt: { gte: f.since } });
  if (f.signature) and.push({ signature: f.signature });
  const state = f.state ?? "open";
  if (state === "open") and.push({ resolvedAt: null });
  if (state === "resolved") and.push({ resolvedAt: { not: null } });
  return and.length ? { AND: and } : {};
}

export type ErrorArticle = {
  id: string; keyword: string; siteId: string; runId: string | null; status: ArtStatus; statusLabel: string; tone: Tone;
  stage: string; note: string | null; count: number; lastAt: string;
};

export type ErrorGroupView = {
  signature: string; stage: string; count: number; open: number; first: string; last: string;
  sample: string; title: string | null; hint: string | null; kind: "bug" | "external" | null;
  sites: Array<{ id: string; name: string }>;
  articles: ErrorArticle[];
  /** Сколько затронутых статей сейчас в FAILED (их вернёт «Вернуть в работу») */
  failedNow: number;
  /** Сколько затронутых статей уже опубликовано (ошибка была, но статья дошла) */
  recovered: number;
};

/** Группы ошибок по сигнатуре с затронутыми статьями. */
export async function errorGroups(me: CurrentUser, f: ErrorFilter, take = 5000): Promise<ErrorGroupView[]> {
  const rows = await prisma.artError.findMany({
    where: await errorWhere(me, f), orderBy: { createdAt: "desc" }, take,
    select: { signature: true, stage: true, message: true, siteId: true, articleId: true, createdAt: true, resolvedAt: true },
  });
  if (!rows.length) return [];
  const artIds = [...new Set(rows.map((r) => r.articleId).filter((x): x is string => !!x))];
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is string => !!x))];
  const [arts, sites] = await Promise.all([
    artIds.length ? prisma.article.findMany({ where: { id: { in: artIds } }, select: { id: true, keyword: true, siteId: true, runId: true, status: true, stage: true, note: true } }) : [],
    siteIds.length ? prisma.artSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [],
  ]);
  const artMap = new Map(arts.map((a) => [a.id, a]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  type Acc = { g: ErrorGroupView; arts: Map<string, ErrorArticle>; sites: Set<string> };
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    // rows идут от новых к старым: первая встреченная строка группы — самая свежая (её текст — образец).
    let acc = groups.get(r.signature);
    if (!acc) {
      const ex = explainError(r.message);
      acc = {
        g: { signature: r.signature, stage: r.stage, count: 0, open: 0, first: r.createdAt.toISOString(), last: r.createdAt.toISOString(), sample: r.message, title: ex?.title ?? null, hint: ex?.hint ?? null, kind: ex?.kind ?? null, sites: [], articles: [], failedNow: 0, recovered: 0 },
        arts: new Map(), sites: new Set(),
      };
      groups.set(r.signature, acc);
    }
    const g = acc.g;
    g.count++;
    if (!r.resolvedAt) g.open++;
    g.first = r.createdAt.toISOString();
    if (r.siteId) acc.sites.add(r.siteId);
    const a = r.articleId ? artMap.get(r.articleId) : undefined;
    if (a) {
      const ea = acc.arts.get(a.id) ?? { id: a.id, keyword: a.keyword, siteId: a.siteId, runId: a.runId, status: a.status, statusLabel: STATUS_LABELS[a.status].label, tone: STATUS_LABELS[a.status].tone, stage: a.stage, note: a.note, count: 0, lastAt: r.createdAt.toISOString() };
      ea.count++;
      acc.arts.set(a.id, ea);
    }
  }
  return [...groups.values()]
    .map(({ g, arts: am, sites: ss }) => {
      g.articles = [...am.values()].sort((x, y) => y.lastAt.localeCompare(x.lastAt));
      g.sites = [...ss].map((id) => ({ id, name: siteName.get(id) ?? id.slice(0, 8) }));
      g.failedNow = g.articles.filter((a) => a.status === "FAILED").length;
      g.recovered = g.articles.filter((a) => a.status === "COMPLETED").length;
      return g;
    })
    .sort((x, y) => (y.open > 0 ? 1 : 0) - (x.open > 0 ? 1 : 0) || y.last.localeCompare(x.last));
}

/* ───────── Временные сбои (повторы этапов) ───────── */

export type RetryGroup = {
  stage: string; key: string; count: number; articles: number; last: string; sample: string; title: string | null;
  /** Статьи, которые прямо сейчас ждут повтора (Article.note «Повтор этапа …») */
  waitingNow: Array<{ id: string; keyword: string; note: string }>;
};

/** Нормализация текста ошибки для группировки (как errorSignature в worker/articles/journal.ts). */
function normalize(msg: string): string {
  return msg
    .replace(/^Временная ошибка, повтор через \d+ с:\s*/i, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Повторы этапов (временные ошибки, которые воркер повторил сам) для набора статей. */
export async function retryGroups(articleWhere: Prisma.ArticleWhereInput, since?: Date, take = 3000): Promise<RetryGroup[]> {
  const logs = await prisma.artStageLog.findMany({
    where: { status: "error", error: { startsWith: "Временная ошибка" }, article: articleWhere, ...(since ? { startedAt: { gte: since } } : {}) },
    orderBy: { startedAt: "desc" }, take,
    select: { stage: true, error: true, startedAt: true, articleId: true, article: { select: { keyword: true, note: true, status: true } } },
  });
  const m = new Map<string, RetryGroup & { ids: Set<string> }>();
  for (const l of logs) {
    const text = (l.error ?? "").replace(/^Временная ошибка, повтор через \d+ с:\s*/i, "");
    const key = `${l.stage}: ${normalize(l.error ?? "")}`;
    const g = m.get(key) ?? { stage: l.stage, key, count: 0, articles: 0, last: l.startedAt.toISOString(), sample: text, title: explainError(text)?.title ?? null, waitingNow: [], ids: new Set<string>() };
    g.count++;
    if (!g.ids.has(l.articleId)) {
      g.ids.add(l.articleId);
      const note = l.article.note ?? "";
      if (l.article.status === "PENDING" && note.startsWith("Повтор этапа")) g.waitingNow.push({ id: l.articleId, keyword: l.article.keyword, note });
    }
    m.set(key, g);
  }
  return [...m.values()].map(({ ids, ...g }) => ({ ...g, articles: ids.size })).sort((a, b) => b.count - a.count);
}

/** Короткая сводка для виджета на странице запуска/сайта. */
export type ErrorsSummary = { groups: ErrorGroupView[]; open: number; total: number; retries: RetryGroup[]; retryCount: number };

export async function errorsSummary(me: CurrentUser, f: ErrorFilter, articleWhere: Prisma.ArticleWhereInput): Promise<ErrorsSummary> {
  const [groups, retries] = await Promise.all([errorGroups(me, { ...f, state: "all" }), retryGroups(articleWhere, f.since)]);
  return {
    groups, open: groups.reduce((s, g) => s + g.open, 0), total: groups.reduce((s, g) => s + g.count, 0),
    retries, retryCount: retries.reduce((s, r) => s + r.count, 0),
  };
}
