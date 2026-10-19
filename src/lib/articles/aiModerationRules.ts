/**
 * Чистые правила решения ИИ-модерации фото (mix3) — без базы и без запросов к моделям, чтобы их можно было
 * проверить на сохранённых ответах моделей (`review.v3`). Вызывает `reviewArticle` в `./aiModeration.ts`.
 *
 * Правки по аудиту 2026-10-14 (docs/articles-migration/audit-2026-10-14/ai-moderation.md):
 *  - удаление фото — только по двум сигналам: обе модели или повторная проверка (спор); одна модель против «ок»
 *    другой → всегда спор, в том числе «не та деталь / не по теме» дешёвой модели (раньше молча оставлялись);
 *  - добавление сверх нормы — только явно сильные кадры (обе модели «за»), до 60 фото в статье, без повторов человека/фотосессии;
 *  - уверенность считается из согласия моделей, «проверки сильно расходятся» — только при 3+ замечаниях;
 *  - смысл ключа («MUST show») — словарь известных трендов, иначе дешёвое определение моделью (кэш в Article.facts).
 *
 * Круг 2 (docs/articles-migration/audit-2026-10-14/ai-moderation-v2.md → ai-moderation-fixes-v3.md, mix3.3):
 *  - словарь склеивает все совпавшие части ключа (curly + shag), составные chrome french / micro french и др.;
 *  - проход «крупно» (дешёвая модель, кадр двумя половинами): водяные знаки и признаки ИИ — третий сигнал;
 *  - спор видит уже убранные фото и (при «не по теме») оставленные — похожие решаются одинаково (`same_as`);
 *  - сверх нормы — только когда обе модели за кадр, порог относительный (процентиль оценок статьи);
 *  - «больше 30% убрано» не ведёт людям, если все удаления подтверждены двумя сигналами и норма набрана.
 *
 * Круг 3 (docs/articles-migration/audit-2026-10-14/ai-moderation-v3.md → ai-moderation-fixes-v4.md, mix3.4):
 *  - перепроверка «по аналогии» убрана (0 изменений за круг, ~$0.0015 на статью); спор видит только спорные фото;
 *  - спор один не отменяет сильную отметку «ИИ»: flash `ai_fake` с оценкой ≤ 40 (или обе модели) + «keep» спора = ничья → убрать;
 *  - словарь ключа не теряет слова без записи (almond, bob, white…), пустое определение → буквальные слова ключа;
 *  - сверх нормы — 1 фото на статью, дальше только оценка flash ≥ 90 и lite «ок»; похожие варианты (`like`) не берём;
 *  - «проверки сильно расходятся» — только отмены, где за удаление была основная модель (не «крупно» и не одна lite).
 */

/** Причины, по которым фото убирается (оригинал V2_HARD) + водяной знак/логотип. */
export const REMOVE_REASONS = new Set(["off_topic", "wrong_detail", "ai_fake", "watermark_logo", "collage_text", "catalogue", "wrong_audience", "duplicate"]);
/** Тяжёлые причины, при которых кандидат резерва не добавляется (оригинал SEVERE) — дубль проверяется отдельно. */
export const SEVERE_REASONS = new Set(["off_topic", "wrong_detail", "ai_fake", "watermark_logo", "wrong_audience", "collage_text", "catalogue"]);
/** Причины «не по теме» — их большая доля ведёт людям с понятной причиной. */
const TOPIC_REASONS = /^(off_topic|wrong_detail)\b/;

/**
 * Сверх нормы: правило владельца 2026-10-16 — «если ИИ нашёл классные фото, не ограничивай», но в статье не больше
 * MAX_ARTICLE_PHOTOS (было: норма + 30%, затем +1). Качество держат порог extraThreshold и согласие обеих моделей.
 */
export const MAX_ARTICLE_PHOTOS = 60;
/**
 * Аудит круга 3 (short gel: +4 сверх нормы, 3 из них почти одинаковый нюд): сверх нормы — не больше 1 фото на статью
 * по обычному порогу; каждое следующее — только оценка flash ≥ EXTRA_STRONG_SCORE и lite «ок».
 */
export const EXTRA_FREE = Number.POSITIVE_INFINITY;
export const EXTRA_STRONG_SCORE = 90;
/**
 * Отметка `ai_fake` основной модели с оценкой не выше этой — сильная: «keep» спора её не отменяет, это ничья → фото
 * убирается (аудит круга 3, space buns: спор оставил 3 верные отметки ИИ с оценками 28–35).
 */
export const AI_TIE_MAX_SCORE = 40;
/**
 * Добавление сверх нормы: оценка не ниже max(85, средняя оставленных + 5, 80-й процентиль оставленных + 1).
 * Аудит круга 2: средняя модель ставит 78–83 почти всем, абсолютный порог 85 срабатывал случайно — процентиль
 * пускает сверх нормы только кадры сильнее 80% уже стоящих в статье.
 */
export const EXTRA_MIN_SCORE = 85;
export const EXTRA_OVER_AVG = 5;
export const EXTRA_PERCENTILE = 0.8;
/** Оценка дешёвой модели (если она её дала) для добавления сверх нормы. */
export const EXTRA_LITE_MIN = 70;
/** Удалено больше этой доли — людям всегда, даже если все удаления подтверждены. */
export const HUMAN_DROP_SHARE_HARD = 0.5;
/** Столько фото после модерации и больше — статья одобряется автоматически, без людей (владелец 2026-10-16). */
export const AUTO_APPROVE_MIN_PHOTOS = 15;
/** Добор до нормы: оценка средней модели не ниже 50. */
export const MUST_MIN_SCORE = 50;

/** Мнение модели о фото; `like` — id фото, на которое кадр очень похож по виду (не дубль, но тот же простой вариант). */
export type Judge = { reason: string; score: number | null; why: string; dupOf: string; like?: string };
export type Judgements = Map<string, Judge>;

export const cat = (x: unknown) => String(x || "ok").toLowerCase().replace(/[^a-z_]/g, "") || "ok";

/** Ответ модели {"photos":[…]} → карта по id (S1/R2). */
export function judgementsOf(out: Record<string, unknown> | null | undefined): Judgements {
  const list = (out?.photos as Array<Record<string, unknown>> | undefined) ?? [];
  const m: Judgements = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    const id = String(p?.id || "").toUpperCase().trim();
    if (!id) continue;
    const s = Number(p?.score);
    const like = String(p?.like || "").toUpperCase().trim();
    m.set(id, { reason: cat(p?.reason), score: Number.isFinite(s) ? s : null, why: String(p?.why || "").slice(0, 160), dupOf: String(p?.dup_of || "").toUpperCase().trim(), ...(/^[SR]\d+$/.test(like) && like !== id ? { like } : {}) });
  }
  return m;
}

const NONE: Judge = { reason: "ok", score: null, why: "", dupOf: "" };
const get = (m: Judgements, id: string) => m.get(id) ?? NONE;
/** Оценка средней модели (её шкала основная); нет оценки — 60, как в оригинале. */
export const scoreOf = (M: Judgements, id: string) => get(M, id).score ?? 60;

/** Процентиль (0..1) списка чисел, линейная интерполяция; пустой список — null. */
export function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = Math.max(0, Math.min(1, q)) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/* ───────────────────────── 0. Проход «крупно»: водяные знаки ───────────────────────── */

/**
 * Находка прохода «крупно» по фото: watermark — текст/логотип/@ник; part — половина кадра.
 * `ai` — только в ответах mix3.3: за круг 3 вопрос про ИИ не сработал ни разу (27 находок, все — подписи),
 * с mix3.4 его нет в промте и такие находки не учитываются.
 */
export type DetailFlag = { kind: "watermark" | "ai"; text: string; part: 0 | 1 | null };
export type DetailFlags = Map<string, DetailFlag>;

/** Ответ прохода «крупно» {"photos":[{"id":"S3","flag":"watermark","text":"@nick","part":2}]} → карта по id. */
export function parseDetailFlags(out: Record<string, unknown> | null | undefined): DetailFlags {
  const list = (out?.photos as Array<Record<string, unknown>> | undefined) ?? [];
  const m: DetailFlags = new Map();
  for (const p of Array.isArray(list) ? list : []) {
    const id = String(p?.id || "").toUpperCase().trim();
    const f = String(p?.flag || "").toLowerCase();
    if (!/^[SR]\d+$/.test(id) || f !== "watermark") continue;
    const part = Number(p?.part);
    // Водяной знак без прочитанного текста/описания — не сигнал (модель «на всякий случай» отмечает фон).
    const text = String(p?.text || p?.why || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) continue;
    if (!m.has(id)) m.set(id, { kind: "watermark", text, part: part === 1 ? 0 : part === 2 ? 1 : null });
  }
  return m;
}

/**
 * Находки прохода «крупно» добавляются к мнению дешёвой модели как отдельный сигнал: где она сказала «ок»,
 * становится watermark_logo / ai_fake. Тогда: совпало со средней моделью → два сигнала, удаление;
 * средняя «ок» → спор; кандидат резерва с находкой не добавляется (SEVERE). Другие замечания дешёвой модели не трогаем.
 */
export function mergeDetailFlags(A: Judgements, W: DetailFlags): Judgements {
  const out: Judgements = new Map(A);
  for (const [id, f] of W) {
    const a = out.get(id) ?? NONE;
    if (a.reason !== "ok") continue;
    out.set(id, { ...a, reason: f.kind === "watermark" ? "watermark_logo" : "ai_fake", why: `крупно: ${f.text}`.slice(0, 160) });
  }
  return out;
}

/* ───────────────────────── 1. Фото статьи: согласие, спор, удаление ───────────────────────── */

export type SVerdict = {
  /** удаляются сразу: обе модели за удаление */
  drops: Map<string, string>;
  /** одна модель за удаление, другая «ок» — нужен спор */
  disputed: string[];
  /** кто был за удаление в споре: lite | flash */
  disputedBy: Record<string, "lite" | "flash">;
  /** замечание без удаления (слабое фото, оценка ≥ 50) — остаётся, в «расхождения» не засчитывается */
  autoKept: Array<{ id: string; why: string }>;
  /** фото, где модели согласны (обе ок или обе за удаление) */
  agreed: number;
  /** фото хотя бы с одним замечанием «убрать» */
  flags: string[];
  /** фото, которые хотела убрать основная модель (для «проверки сильно расходятся») */
  flashFlags: string[];
};

/** Хочет ли средняя модель убрать фото: твёрдая причина или слабый кадр с оценкой ниже 50. */
export function flashWantsRemove(j: Judge): boolean {
  if (REMOVE_REASONS.has(j.reason)) return true;
  return j.reason === "weak_pin" && (j.score ?? 60) < MUST_MIN_SCORE;
}
/** Хочет ли дешёвая модель убрать фото (она судит только тему/подлинность — weak_pin от неё не причина). */
export function liteWantsRemove(j: Judge): boolean {
  return REMOVE_REASONS.has(j.reason);
}

const whyOf = (j: Judge) => `${j.reason}: ${j.why || j.reason}`.slice(0, 160);

export function classifyArticlePhotos(sIds: string[], A: Judgements, M: Judgements): SVerdict {
  const v: SVerdict = { drops: new Map(), disputed: [], disputedBy: {}, autoKept: [], agreed: 0, flags: [], flashFlags: [] };
  for (const id of sIds) {
    const a = get(A, id), m = get(M, id);
    const la = liteWantsRemove(a), fm = flashWantsRemove(m);
    if (fm) v.flashFlags.push(id);
    if (la && fm) {
      v.agreed++;
      v.flags.push(id);
      v.drops.set(id, whyOf(REMOVE_REASONS.has(m.reason) ? m : a));
    } else if (la || fm) {
      v.flags.push(id);
      v.disputed.push(id);
      v.disputedBy[id] = fm ? "flash" : "lite";
    } else {
      v.agreed++;
      if (m.reason === "weak_pin") v.autoKept.push({ id, why: `слабое фото, оценка ${scoreOf(M, id)} — оставлено` });
    }
  }
  // Пара фото, где каждое названо дублем другого: одно (с лучшей оценкой) оставляем без замечания.
  const dupTarget = (id: string) => [get(M, id), get(A, id)].find((j) => j.reason === "duplicate" && j.dupOf)?.dupOf || "";
  const marked = (id: string) => v.drops.has(id) || v.disputed.includes(id);
  for (const id of [...v.flags]) {
    const t = dupTarget(id);
    if (!t || t === id || !marked(id) || !marked(t) || dupTarget(t) !== id) continue;
    const keep = scoreOf(M, id) >= scoreOf(M, t) ? id : t;
    v.drops.delete(keep);
    v.disputed = v.disputed.filter((x) => x !== keep);
    delete v.disputedBy[keep];
    v.flags = v.flags.filter((x) => x !== keep);
    v.flashFlags = v.flashFlags.filter((x) => x !== keep);
  }
  return v;
}

/** Убирают больше 35% — все удаления тоже на подтверждение (оригинал :874). */
export function removalsNeedConfirm(v: SVerdict, total: number): string[] {
  return v.drops.size / Math.max(1, total) > 0.35 ? [...v.drops.keys()] : [];
}

/** Ответ спора. `sameAs` — поле mix3.3 («по аналогии»), с mix3.4 не используется, но читается из старых ответов. */
export type DisputeAnswer = { ok: boolean; drop: Map<string, string>; keep: Set<string>; sameAs: Map<string, string> };

export function parseDispute(out: Record<string, unknown> | null | undefined, ok: boolean): DisputeAnswer {
  const raw = Array.isArray(out?.drop) ? (out!.drop as Array<{ id?: string; why?: string; same_as?: string }>) : [];
  const drop = new Map<string, string>(raw.map((d) => [String(d?.id || "").toUpperCase().trim(), String(d?.why || "").slice(0, 160)]));
  const sameAs = new Map<string, string>(raw.filter((d) => d?.same_as).map((d) => [String(d?.id || "").toUpperCase().trim(), String(d?.same_as || "").toUpperCase().trim()]));
  const keep = new Set<string>((Array.isArray(out?.keep) ? (out!.keep as unknown[]) : []).map((x) => String(x || "").toUpperCase().trim()));
  return { ok, drop, keep, sameAs };
}

export type Resolution = {
  drops: Map<string, string>;
  /** снятые замечания для экрана (спор оставил фото + слабые фото) */
  overturned: Array<{ id: string; why: string }>;
  /** спорные, которые спор оставил (настоящее расхождение) */
  keptAfterDispute: number;
  /** из них — где за удаление была основная модель (только они идут в «проверки сильно расходятся») */
  flashOverturned: number;
  /** спорные, по которым спор подтвердил удаление */
  droppedAfterDispute: number;
  /** спор не ответил — спорные фото оставлены, решение людям */
  unresolved: number;
  /** сильная отметка «ИИ», которую спор хотел оставить: ничья → убрано (при недоборе нормы — людям) */
  tieDrops: string[];
  /** удаления с одним сигналом против явного «оставить» спора (ничьи по ИИ): при большой доле удалений решает человек */
  singleSignalDrops: number;
};

/**
 * Сильная отметка «ИИ»: основная модель сказала `ai_fake` с оценкой ≤ AI_TIE_MAX_SCORE, или обе модели (без «крупно»)
 * сказали `ai_fake`. `liteOwn` — ответ дешёвой модели без находок прохода «крупно».
 */
export function strongAiFlag(id: string, M: Judgements, liteOwn: Judgements): boolean {
  const m = get(M, id);
  if (m.reason !== "ai_fake") return false;
  return (m.score ?? 60) <= AI_TIE_MAX_SCORE || get(liteOwn, id).reason === "ai_fake";
}

/**
 * Итог по фото статьи после спора. Спорное фото убирается, если спор сказал drop (второй сигнал); удаление
 * «на подтверждение» остаётся, если спор явно не оставил фото (keep). Без ответа спора спорные остаются.
 * Аудит круга 3: «keep» спора против сильной отметки «ИИ» (`strongAiFlag`) — ничья, фото убирается (`tieDrops`).
 * `liteOwn` — ответ lite без находок «крупно» (по умолчанию A).
 */
export function resolveDisputes(v: SVerdict, confirm: string[], M: Judgements, A: Judgements, d: DisputeAnswer, liteOwn: Judgements = A): Resolution {
  const drops = new Map(v.drops);
  const overturned: Array<{ id: string; why: string }> = [...v.autoKept];
  const tieDrops: string[] = [];
  let keptAfterDispute = 0, flashOverturned = 0, droppedAfterDispute = 0, unresolved = 0;
  const tie = (id: string) => {
    tieDrops.push(id);
    const m = get(M, id);
    drops.set(id, `ai_fake: ${m.why || "похоже на ИИ"} (основная модель ${m.score ?? "—"}, спор оставил — ничья, убрано)`.slice(0, 160));
  };
  for (const id of v.disputed) {
    if (!d.ok) { unresolved++; overturned.push({ id, why: "спор не состоялся — оставлено" }); continue; }
    if (d.drop.has(id)) {
      droppedAfterDispute++;
      const side = v.disputedBy[id] === "flash" ? get(M, id) : get(A, id);
      drops.set(id, `${side.reason}: ${d.drop.get(id) || side.why || side.reason}`.slice(0, 160));
    } else if (v.disputedBy[id] === "flash" && strongAiFlag(id, M, liteOwn)) {
      tie(id);
    } else {
      keptAfterDispute++;
      if (v.disputedBy[id] === "flash") flashOverturned++;
      overturned.push({ id, why: `оставлено после спора (${v.disputedBy[id] === "flash" ? "основная" : "дешёвая"} модель: ${get(v.disputedBy[id] === "flash" ? M : A, id).reason})` });
    }
  }
  for (const id of confirm) {
    if (!(d.ok && d.keep.has(id) && !d.drop.has(id))) continue;
    // Обе модели за удаление, спор «оставить»: сильная отметка ИИ — ничья (фото остаётся убранным), остальное — отмена.
    if (strongAiFlag(id, M, liteOwn)) { tieDrops.push(id); continue; }
    drops.delete(id);
    if (flashWantsRemove(get(M, id))) flashOverturned++;
    overturned.push({ id, why: "удаление не подтверждено при споре" });
  }
  return { drops, overturned, keptAfterDispute, flashOverturned, droppedAfterDispute, unresolved, tieDrops, singleSignalDrops: tieDrops.length };
}

/* ───────────────────────── 2. Резерв: добор до нормы и сильные сверх неё (≤ 60) ───────────────────────── */

/** Предел фото в статье после модерации: MAX_ARTICLE_PHOTOS (норма больше предела — сама норма). */
export const overNormCap = (needed: number) => Math.max(Math.max(1, needed), MAX_ARTICLE_PHOTOS);

/** Пары «тот же кадр / тот же человек или фотосессия» из dup_of обеих моделей (связь без направления). */
export function dupLinks(A: Judgements, M: Judgements): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const add = (x: string, y: string) => {
    if (!x || !y || x === y || !/^[SR]\d+$/.test(y)) return;
    if (!links.has(x)) links.set(x, new Set());
    if (!links.has(y)) links.set(y, new Set());
    links.get(x)!.add(y);
    links.get(y)!.add(x);
  };
  for (const m of [A, M]) for (const [id, j] of m) if (j.dupOf) add(id, j.dupOf);
  return links;
}

export type AddPick = { id: string; why: string; kind: "must" | "extra" };

export type PickResult = { adds: AddPick[]; candidates: string[]; rejected: Array<{ id: string; why: string }>; extraThreshold: number; cap: number };

/**
 * Что добавить из резерва. Кандидат годен, если средняя модель сказала «ок», а дешёвая не нашла тяжёлой причины/дубля.
 *  - добор до нормы (`needed`): оценка ≥ 50; сначала без связи «дубль/тот же человек» и без пометки «похож» (`like`)
 *    с уже выбранными, затем похожие, и только если не набирается минимум `minOk` — связанные (лучше повтор, чем «Мало фото»);
 *  - сверх нормы: оценка ≥ max(85, средняя + 5, 80-й процентиль оставленных + 1), дешёвая модель тоже «ок»
 *    без замечаний, без связей и без «похож»; сколько угодно таких фото, итог не больше MAX_ARTICLE_PHOTOS.
 */
export function pickAdds(p: { rIds: string[]; keptS: string[]; needed: number; minOk: number; maxAdds: number; A: Judgements; M: Judgements }): PickResult {
  const { rIds, keptS, needed, minOk, A, M } = p;
  const candidates = rIds.filter((id) => {
    const m = get(M, id), a = get(A, id);
    return m.reason === "ok" && !SEVERE_REASONS.has(a.reason) && a.reason !== "duplicate";
  }).sort((x, y) => scoreOf(M, y) - scoreOf(M, x));
  const rejected = rIds.filter((id) => !candidates.includes(id)).map((id) => ({ id, why: `${get(M, id).reason}/${get(A, id).reason}` }));
  const links = dupLinks(A, M);
  const chosen = new Set(keptS);
  const linked = (id: string) => [...(links.get(id) ?? [])].some((x) => chosen.has(x));
  // «Похож» (тот же простой вариант: однотонный нюд рядом с таким же) — мягкая связь только в сторону уже выбранных.
  const alike = (id: string) => [get(M, id).like, get(A, id).like].some((x) => !!x && chosen.has(x!)) || [...chosen].some((x) => get(M, x).like === id || get(A, x).like === id);
  const cap = overNormCap(needed);
  const room = Math.max(0, Math.min(p.maxAdds, cap - keptS.length));
  const keptScores = keptS.map((id) => scoreOf(M, id));
  const avg = keptScores.length ? keptScores.reduce((t, x) => t + x, 0) / keptScores.length : 60;
  const p80 = percentile(keptScores, EXTRA_PERCENTILE) ?? 0;
  const extraThreshold = Math.max(EXTRA_MIN_SCORE, Math.round(avg + EXTRA_OVER_AVG), Math.floor(p80) + 1);
  // Сверх нормы — только когда и дешёвая модель за кадр: «ок» без замечаний и без dup_of, её оценка (если есть) ≥ 70.
  const liteBacks = (id: string) => { const a = get(A, id); return a.reason === "ok" && !a.dupOf && (a.score == null || a.score >= EXTRA_LITE_MIN); };
  const adds: AddPick[] = [];
  const total = () => keptS.length + adds.length;
  const take = (id: string, why: string, kind: AddPick["kind"]) => { adds.push({ id, why, kind }); chosen.add(id); };
  // Добор до нормы — сначала без повторов и похожих, затем похожие, затем (только если ниже минимума) и связанные.
  for (const id of candidates) {
    if (adds.length >= room || total() >= needed) break;
    if (chosen.has(id) || scoreOf(M, id) < MUST_MIN_SCORE || linked(id) || alike(id)) continue;
    take(id, `добор до ${needed}, оценка ${scoreOf(M, id)}`, "must");
  }
  for (const id of candidates) {
    if (adds.length >= room || total() >= needed) break;
    if (chosen.has(id) || scoreOf(M, id) < MUST_MIN_SCORE || linked(id)) continue;
    take(id, `добор до ${needed}, оценка ${scoreOf(M, id)} (похоже на другое фото)`, "must");
  }
  for (const id of candidates) {
    if (adds.length >= room || total() >= Math.min(needed, minOk)) break;
    if (chosen.has(id) || scoreOf(M, id) < MUST_MIN_SCORE) continue;
    take(id, `добор до минимума ${minOk}, оценка ${scoreOf(M, id)} (повтор человека/фотосессии)`, "must");
  }
  // Сверх нормы — только явно сильные по относительному порогу, с согласия обеих моделей, не повторы и не похожие;
  // первое — по порогу, следующие — только исключительные (оценка ≥ 90).
  let extras = 0;
  for (const id of candidates) {
    if (adds.length >= room) break;
    const sc = scoreOf(M, id);
    if (chosen.has(id) || sc < extraThreshold || linked(id) || alike(id) || !liteBacks(id)) continue;
    if (extras >= EXTRA_FREE && sc < EXTRA_STRONG_SCORE) continue;
    take(id, `сверх нормы: оценка ${sc} ≥ ${extras >= EXTRA_FREE ? EXTRA_STRONG_SCORE : extraThreshold}`, "extra");
    extras++;
  }
  return { adds, candidates, rejected, extraThreshold, cap };
}

/**
 * Кого из резерва смотреть «крупно» (аудит круга 3: смотрели все 15, добавлялось в среднем 3): ещё не просмотренные
 * выбранные добавления и `spare` следующих годных кандидатов на замену. Все добавления уже просмотрены → пусто (готово).
 */
export function reserveZoomTargets(pick: PickResult, seen: Set<string>, spare = 2): string[] {
  const ids = pick.adds.map((a) => a.id).filter((id) => !seen.has(id));
  if (!ids.length) return [];
  const add = new Set(ids);
  const extra = pick.candidates.filter((id) => !add.has(id) && !seen.has(id)).slice(0, spare);
  return [...ids, ...extra];
}

/**
 * Порядок: 5 сильнейших фото статьи первыми (добавленные сверх нормы туда не встают), дальше чередуем сильные/обычные
 * (оригинал :916-918).
 */
export function orderFinal(keptS: string[], adds: AddPick[], M: Judgements): string[] {
  const byScore = (x: string, y: string) => scoreOf(M, y) - scoreOf(M, x);
  const headPool = [...keptS, ...adds.filter((a) => a.kind === "must").map((a) => a.id)].sort(byScore);
  const top = headPool.slice(0, 5);
  const topSet = new Set(top);
  const rest = [...keptS, ...adds.map((a) => a.id)].filter((id) => !topSet.has(id)).sort(byScore);
  const half = Math.ceil(rest.length / 2);
  const strong = rest.slice(0, half), weak = rest.slice(half);
  const out = [...top];
  for (let i = 0; i < Math.max(strong.length, weak.length); i++) { if (strong[i]) out.push(strong[i]); if (weak[i]) out.push(weak[i]); }
  return out;
}

/* ───────────────────────── 3. Решение и уверенность ───────────────────────── */

export type VerdictInput = {
  total: number; // фото в статье до проверки
  final: number; // фото после проверки
  needed: number;
  minOk: number;
  agreed: number;
  disputed: number;
  flags: number;
  /** замечания основной модели (знаменатель «проверки сильно расходятся»); нет — берётся flags */
  flashFlags?: number;
  res: Resolution;
  /** причины удалений (для «много фото не по теме») */
  removedReasons: string[];
};

export type Verdict = { decision: "approve" | "human" | "insufficient"; confidence: number; reasons: string[]; agreeShare: number };

/**
 * Уверенность — из согласия: доля фото, где модели согласны (спор, решённый третьим мнением, — 0.8 фото),
 * 40 + 55 × доля (чистая статья ≈ 95); недобор до нормы снижает. Затем ограничения, которые ведут людям.
 */
export function verdictFrom(v: VerdictInput, autoConfidence: number): Verdict {
  const n = Math.max(1, v.total);
  const resolved = v.res.keptAfterDispute + v.res.droppedAfterDispute;
  const agreeShare = Math.min(1, (v.agreed + 0.8 * resolved) / n);
  let confidence = 40 + 55 * agreeShare;
  if (v.final < v.needed) confidence -= 15 * ((v.needed - v.final) / Math.max(1, v.needed));
  confidence = Math.round(Math.max(0, Math.min(100, confidence)));
  let decision: Verdict["decision"] = v.final >= v.minOk ? "approve" : "insufficient";
  const reasons: string[] = [];
  let toHuman = false;
  const removed = v.removedReasons.length;
  const dropShare = removed / n;
  const topicN = v.removedReasons.filter((r) => TOPIC_REASONS.test(r)).length;
  if (decision === "insufficient" && v.final < v.total / 2) { reasons.push(`удалено больше половины (${removed}/${v.total})`); toHuman = true; }
  // Аудит круга 2 (sleek low bun: 5 из 16 верных удалений, норма набрана, а ушла людям): большая доля удалений ведёт
  // людям, только если среди них есть удаления с одним сигналом, норма не набрана или убрано больше половины.
  const allConfirmed = v.res.singleSignalDrops === 0;
  if (dropShare > 0.3 && (!allConfirmed || v.final < v.needed || dropShare > HUMAN_DROP_SHARE_HARD)) {
    reasons.push(topicN / n > 0.3 ? `много фото не по теме (${topicN} из ${v.total})` : `удалено ${Math.round(dropShare * 100)}% подборки`);
    toHuman = true;
    confidence = Math.min(confidence, 70);
  }
  // Расхождение — когда спор отменил больше половины замечаний ОСНОВНОЙ модели и их хотя бы 3. Аудит круга 3 (wide leg):
  // отмены находок «крупно» (вывеска на фоне) и одиночных отметок lite — штатная работа спора, не расхождение.
  const fFlags = v.flashFlags ?? v.flags;
  if (fFlags >= 3 && v.res.flashOverturned / fFlags > 0.5) { reasons.push(`проверки сильно расходятся (${v.res.flashOverturned} из ${fFlags} замечаний основной модели отменено спором)`); confidence = Math.min(confidence, 70); }
  // Ничья по ИИ при недоборе нормы: фото убраны (✕ у людей, можно вернуть), но решает человек.
  if (v.res.tieDrops.length && v.final < v.needed) { reasons.push(`спорные ИИ-фото убраны (${v.res.tieDrops.length}), норма не набрана (${v.final} из ${v.needed})`); toHuman = true; confidence = Math.min(confidence, 70); }
  if (v.res.unresolved > 0) { reasons.push(`повторная проверка не ответила (${v.res.unresolved} спорных фото оставлено)`); confidence = Math.min(confidence, 70); }
  if (decision === "approve" && v.final < v.needed && v.final < v.minOk + 3) { reasons.push(`впритык к минимуму (${v.final} при норме ${v.needed})`); confidence = Math.min(confidence, 74); }
  if (toHuman) decision = "human";
  else if (decision === "approve" && confidence < autoConfidence && !reasons.length) reasons.push(`модели часто не согласны (согласие ${Math.round(agreeShare * 100)}%)`);
  // Правило владельца 2026-10-16 (zorvianix: 96 статей с ~22 хорошими фото из 30 стояли у людей): если после модерации
  // в статье не меньше AUTO_APPROVE_MIN_PHOTOS фото — одобряем сами; причины остаются пометками в решении.
  if (v.final >= AUTO_APPROVE_MIN_PHOTOS && decision !== "insufficient") {
    if (decision === "human" || confidence < autoConfidence) reasons.push(`одобрено автоматически: ${v.final} фото (≥ ${AUTO_APPROVE_MIN_PHOTOS})`);
    decision = "approve";
    confidence = Math.max(confidence, autoConfidence);
  }
  return { decision, confidence, reasons, agreeShare };
}

/* ───────────────────────── 4. Смысл ключа («MUST show») ───────────────────────── */

/**
 * Версия определений смысла ключа: кэш `Article.facts.keywordVisual` с другой версией считается устаревшим
 * (v1 — модель сужала ключ: «хром только на кончиках», «только белый микрофренч»).
 */
export const KEYWORD_VISUAL_VERSION = 2;

type VisualEntry = {
  id: string;
  re: RegExp;
  text: string;
  /** составной ключ заменяет определения своих частей (chrome french → без отдельных chrome и french) */
  replaces?: string[];
  /** уточнение (curly, sleek, low…): само по себе ключ не определяет, только вместе с основой */
  modifier?: boolean;
};

/**
 * Известные трендовые ключи: что обязано быть видно на фото (без запроса к модели).
 * Аудит 2026-10-15 (круг 2): определения не сужаем — перечисляем варианты, которые подходят, и только потом что не подходит.
 */
const KNOWN_VISUALS: VisualEntry[] = [
  // составные — раньше частей, заменяют их
  { id: "chrome_french", re: /chrome[- ]?french|french[- ]?chrome|metallic french|pearl(y)? french/, replaces: ["french", "chrome"], text: "a french-tip or french-style nail design combined with a chrome, metallic, pearl or glazed finish: chrome/metallic tips, chrome powder over a french manicure, pearly or glazed white tips, metallic tip lines all count; the chrome does NOT have to be only on the tips. NOT: plain french tips with no metallic/pearl sheen, plain chrome nails with no tip design" },
  { id: "micro_french", re: /micro[- ]?french|skinny french|thin french/, replaces: ["french"], text: "a very thin tip line along the free edge of the nail, in ANY colour (white, nude, black, colourful, glitter, gold), small accents or tiny florals allowed. NOT: classic thick french tips, nails with no tip line" },
  { id: "bubble_bob", re: /bubble bob/, replaces: ["bob"], text: "a rounded, voluminous bob (jaw to chin length) with soft curved-under ends forming a bubble-like shape. NOT: sharp angular or asymmetric bobs, flat straight bobs, long layered cuts" },
  // «french» в причёсках — не френч на ногтях (раньше «french bob» получал определение маникюра)
  { id: "french_bob", re: /french bob/, replaces: ["french", "bob"], text: "a short French bob: chin-length or shorter, often with bangs or a soft undone texture. NOT: hair below the chin, long bobs (lobs)" },
  { id: "french_braid", re: /french braids?/, replaces: ["french"], text: "French braids: strands woven in from the hairline along the head (one or two braids, any length). NOT: simple three-strand braids starting at the nape, twists, buns without braids" },
  // основы
  { id: "milk_bath", re: /milk[- ]?bath/, text: "real flowers/petals or botanical bits suspended inside a milky, translucent white or pastel base; plain milky nails without flowers are NOT milk bath nails" },
  { id: "jelly", re: /\bjelly\b/, text: "translucent, glossy, see-through colour like jelly or glass (any colour); opaque cream polish, pearl or chrome are NOT jelly" },
  { id: "baby_bangs", re: /\bbaby bangs?\b|micro bangs?|micro fringe/, text: "very short micro bangs ending well above the eyebrows (mid-forehead), straight, choppy or curly; brow-length, curtain or side bangs are NOT baby bangs" },
  { id: "curtain_bangs", re: /curtain bangs?/, text: "bangs parted in the centre, sweeping to both sides and framing the face (any length and hair texture)" },
  { id: "wolf_cut", re: /wolf ?cut/, text: "shaggy, heavily layered cut with crown volume and wispy, mullet-like longer ends (short or long, straight or curly)" },
  { id: "butterfly_cut", re: /butterfly (hair)?cut/, text: "long hair with short face-framing layers that flare out like wings plus longer layers below" },
  { id: "barrel_leg", re: /barrel[- ]?leg/, text: "jeans/trousers with curved, barrel/horseshoe-shaped legs that bow out at the knee and taper at the ankle (any wash or colour)" },
  { id: "tortoiseshell", re: /tortoise ?shell/, text: "translucent mottled tortoiseshell pattern (classic amber-brown with dark spots; coloured tortoise variants count when the mottled pattern is clear)" },
  { id: "cat_eye_nails", re: /cat[- ]?eye nails?/, text: "magnetic cat-eye gel with a shimmering light band across the nail, any colour" },
  { id: "aura", re: /aura nails?/, text: "a soft blurred glow of colour in the centre of each nail fading outwards, any colour" },
  { id: "french", re: /french (tips?|manicure|nails?)|\bfrench\b/, text: "a clearly painted tip line on the nails (any colour and thickness; deep, V-shaped, double, side and accent variants count) over a natural or sheer base" },
  { id: "chrome", re: /\bchrome\b/, text: "mirror-like metallic, pearl or glazed chrome finish on the nails (full or partial)" },
  { id: "slip_dress", re: /slip dress/, text: "a silky/satin slip-style dress with thin straps (any length)" },
  { id: "hush_cut", re: /hush cut/, text: "soft, airy, feathered layers with face-framing pieces and a light, wispy finish" },
  { id: "shag", re: /\bshag\b|shag (hair)?cut/, text: "choppy, textured layers with volume on top and thinned ends" },
  { id: "pixie", re: /\bpixie\b/, text: "a very short cropped cut, hair above the ears at the sides" },
  { id: "bubble_braids", re: /bubble braids?|bubble pony/, text: "a ponytail or braid sectioned by elastics into puffed 'bubbles'" },
  { id: "low_bun", re: /low bun|nape bun|low chignon/, text: "a bun placed low at the nape of the neck (chignon, knot or twisted low bun). NOT: high buns, top knots, mid-height buns, ponytails" },
  { id: "bomber", re: /bomber/, text: "a bomber jacket: short, hip-length jacket with ribbed knit cuffs and hem band, usually zip front (nylon MA-1, satin, leather, suede or wool bombers all count). NOT: biker/moto jackets with lapels, shirt-jackets, blazers, denim or trucker jackets, long coats" },
  { id: "mary_jane", re: /mary ?janes?/, text: "Mary Jane shoes — a strap across the instep (flats, heels, platforms, loafers-style), clearly visible on the feet. NOT: ballet flats or pumps without the instep strap" },
  { id: "pleated_skirt", re: /pleated skirt/, text: "a skirt with regular folded pleats (mini, midi or maxi; knife, box, accordion pleats). NOT: plain, gathered or ruffled skirts" },
  // Аудит круга 3: «almond french» терял форму, «shag bob» — длину. Формы и длины ногтей, длина каре.
  { id: "bob", re: /\bbob\b|\blob\b/, text: "a bob: hair length between the jaw and the shoulders (blunt, layered, textured, wavy or curly bobs count). NOT: hair clearly past the shoulders, pixie-short crops" },
  { id: "almond", re: /\balmond\b/, text: "almond-shaped nails: slim tapered sides ending in a soft rounded peak (short or long). NOT: square, squoval, round or oval nails, sharp stiletto points, coffin/ballerina" },
  { id: "coffin", re: /\bcoffin\b|\bballerina nails?\b/, text: "coffin/ballerina-shaped nails: tapered sides with a flat squared-off tip. NOT: almond, oval, round, square or stiletto nails" },
  { id: "stiletto", re: /\bstiletto nails?\b|\bstiletto\b(?=.*\bnails?\b)/, text: "stiletto nails: long tapered nails ending in a sharp point. NOT: almond with a rounded peak, coffin, square or oval nails" },
  { id: "square_nails", re: /\bsquare\b(?=.*\bnails?\b)|\bsquoval\b/, text: "square or squoval nails: straight sides with a flat tip (soft rounded corners count). NOT: almond, oval, round, coffin or stiletto nails" },
  { id: "oval_nails", re: /\boval\b(?=.*\bnails?\b)/, text: "oval nails: rounded egg-shaped tips following the fingertip curve. NOT: square, coffin, sharp stiletto nails" },
  { id: "short_nails", re: /\bshort\b(?=.*\b(nails?|manicure)\b)/, text: "short nails: the free edge ends at the fingertip or just past it (any shape, colour or design). NOT: medium or long nails, long almond/coffin/stiletto extensions" },
  { id: "long_nails", re: /\blong\b(?=.*\b(nails?|manicure)\b)/, text: "long nails: the free edge clearly extends well past the fingertip (any shape). NOT: short or natural-length nails" },
  // уточнения — только вместе с основой
  { id: "curly", re: /\bcurly\b|\bcurls\b/, modifier: true, text: "the hair is clearly curly (defined curls or coils; wavy-curly counts). NOT: straight hair or only a slight bend" },
  { id: "wavy", re: /\bwavy\b/, modifier: true, text: "the hair has visible waves. NOT: straight hair" },
  { id: "straight", re: /\bstraight hair\b/, modifier: true, text: "the hair is straight. NOT: curly or clearly wavy hair" },
  { id: "sleek", re: /\bsleek\b/, modifier: true, text: "smooth, polished, tightly pulled hair with no messy texture. NOT: messy, textured, braided or loose-strand styles" },
];

/**
 * Слова ключа, которые не являются признаком на фото: категории (nails, outfits, haircut…), «общие» слова, годы,
 * сезоны и то, что на фото не проверить (gel — гель или лак, не видно).
 */
const KEYWORD_STOP = new Set(("nail nails manicure manicures mani design designs art idea ideas inspo inspiration inspirations look looks outfit outfits " +
  "style styles styling hair hairstyle hairstyles haircut haircuts cut cuts hairdo hairdos color colors colour colours shade shades " +
  "women woman womens girl girls ladies lady men teen teens for with and the of in on to how what wear wearing your you my best top " +
  "cute pretty easy simple trendy trend trends trending aesthetic chic stylish classy elegant gorgeous stunning beautiful modern new latest " +
  "fall autumn winter spring summer season seasonal holiday christmas halloween valentine valentines easter thanksgiving vacation " +
  "gel polish dip acrylic acrylics shellac diy tutorial guide").split(/\s+/));

/** Значимые слова ключа (без служебных и категорий): именно они должны быть видны на фото. */
export function keywordWords(keyword: string): string[] {
  const words = String(keyword || "").toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  return [...new Set(words.filter((w) => w.length >= 3 && !KEYWORD_STOP.has(w) && !KEYWORD_STOP.has(w.replace(/s$/, ""))))];
}

/** Строка про слова ключа, которые не покрыты определением: они тоже обязаны быть видны (цвет, форма, длина, материал, вещь). */
const literalLine = (words: string[]) => `${words.map((w) => `"${w}"`).join(", ")} — named in the keyword, must be visibly true as named (colour, shape, length, material or item)`;

/** Буквальное определение ключа без словаря и модели: каждое значимое слово должно быть видно. Пусто — ключ общий. */
export function literalVisual(keyword: string): string {
  const w = keywordWords(keyword);
  return w.length ? `every item named in the keyword must be clearly visible: ${literalLine(w)}` : "";
}

/**
 * Определение из словаря: ВСЕ совпавшие части ключа склеиваются (аудит: «curly shag» терял «curly»),
 * составные записи заменяют свои части. Аудит круга 3: слова ключа без записи в словаре (white, almond до mix3.4…)
 * не теряются — дописываются как обязательные «also named». Только уточнения без основы → null (тогда — модель с кэшем).
 */
export function knownVisual(keyword: string): string | null {
  const k = String(keyword || "").toLowerCase();
  const hits = KNOWN_VISUALS.filter((e) => e.re.test(k));
  const replaced = new Set(hits.flatMap((e) => e.replaces ?? []));
  const parts = hits.filter((e) => !replaced.has(e.id));
  if (!parts.some((e) => !e.modifier)) return null;
  // Слова, которые покрыла хотя бы одна совпавшая запись (включая заменённые части составных).
  const covered = new Set<string>();
  for (const e of hits) for (const m of k.matchAll(new RegExp(e.re.source, "g"))) for (const w of m[0].split(/[\s-]+/)) if (w) { covered.add(w); covered.add(w.replace(/s$/, "")); }
  const left = keywordWords(k).filter((w) => !covered.has(w) && !covered.has(w.replace(/s$/, "")));
  if (parts.length === 1 && !left.length) return parts[0].text;
  // Основы первыми, уточнения после; каждое должно быть видно на фото.
  const ordered = [...parts.filter((e) => !e.modifier), ...parts.filter((e) => e.modifier)];
  const items = ordered.map((e) => `[${e.id.replace(/_/g, " ")}] ${e.text}`);
  if (left.length) items.push(`[also named] ${literalLine(left)}`);
  return `ALL of these must be visible — ${items.join("; ")}`;
}

/** Слова-признаки (цвет, материал, форма, длина): если модель потеряла такое слово ключа, его дописываем. */
const VISUAL_WORDS = /^(white|black|red|pink|nude|beige|brown|blue|navy|green|sage|olive|yellow|orange|purple|lilac|lavender|grey|gray|silver|gold|golden|burgundy|cherry|cream|ivory|neutral|pastel|neon|leather|faux|denim|suede|satin|silk|velvet|wool|linen|lace|knit|tweed|sequin|sequins|almond|square|coffin|stiletto|oval|round|squoval|short|long|mini|midi|maxi|cropped|wide|straight|flare|flared|baggy|oversized|curly|wavy|chunky|matte|glossy|glitter|chrome|pearl|metallic)$/;

/**
 * Определение от модели → итоговое: пустое для ключа со значимыми словами не принимаем (аудит круга 3: «white sneakers»
 * получил пустое) — берём буквальные слова ключа; потерянные моделью слова-признаки дописываем.
 */
export function completeVisual(keyword: string, modelText: string): string {
  const text = String(modelText || "").trim();
  if (!text) return literalVisual(keyword);
  const lower = text.toLowerCase();
  const lost = keywordWords(keyword).filter((w) => VISUAL_WORDS.test(w) && !lower.includes(w.replace(/s$/, "")));
  return lost.length ? `${text}; ALSO: ${literalLine(lost)}`.slice(0, 520) : text;
}

/** Промт для дешёвого определения ключа (text_fast). Аудит круга 2: модель сужала ключ («хром только на кончиках»). */
export const KEYWORD_VISUAL_SYSTEM = `You define Pinterest search keywords visually for a photo moderator.
Given a keyword, describe in max 45 words what a photo MUST clearly show to match it.
Rules:
- Do NOT narrow the keyword. Describe it as broadly as people actually search for it: include the common variants that DO count (colours, finishes, lengths, placements, materials, hair textures) — e.g. "micro french" is a thin tip of ANY colour, not only white; "chrome french" is any french design with a chrome/pearl finish, not only chrome on the tips.
- Every word of the keyword matters: a modifier (curly, sleek, low, micro, oversized…) must be part of the definition.
- Then list briefly what DISQUALIFIES a photo (similar-looking things that do NOT count), starting with "NOT:".
Never return an empty string when the keyword names a colour, material, shape, length, pattern or a specific item (e.g. "white sneakers": the sneakers must be white). Only a purely generic category (e.g. "outfit ideas", "nail ideas") may return an empty string.
Return ONLY JSON: {"must_show":"..."}`;

export function parseKeywordVisual(out: unknown): string {
  const s = String((out as { must_show?: unknown } | null)?.must_show ?? "").replace(/\s+/g, " ").trim();
  return s.length >= 8 ? s.slice(0, 400) : "";
}

/** Строка для промтов lite и flash. */
export function keywordVisualRule(keyword: string, text: string): string {
  if (!text) return "";
  return `KEYWORD MEANING (hard): "${keyword}" = ${text}. Photos that don't clearly show this are "wrong_detail"; variants named there as counting are fine — never flag them.\n`;
}
