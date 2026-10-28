import type { ScorePart } from "./types";

/**
 * Балл кластера 0–100 (ТЗ, раздел 4): каждый сигнал — строка «почему сейчас» с объяснением.
 * История Discover (GSC) появится на этапе 3, сейчас 0 с пометкой. Для категории brands — свои веса.
 */

export type ClusterFacts = {
  category: string | null;
  isTarget: boolean;
  /** Источники, присоединившиеся за последние ~2 прогона: вес источника суммируется. */
  recentWeighted: number;
  recentCount: number;
  /** Украинских сайтов за последний час. */
  recentUa: number;
  sourceCount: number;
  uaCount: number;
  worldCount: number;
  /** Лучшая сущность из нашего списка. */
  entityName: string | null;
  entityWeight: number;
  trend: { title: string; traffic: string } | null;
  visual: number | null;
  hasImage: boolean;
  hasPrice: boolean;
  sensitive: boolean;
  firstPublishedAt: Date;
  now: Date;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

function ago(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  return `${h} ${plural(h, "час", "часа", "часов")} назад`;
}

export function scoreCluster(f: ClusterFacts): { score: number; parts: ScorePart[] } {
  const brands = f.category === "brands";
  const W = brands
    ? { velocity: 10, trend: 0, niche: 30, history: 10, visual: 20, fresh: 15, price: 15 }
    : { velocity: 25, trend: 15, niche: 20, history: 15, visual: 10, fresh: 10, price: 0 };
  const parts: ScorePart[] = [];

  // Скорость: 1 источник = 1/5 веса, 5+ = весь вес; учитывается вес источника.
  const vel = Math.min(1, f.recentWeighted / 5);
  parts.push({
    key: "velocity", label: "Скорость", max: W.velocity, points: r1(W.velocity * vel),
    why: f.recentCount ? `${f.recentCount} ${plural(f.recentCount, "сайт написал", "сайта написали", "сайтов написали")} за последний час, всего ${f.sourceCount}` : `всего ${f.sourceCount} ${plural(f.sourceCount, "источник", "источника", "источников")}, новых за час нет`,
  });

  if (W.trend) {
    parts.push({
      key: "trend", label: "Трендовость", max: W.trend, points: f.trend ? W.trend : 0,
      why: f.trend
        ? `люди сейчас это ищут: «${f.trend.title}» в топе Google Trends Украины${f.trend.traffic ? `, ${f.trend.traffic} запросов` : ""}`
        : "в топ-20 Google Trends Украины этого нет — для шоубиза это обычно: интерес видно по скорости публикаций",
    });
  }

  const nicheCat = f.isTarget ? (brands ? 20 : 15) : 0;
  const nicheEnt = f.entityName ? Math.min(W.niche - (brands ? 20 : 15), (W.niche - (brands ? 20 : 15)) * (f.entityWeight / 2)) : 0;
  parts.push({
    key: "niche", label: "Соответствие нише", max: W.niche, points: r1(nicheCat + nicheEnt),
    why: `${f.category ? `категория ${f.category}` : "категория не определена"}${f.entityName ? `, сущность ${f.entityName} (вес ${f.entityWeight})` : ", сущности из списка нет"}`,
  });

  parts.push({ key: "history", label: "История Discover", max: W.history, points: 0, why: "данные Search Console подключаются на этапе 3" });

  const vis = ((f.visual ?? 2) - 1) / 4 * 0.7 + (f.hasImage ? 0.3 : 0);
  parts.push({ key: "visual", label: "Визуальность", max: W.visual, points: r1(W.visual * vis), why: `оценка ${f.visual ?? "—"}/5${f.hasImage ? ", у источника есть картинка" : ", картинки у источника нет"}` });

  const age = f.now.getTime() - f.firstPublishedAt.getTime();
  const fresh = age <= 2 * 3600_000 ? 1 : Math.max(0, 1 - (age - 2 * 3600_000) / (22 * 3600_000));
  parts.push({ key: "fresh", label: "Свежесть", max: W.fresh, points: r1(W.fresh * fresh), why: `первая публикация ${ago(age)}` });

  if (W.price) parts.push({ key: "price", label: "Цена и продажи в Украине", max: W.price, points: f.hasPrice ? W.price : 0, why: f.hasPrice ? "есть цена в гривнах или дата продаж" : "цены и даты продаж нет" });

  // Мировые звёзды интересны, когда о них пишут в Украине. Ранний сигнал «ещё нет в UA» — только если событие
  // подтвердили два и больше мировых медиа; одиночная заметка таблоида без украинских публикаций идёт ниже.
  if (f.uaCount === 0 && f.worldCount >= 2 && f.entityName) {
    parts.push({ key: "not_ua", label: "Ещё нет в UA", max: 15, points: 15, why: `пишут ${f.worldCount} мировых медиа, украинских публикаций пока нет — шанс выйти первыми` });
  } else if (f.uaCount === 0 && f.worldCount > 0) {
    parts.push({ key: "world_only", label: "Только мировые медиа", max: 0, points: -10, why: "одна мировая публикация, в Украине не пишут — ждём подтверждения" });
  }
  if (f.sensitive) parts.push({ key: "sensitive", label: "Чувствительная тема", max: 0, points: -30, why: "проверь уместность для бьюти-сайта" });
  if (f.sourceCount > 15) parts.push({ key: "saturated", label: "Насыщенность", max: 0, points: -10, why: `уже ${f.sourceCount} источников — нужен сильный угол` });

  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((a, p) => a + p.points, 0))));
  return { score: f.isTarget ? score : 0, parts };
}

/**
 * Важность для редактора: «Обязательно» / «Стоит взять» / «По желанию» — по тем же сигналам, с причинами словами.
 * Обязательно: балл срочности, или 3+ украинских сайта за час, или тренд Google, или звезда первого ряда пишется прямо сейчас,
 * или мировое событие о нашей звезде ещё не вышло в Украине.
 */
export function priorityOf(f: ClusterFacts, score: number, urgentScore: number, topWeight: number): { priority: string; why: string[] } {
  const why: string[] = [];
  const top = !!f.entityName && f.entityWeight >= topWeight;
  const ageH = (f.now.getTime() - f.firstPublishedAt.getTime()) / 3600_000;
  let must = false;
  if (score >= urgentScore) {
    must = true;
    why.push(`балл ${score} — выше порога срочности ${urgentScore}`);
  }
  if (f.recentUa >= 3) {
    must = true;
    why.push(`${f.recentUa} украинских сайтов написали за последний час — тема разгоняется, конкуренты уже в выдаче`);
  }
  if (f.trend) {
    must = true;
    why.push(`запрос «${f.trend.title}» в топе Google Trends Украины — люди ищут прямо сейчас`);
  }
  if (top && f.uaCount >= 2 && ageH <= 6) {
    must = true;
    why.push(`${f.entityName} — звезда первого ряда для сайта, о ней пишут ${f.uaCount} сайта в первые часы`);
  }
  if (f.uaCount === 0 && f.worldCount >= 2 && f.entityWeight >= 1.2) {
    must = true;
    why.push(`о ${f.entityName} пишут ${f.worldCount} мировых медиа, в Украине ещё никто — можно выйти первыми`);
  }
  if (must) return { priority: "must", why };
  if (score >= 45 || top) {
    if (top) why.push(`${f.entityName} стабильно собирает трафик у сайта`);
    if (score >= 45) why.push(`балл ${score}: тема в нише и свежая, но без признаков взрыва интереса`);
    return { priority: "should", why };
  }
  why.push(f.sourceCount <= 1 ? "пока одна публикация и нет сущности первого ряда — может не взлететь" : `балл ${score}: интерес умеренный`);
  if (!f.entityName) why.push("героя нет в списке сущностей сайта — Discover слабее связывает такую статью с интересами читателей");
  return { priority: "maybe", why };
}
