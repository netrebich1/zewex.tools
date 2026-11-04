/**
 * Сервер для расширения Chrome «Zewex Collector» (extension/collector): токены, состояние аккаунтов Pinterest,
 * очередь заданий KwTask с арендой, приём сырых ответов и запись снимков выдачи / частотности.
 * API — src/app/api/keywords/collector/[action]/route.ts. Порядок шагов задания «выдача»:
 *   next → (расширение: BaseSearchResource) → search → (UserResource по списку, AdvancedTypeahead) → finish.
 */
import { createHash } from "node:crypto";
import { Prisma, type KwAccount, type KwCollector } from "@prisma/client";
import { prisma } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { canUseTool, resolvePermissions } from "@/lib/permissions";
import { recomputeKeywords, urlHash } from "./recompute";
import { allUsernames, analyze, orgUsernames, parseSizing, parseTypeahead, parseUser, resourceResponse, searchProblem, type PinnerInfo } from "./serp";
import { KEYWORDS } from "./types";

/** Паузы после отказов Pinterest, минуты (`__backoff` прототипа). После последней — ограничение на часы. */
export const PAUSES_MIN = [2, 4, 8, 15];
/** Ограничение аккаунта после всех пауз: 1-е подряд — 4 ч, 2-е — 8 ч, дальше — сутки. */
export const LIMIT_HOURS = [4, 8, 24];
/** Аренда задания расширением, секунды (на шаги search → finish). */
export const LEASE_SEC = 240;
/** Профиль автора спрашиваем заново не раньше чем через 30 дней. */
export const PINNER_TTL_DAYS = 30;
/** Попыток задания до FAILED (пустая выдача, ошибка, тайм-аут Ads Manager). */
export const MAX_ATTEMPTS = 4;
/** Версия протокола: расширение старше — просим обновить. */
export const PROTOCOL = 1;

export type Mode = "serp" | "volume";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** День по Киеву YYYY-MM-DD (суточный счётчик ключей). */
export const kyivDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d);

export class CollectorError extends Error {
  constructor(message: string, public status = 400, public code = "bad_request") {
    super(message);
  }
}

/** Новый токен расширения: сам токен показывается один раз, в базе — только sha256. */
export async function issueToken(userId: string, name: string, accountId: string): Promise<string> {
  const token = `zxc_${randomToken(24)}`;
  await prisma.kwCollector.create({ data: { userId, name: name.slice(0, 120), accountId, tokenHash: hashToken(token), tokenHint: token.slice(0, 10) } });
  return token;
}

export type Ctx = { collector: KwCollector; account: KwAccount };

/** Проверка токена из заголовка Authorization: Bearer … Пользователь должен быть активен и иметь доступ к инструменту. */
export async function authCollector(req: Request): Promise<Ctx> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new CollectorError("Нет токена. Вставьте токен с вкладки «Сбор» в окно расширения.", 401, "no_token");
  const collector = await prisma.kwCollector.findUnique({ where: { tokenHash: hashToken(m[1]) }, include: { account: true } });
  if (!collector || collector.revokedAt) throw new CollectorError("Токен не найден или отозван. Выдайте новый на вкладке «Сбор».", 401, "bad_token");
  const user = await prisma.user.findUnique({ where: { id: collector.userId }, select: { id: true, role: true, isActive: true, permissions: true } });
  if (!user?.isActive) throw new CollectorError("Пользователь, на которого выдан токен, отключён.", 403, "user_off");
  const actor = { id: user.id, role: user.role, teamIds: [], leadTeamIds: [], perms: resolvePermissions(user.role, user.permissions) };
  if (!canUseTool(actor, KEYWORDS)) throw new CollectorError("Инструмент «Подбор ключей» этому пользователю не выдан.", 403, "no_access");
  if (!collector.account) throw new CollectorError("Токен не привязан к аккаунту Pinterest. Выдайте новый токен на вкладке «Сбор».", 403, "no_account");
  const { account, ...rest } = collector;
  return { collector: rest as KwCollector, account };
}

/**
 * Сверка аккаунта Pinterest, открытого в браузере, с аккаунтом токена: выдача персонализирована,
 * снимок с чужого аккаунта испортил бы статистику. Первое имя запоминается в аккаунте.
 */
async function checkUser(ctx: Ctx, username: string | null | undefined): Promise<void> {
  const u = (username ?? "").trim().replace(/^@/, "").toLowerCase().slice(0, 120) || null;
  await prisma.kwCollector.update({ where: { id: ctx.collector.id }, data: { lastSeenAt: new Date(), ...(u ? { seenUser: u } : {}) } });
  if (!u) return;
  if (!ctx.account.username) {
    const other = await prisma.kwAccount.findFirst({ where: { username: u, id: { not: ctx.account.id } }, select: { name: true } });
    if (other) throw new CollectorError(`Аккаунт Pinterest @${u} уже записан как «${other.name}», а токен выдан для «${ctx.account.name}». Выдайте токен для «${other.name}».`, 409, "wrong_account");
    ctx.account = await prisma.kwAccount.update({ where: { id: ctx.account.id }, data: { username: u } });
    return;
  }
  if (ctx.account.username.toLowerCase() !== u) {
    throw new CollectorError(`В браузере открыт @${u}, а токен выдан для «${ctx.account.name}» (@${ctx.account.username}). Войдите в нужный аккаунт Pinterest или выдайте другой токен.`, 409, "wrong_account");
  }
}

const event = (accountId: string, kind: string, result: string, value?: number | null, note?: string | null) =>
  prisma.kwAccountEvent.create({ data: { accountId, kind, result, value: value ?? null, note: note ? note.slice(0, 255) : null } });

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const fmtKyiv = (d: Date) => d.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Можно ли сейчас работать аккаунтом: null — можно, иначе через сколько секунд спросить снова и почему. */
async function gate(ctx: Ctx, mode: Mode, now = new Date()): Promise<{ wait: number; reason: string } | null> {
  const a = ctx.account;
  if (a.status === "OFF") return { wait: 300, reason: `Аккаунт «${a.name}» выключен на вкладке «Сбор».` };
  if (mode === "volume") return null; // Ads Manager — не поиск: ограничение поиска на него не действует
  if (a.status === "LIMITED") {
    if (a.limitedUntil && a.limitedUntil <= now) {
      // Срок ограничения вышел: пробуем снова (если Pinterest ещё не отпустил — паузы начнутся заново, а следующее ограничение будет длиннее).
      ctx.account = await prisma.kwAccount.update({ where: { id: a.id }, data: { status: a.gapSec >= 20 ? "SLOW" : "ACTIVE", limitedUntil: null, blockStep: 0, pausedUntil: null } });
      await event(a.id, "retry", "ok", null, "срок ограничения вышел — пробуем снова");
      return null;
    }
    const wait = a.limitedUntil ? Math.ceil((a.limitedUntil.getTime() - now.getTime()) / 1000) : 1800;
    return { wait: Math.min(wait, 1800), reason: a.limitedUntil ? `Pinterest ограничил поиск аккаунту «${a.name}» до ${fmtKyiv(a.limitedUntil)}.` : `Аккаунт «${a.name}» помечен как ограниченный. Снимите ограничение на вкладке «Сбор», когда поиск заработает.` };
  }
  if (a.pausedUntil && a.pausedUntil > now) {
    return { wait: Math.ceil((a.pausedUntil.getTime() - now.getTime()) / 1000), reason: `Пауза после отказа Pinterest до ${fmtKyiv(a.pausedUntil)}.` };
  }
  if (a.dailyCap != null && a.dayDate === kyivDay(now) && a.dayKeys >= a.dailyCap) {
    return { wait: 1800, reason: `Лимит аккаунта на сегодня (${a.dailyCap} ключей) исчерпан.` };
  }
  return null;
}

/** Отказ Pinterest (пустая выдача, ошибка, нет ответа): паузы 2 → 4 → 8 → 15 мин, потом ограничение на часы. */
async function registerFailure(ctx: Ctx, result: "empty" | "error", note: string, now = new Date()): Promise<{ pauseSec: number; limited: boolean }> {
  const a = ctx.account;
  const step = a.blockStep + 1;
  const blockedAt = a.blockedAt ?? now;
  const streak = a.streakFrom ? `после ${a.streakKeys} ключей за ${minutes(now.getTime() - a.streakFrom.getTime())} мин` : `после ${a.streakKeys} ключей`;
  if (step === 1) await event(a.id, "blocked", result, a.streakKeys, `первый отказ ${streak}: ${note}`);
  if (step <= PAUSES_MIN.length) {
    const pauseSec = PAUSES_MIN[step - 1] * 60;
    const pausedUntil = new Date(now.getTime() + pauseSec * 1000);
    ctx.account = await prisma.kwAccount.update({ where: { id: a.id }, data: { blockStep: step, blockedAt, pausedUntil } });
    await event(a.id, "paused", result, pauseSec, `пауза ${PAUSES_MIN[step - 1]} мин (${step}-й отказ подряд): ${note}`);
    return { pauseSec, limited: false };
  }
  const before = await prisma.kwAccountEvent.count({ where: { accountId: a.id, kind: "limited", at: { gte: blockedAt } } });
  const hours = LIMIT_HOURS[Math.min(before, LIMIT_HOURS.length - 1)];
  const limitedUntil = new Date(now.getTime() + hours * 3600_000);
  ctx.account = await prisma.kwAccount.update({ where: { id: a.id }, data: { status: "LIMITED", limitedUntil, blockStep: 0, pausedUntil: null, blockedAt } });
  await event(a.id, "limited", "error", a.streakKeys, `отказы не прошли после пауз ${PAUSES_MIN.join("→")} мин; ограничение на ${hours} ч (до ${fmtKyiv(limitedUntil)}); блок начался ${streak}`);
  // Аренды этого аккаунта — обратно в очередь: задания возьмёт другой аккаунт.
  await prisma.kwTask.updateMany({ where: { status: "LEASED", collectorId: ctx.collector.id }, data: { status: "QUEUED", leaseUntil: null, collectorId: null } });
  return { pauseSec: hours * 3600, limited: true };
}

/** Успешный поиск: снимает паузы, считает ключи за день и с последнего блока, пишет «работа возобновлена» с длительностью блока. */
async function registerSuccess(ctx: Ctx, now = new Date()): Promise<void> {
  const a = ctx.account;
  const day = kyivDay(now);
  const data: Prisma.KwAccountUpdateInput = { dayDate: day, dayKeys: a.dayDate === day ? { increment: 1 } : 1, lastSeenAt: now };
  if (a.blockedAt || a.blockStep) {
    const sec = a.blockedAt ? Math.round((now.getTime() - a.blockedAt.getTime()) / 1000) : null;
    await event(a.id, "resumed", "ok", sec, sec != null ? `поиск снова работает; блок длился ${minutes(sec * 1000)} мин` : "поиск снова работает");
    Object.assign(data, { blockStep: 0, blockedAt: null, pausedUntil: null, streakKeys: 1, streakFrom: now, ...(a.status === "LIMITED" ? { status: a.gapSec >= 20 ? "SLOW" : "ACTIVE", limitedUntil: null } : {}) });
  } else {
    Object.assign(data, { streakKeys: { increment: 1 }, ...(a.streakFrom ? {} : { streakFrom: now }) });
  }
  ctx.account = await prisma.kwAccount.update({ where: { id: a.id }, data });
}

// ---------------- шаги протокола ----------------

type Body = Record<string, unknown>;
const str = (v: unknown, max = 190) => (typeof v === "string" ? v.slice(0, max) : null);

async function touch(ctx: Ctx, b: Body) {
  const state = str(b.state);
  const version = str(b.version, 20);
  if (state || version) await prisma.kwCollector.update({ where: { id: ctx.collector.id }, data: { ...(state ? { state } : {}), ...(version ? { version } : {}), lastSeenAt: new Date() } });
}

/** Первое знакомство расширения: сверка аккаунта, настройки темпа. */
export async function hello(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  await checkUser(ctx, str(b.username));
  const a = ctx.account;
  return { protocol: PROTOCOL, collector: ctx.collector.name, account: { name: a.name, username: a.username, status: a.status, gapSec: a.gapSec, dailyCap: a.dailyCap }, pauses: PAUSES_MIN };
}

/** Следующее задание (выдача или частотность) или «подождите N секунд». */
export async function next(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const mode: Mode = b.mode === "volume" ? "volume" : "serp";
  if (mode === "serp") await checkUser(ctx, str(b.username));
  const g = await gate(ctx, mode);
  if (g) return { wait: g.wait, reason: g.reason };
  const now = new Date();
  const cands = await prisma.kwTask.findMany({
    where: {
      kind: mode, keywordId: { not: null },
      OR: [{ status: "QUEUED" }, { status: "LEASED", leaseUntil: { lt: now } }],
      AND: [{ OR: [{ accountId: null }, { accountId: ctx.account.id }] }],
    },
    orderBy: { createdAt: "asc" }, take: 5,
    select: { id: true, status: true, updatedAt: true, keyword: { select: { phrase: true } } },
  });
  for (const c of cands) {
    const won = await prisma.kwTask.updateMany({
      where: { id: c.id, status: c.status, updatedAt: c.updatedAt },
      data: { status: "LEASED", leaseUntil: new Date(now.getTime() + LEASE_SEC * 1000), collectorId: ctx.collector.id, attempts: { increment: 1 } },
    });
    if (won.count) {
      const left = await prisma.kwTask.count({ where: { kind: mode, status: "QUEUED" } });
      return { task: { id: c.id, kind: mode, phrase: c.keyword!.phrase }, gapSec: ctx.account.gapSec, left };
    }
  }
  return { wait: 60, reason: mode === "serp" ? "Очередь выдачи пуста." : "Очередь частотности пуста." };
}

async function leasedTask(ctx: Ctx, taskId: unknown, kind: Mode) {
  const t = typeof taskId === "string" ? await prisma.kwTask.findUnique({ where: { id: taskId }, include: { keyword: { select: { id: true, phrase: true } } } }) : null;
  if (!t || t.kind !== kind || !t.keyword) throw new CollectorError("Задание не найдено.", 404, "no_task");
  if (t.status !== "LEASED" || t.collectorId !== ctx.collector.id) throw new CollectorError("Задание уже отдано другому расширению или закрыто.", 409, "lost_lease");
  return t as typeof t & { keyword: { id: string; phrase: string } };
}

/** Задание не удалось: в очередь снова (другому аккаунту), после MAX_ATTEMPTS — FAILED. */
async function requeue(taskId: string, attempts: number, error: string) {
  const failed = attempts >= MAX_ATTEMPTS;
  await prisma.kwTask.update({ where: { id: taskId }, data: { status: failed ? "FAILED" : "QUEUED", leaseUntil: null, collectorId: null, payload: Prisma.DbNull, error: error.slice(0, 255) } });
}

/** Только то, что нужно разбору: пины первого экрана и уточнения (сырые объекты без изменений). */
function trimSearch(body: unknown): unknown {
  const rr = resourceResponse(body);
  return { resource_response: { status: rr?.status, data: { results: rr?.data?.results ?? [], rankedGuides: rr?.data?.rankedGuides ?? [] } } };
}

/**
 * Шаг 1 задания «выдача»: сырой ответ BaseSearchResource. Пустая выдача или ошибка — отказ (паузы).
 * Ответ — кого из авторов спросить через UserResource (нет в кэше за 30 дней) и нужны ли подсказки.
 */
export async function search(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const t = await leasedTask(ctx, b.taskId, "serp");
  const ms = typeof b.ms === "number" ? Math.round(b.ms) : null;
  const problem = typeof b.error === "string" ? b.error.slice(0, 180) : searchProblem(Number(b.status) || 0, b.body);
  const n = problem ? 0 : ((resourceResponse(b.body)?.data?.results ?? []) as Array<{ type?: string }>).filter((x) => x?.type === "pin").length;
  if (problem || !n) {
    const result = problem ? "error" : "empty";
    await event(ctx.account.id, "serp", result, ms, `${t.keyword.phrase}: ${problem ?? "пустая выдача"}`);
    await requeue(t.id, t.attempts, problem ?? "пустая выдача");
    const f = await registerFailure(ctx, result, problem ?? "пустая выдача");
    return { pause: f.pauseSec, limited: f.limited, reason: f.limited ? `Pinterest ограничил поиск: аккаунт на паузе до ${fmtKyiv(ctx.account.limitedUntil!)}.` : `Pinterest отказал (${problem ?? "пустая выдача"}). Пауза ${Math.round(f.pauseSec / 60)} мин.` };
  }
  await event(ctx.account.id, "serp", "ok", ms, t.keyword.phrase);
  await registerSuccess(ctx);
  const payload = trimSearch(b.body);
  await prisma.kwTask.update({ where: { id: t.id }, data: { payload: { search: payload } as Prisma.InputJsonValue, leaseUntil: new Date(Date.now() + LEASE_SEC * 1000) } });
  const want = orgUsernames(payload);
  const fresh = want.length ? await prisma.kwPinner.findMany({ where: { username: { in: want }, fetchedAt: { gte: new Date(Date.now() - PINNER_TTL_DAYS * 864e5) } }, select: { username: true } }) : [];
  const have = new Set(fresh.map((p) => p.username));
  return { pinners: want.filter((u) => !have.has(u)), typeahead: true };
}

type Raw = { status?: number; body?: unknown; ms?: number; error?: string };

/** Шаг 2: профили авторов и подсказки → снимок выдачи, пины топа, пересчёт ключа. */
export async function finish(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const t = await leasedTask(ctx, b.taskId, "serp");
  const search = (t.payload as { search?: unknown } | null)?.search;
  if (!search) throw new CollectorError("Нет ответа поиска для этого задания — начните с шага search.", 409, "no_search");
  const now = new Date();

  const users = new Map<string, PinnerInfo | null>();
  const raws = (b.pinners && typeof b.pinners === "object" ? b.pinners : {}) as Record<string, Raw>;
  for (const [username, r] of Object.entries(raws).slice(0, 20)) {
    const info = r && !r.error && (!r.status || r.status === 200) ? parseUser(r.body) : null;
    await event(ctx.account.id, "pinner", info ? "ok" : "error", typeof r?.ms === "number" ? Math.round(r.ms) : null, info ? username : `${username}: ${r?.error ?? `HTTP ${r?.status ?? "?"}`}`);
    users.set(username, info); // null = Pinterest не отдал профиль (как `__uc[u] = null` в прототипе)
    if (info) {
      const data = { views: info.v, reach: info.r, followers: info.f, pins: info.pins, boards: info.boards, business: info.biz, domainVerified: info.dv, merchant: info.mer, domain: info.dom?.slice(0, 190) ?? null, fetchedAt: now };
      await prisma.kwPinner.upsert({ where: { username }, update: data, create: { username, ...data } });
    }
  }
  const names = allUsernames(search).filter((u) => !users.has(u));
  if (names.length) {
    for (const p of await prisma.kwPinner.findMany({ where: { username: { in: names } } })) {
      users.set(p.username, { v: p.views, r: p.reach, f: p.followers, pins: p.pins, boards: p.boards, biz: p.business, dv: p.domainVerified, mer: p.merchant, dom: p.domain });
    }
  }

  let ta: string[] = [];
  const tr = b.typeahead as Raw | null | undefined;
  if (tr) {
    ta = !tr.error && (!tr.status || tr.status === 200) ? parseTypeahead(tr.body) : [];
    await event(ctx.account.id, "typeahead", tr.error || (tr.status && tr.status !== 200) ? "error" : ta.length ? "ok" : "empty", typeof tr.ms === "number" ? Math.round(tr.ms) : null, t.keyword.phrase);
  }

  const { agg, top } = analyze(t.keyword.phrase, search, users, ta, ctx.account.name, now.getTime());
  const { top: _top, ta: _ta, guides = [], acc: _acc, ...rest } = agg;
  await prisma.$transaction([
    prisma.kwSerpSnapshot.create({
      data: {
        keywordId: t.keyword.id, accountId: ctx.account.id, takenAt: now,
        agg: rest as unknown as Prisma.InputJsonValue, typeahead: ta, guides,
        pins: { create: top.map((p) => ({ ...p, domain: p.domain?.slice(0, 190) ?? null, linkHash: p.link?.startsWith("http") ? urlHash(p.link) : null })) },
      },
    }),
    prisma.kwTask.update({ where: { id: t.id }, data: { status: "DONE", leaseUntil: null, payload: Prisma.DbNull, error: null } }),
  ]);
  await recomputeKeywords([t.keyword.id], now);
  return { ok: true, n: agg.n, gapSec: ctx.account.gapSec };
}

/** Частотность из Ads Manager: `reach_estimate` перехваченного `get_audience_sizing_handler` (или тайм-аут). */
export async function volume(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const t = await leasedTask(ctx, b.taskId, "volume");
  const ms = typeof b.ms === "number" ? Math.round(b.ms) : null;
  const v = b.error ? null : parseSizing(b.reach);
  if (!v) {
    const err = typeof b.error === "string" ? b.error.slice(0, 180) : "непонятный ответ Ads Manager";
    await event(ctx.account.id, "volume", "error", ms, `${t.keyword.phrase}: ${err}`);
    await requeue(t.id, t.attempts, err);
    return { ok: false, retry: t.attempts < MAX_ATTEMPTS };
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.kwVolume.create({ data: { keywordId: t.keyword.id, estimate: v.estimate, lower: v.lower, upper: v.upper, none: v.none, source: "ads_ui", region: "US", takenAt: now } }),
    prisma.kwTask.update({ where: { id: t.id }, data: { status: "DONE", leaseUntil: null, error: null } }),
  ]);
  await event(ctx.account.id, "volume", v.none ? "empty" : "ok", ms, `${t.keyword.phrase}: ${v.none ? "нет данных" : v.estimate}`);
  await recomputeKeywords([t.keyword.id], now);
  return { ok: true, estimate: v.estimate, none: v.none };
}

/** Ошибка на стороне браузера до ответа Pinterest (нет сети, не вошли в аккаунт): задание — обратно в очередь. */
export async function fail(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const kind: Mode = b.kind === "volume" ? "volume" : "serp";
  const t = await leasedTask(ctx, b.taskId, kind);
  const err = str(b.error, 180) ?? "ошибка в браузере";
  await event(ctx.account.id, kind, "error", null, `${t.keyword.phrase}: ${err}`);
  await requeue(t.id, Math.max(0, t.attempts - 1), err); // сбой браузера попытку не съедает
  return { ok: true };
}

/** Строка состояния расширения (что делает сейчас). */
export async function state(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  return { ok: true };
}

// ---------------- очередь ----------------

/**
 * Ставит ключи в очередь; ключ, у которого уже есть открытое задание того же вида, пропускается.
 * С accountId (задание для конкретного аккаунта — сравнение аккаунтов) мешают только открытые задания этого же аккаунта:
 * один ключ может одновременно ждать снимка с двух аккаунтов.
 */
export async function enqueue(kind: Mode, keywordIds: string[], accountId: string | null = null): Promise<number> {
  if (!keywordIds.length) return 0;
  const open = new Set((await prisma.kwTask.findMany({ where: { kind, status: { in: ["QUEUED", "LEASED"] }, keywordId: { in: keywordIds }, ...(accountId ? { accountId } : {}) }, select: { keywordId: true } })).map((t) => t.keywordId));
  const data = [...new Set(keywordIds)].filter((id) => !open.has(id)).map((keywordId) => ({ kind, keywordId, accountId }));
  let n = 0;
  for (let i = 0; i < data.length; i += 500) n += (await prisma.kwTask.createMany({ data: data.slice(i, i + 500) })).count;
  return n;
}
