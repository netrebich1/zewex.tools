"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireKeywords } from "@/lib/keywords/access";
import { enqueue, issueToken } from "@/lib/keywords/collector";
import { COMPARE_DEFAULT, createCompare } from "@/lib/keywords/compare";
import { importStarter } from "@/lib/keywords/import";
import { keywordOrder, keywordWhere, type Params, type Tab } from "@/lib/keywords/query";
import { recomputeKeywords } from "@/lib/keywords/recompute";
import { STATUSES } from "@/lib/keywords/types";
import { FIELD } from "@/lib/keywords/fields";

export type FormState = { error?: string; ok?: string };
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

/** Загрузка стартовых данных ручного сбора (только админ). Повторный запуск ничего не дублирует. */
export async function importStarterAction(_p: FormState, _f: FormData): Promise<FormState> {
  const me = await requireKeywords();
  if (me.role !== "ADMIN") return { error: "Загружать стартовые данные может только админ" };
  try {
    const r = await importStarter();
    console.log(`[keywords] starter import by ${me.email}: ${JSON.stringify(r)}`);
    revalidatePath("/pinterest/keywords", "layout");
    return { ok: `Готово: ключей ${r.keywords} (новых ${r.created}), частотностей ${r.volumes}, снимков выдачи ${r.snapshots}, дат статей ${r.articles}.` };
  } catch (e) {
    return fail(e);
  }
}

/** Пересчитать оценку, вердикт и флаги всех ключей (возраст статей растёт со временем). */
export async function recomputeAction(_p: FormState, _f: FormData): Promise<FormState> {
  await requireKeywords();
  try {
    const n = await recomputeKeywords();
    revalidatePath("/pinterest/keywords", "layout");
    return { ok: `Пересчитано ключей: ${n}` };
  } catch (e) {
    return fail(e);
  }
}

/** Статус ключа: в работу / отклонён / не разобран. */
export async function setKeywordStatus(id: string, status: string): Promise<{ status: string }> {
  await requireKeywords();
  if (!STATUSES.some((s) => s.key === status)) throw new Error("Неизвестный статус");
  const k = await prisma.kwKeyword.update({ where: { id }, data: { status }, select: { status: true } });
  revalidatePath("/pinterest/keywords", "layout");
  return k;
}

// ---------------- Сбор: расширение, аккаунты, очередь (этап 2) ----------------

const COLLECT = "/pinterest/keywords/collect";
const intOrNull = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : Number.isFinite(Number(s)) ? Math.max(0, Math.round(Number(s))) : NaN;
};

/** Новый аккаунт Pinterest (имя для людей: «SEO Netrebich», «W»). Логин расширение запомнит само. */
export async function addAccountAction(_p: FormState, f: FormData): Promise<FormState> {
  await requireKeywords();
  const name = String(f.get("name") ?? "").trim().slice(0, 120);
  if (!name) return { error: "Впишите название аккаунта" };
  if (await prisma.kwAccount.findUnique({ where: { name } })) return { error: "Такой аккаунт уже есть" };
  await prisma.kwAccount.create({ data: { name, gapSec: 10 } });
  revalidatePath(COLLECT);
  return { ok: `Аккаунт «${name}» добавлен. Теперь выдайте для него токен расширения.` };
}

/** Настройки аккаунта: режим, пауза между ключами, лимит в сутки (пусто — без лимита), логин Pinterest. */
export async function saveAccountAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireKeywords();
  const id = String(f.get("id") ?? "");
  const a = await prisma.kwAccount.findUnique({ where: { id } });
  if (!a) return { error: "Аккаунт не найден" };
  const status = String(f.get("status") ?? a.status);
  if (!["ACTIVE", "SLOW", "OFF", "LIMITED"].includes(status)) return { error: "Неизвестный режим" };
  const gap = intOrNull(f.get("gapSec"));
  const cap = intOrNull(f.get("dailyCap"));
  if (gap == null || Number.isNaN(gap) || gap < 3 || gap > 600) return { error: "Пауза между ключами — от 3 до 600 секунд" };
  if (Number.isNaN(cap)) return { error: "Лимит в сутки — число или пусто" };
  const username = String(f.get("username") ?? "").trim().replace(/^@/, "").toLowerCase() || null;
  if (username && username !== a.username && (await prisma.kwAccount.findFirst({ where: { username, id: { not: id } } }))) return { error: `@${username} уже записан у другого аккаунта` };
  // Ручная смена режима снимает и ограничение, и паузы.
  const manual = status !== a.status && status !== "LIMITED";
  await prisma.kwAccount.update({
    where: { id },
    data: { status, gapSec: gap, dailyCap: cap, username, ...(manual ? { limitedUntil: null, pausedUntil: null, blockStep: 0 } : {}) },
  });
  if (manual) await prisma.kwAccountEvent.create({ data: { accountId: id, kind: "manual", result: "ok", note: `режим «${status}» поставил ${me.name || me.email}` } });
  revalidatePath(COLLECT);
  return { ok: "Сохранено" };
}

/** Снять ограничение вручную (поиск в браузере снова работает). */
export async function liftLimitAction(id: string): Promise<void> {
  const me = await requireKeywords();
  const a = await prisma.kwAccount.findUnique({ where: { id } });
  if (!a) return;
  await prisma.kwAccount.update({ where: { id }, data: { status: a.gapSec >= 20 ? "SLOW" : "ACTIVE", limitedUntil: null, pausedUntil: null, blockStep: 0 } });
  await prisma.kwAccountEvent.create({ data: { accountId: id, kind: "manual", result: "ok", note: `ограничение снял ${me.name || me.email}` } });
  revalidatePath(COLLECT);
}

export type TokenState = FormState & { token?: string };

/** Токен для расширения: показывается один раз. Привязан к аккаунту Pinterest и к тому, кто выдал. */
export async function issueTokenAction(_p: TokenState, f: FormData): Promise<TokenState> {
  const me = await requireKeywords();
  const accountId = String(f.get("accountId") ?? "");
  const acc = await prisma.kwAccount.findUnique({ where: { id: accountId } });
  if (!acc) return { error: "Выберите аккаунт Pinterest" };
  const name = String(f.get("name") ?? "").trim() || `${acc.name} · ${me.name || me.email}`;
  const token = await issueToken(me.id, name, acc.id);
  console.log(`[keywords] collector token issued by ${me.email} for account ${acc.name}`);
  revalidatePath(COLLECT);
  return { ok: `Токен для «${acc.name}» готов. Скопируйте его в окно расширения — второй раз он не покажется.`, token };
}

/** Отозвать токен: своё расширение — любой, чужое — админ. */
export async function revokeCollectorAction(id: string): Promise<void> {
  const me = await requireKeywords();
  const c = await prisma.kwCollector.findUnique({ where: { id } });
  if (!c || (c.userId !== me.id && me.role !== "ADMIN")) return;
  await prisma.$transaction([
    prisma.kwCollector.update({ where: { id }, data: { revokedAt: new Date() } }),
    prisma.kwTask.updateMany({ where: { status: "LEASED", collectorId: id }, data: { status: "QUEUED", leaseUntil: null, collectorId: null } }),
  ]);
  revalidatePath(COLLECT);
}

/** Поставить ключи в очередь сбора по условиям формы на вкладке «Сбор». */
export async function enqueueAction(_p: FormState, f: FormData): Promise<FormState> {
  await requireKeywords();
  const kind = f.get("kind") === "volume" ? "volume" : "serp";
  const scope = String(f.get("scope") ?? "missing");
  const tab = String(f.get("tab") ?? "main");
  const niche = String(f.get("niche") ?? "");
  const days = intOrNull(f.get("days")) || (kind === "volume" ? 60 : 30);
  const vmin = intOrNull(f.get("vmin"));
  const limit = Math.min(5000, Math.max(1, intOrNull(f.get("limit")) || 200));
  const accountId = String(f.get("accountId") ?? "") || null;
  const and: Prisma.KwKeywordWhereInput[] = [{ season: { not: "hard" } }];
  if (tab === "main") and.push({ OR: [{ source: "sheet" }, { status: { in: ["picked", "sent"] } }] });
  if (tab === "new") and.push({ source: { not: "sheet" }, status: "new" });
  if (niche) and.push({ niche });
  const old = new Date(Date.now() - days * 864e5);
  if (kind === "volume") {
    if (scope === "missing") and.push({ volAt: null });
    if (scope === "older") and.push({ OR: [{ volAt: null }, { volAt: { lt: old } }] });
  } else {
    if (scope === "missing") and.push({ serpAt: null });
    if (scope === "older") and.push({ OR: [{ serpAt: null }, { serpAt: { lt: old } }] });
    if (vmin != null && !Number.isNaN(vmin) && vmin > 0) and.push({ volume: { gte: vmin } });
  }
  const ids = (await prisma.kwKeyword.findMany({ where: { AND: and }, orderBy: [{ volume: { sort: "desc", nulls: "last" } }, { phrase: "asc" }], take: limit, select: { id: true } })).map((k) => k.id);
  const n = await enqueue(kind, ids, accountId);
  revalidatePath(COLLECT);
  return { ok: `В очередь ${kind === "volume" ? "частотности" : "выдачи"} добавлено ключей: ${n}${ids.length > n ? ` (ещё ${ids.length - n} уже стояли в очереди)` : ""}.` };
}

/** Один ключ — снять выдачу или частотность заново (кнопка в раскрытой строке). */
export async function enqueueKeywordAction(id: string, kind: "serp" | "volume"): Promise<{ added: number }> {
  await requireKeywords();
  const added = await enqueue(kind === "volume" ? "volume" : "serp", [id]);
  revalidatePath(COLLECT);
  return { added };
}

/** Все ключи текущей выборки экрана «Ключи»/«Новые» (фильтры из адреса, до 5000) — в очередь. */
export async function enqueueFilteredAction(tab: Tab, params: Params, kind: "serp" | "volume"): Promise<{ added: number; total: number }> {
  await requireKeywords();
  const ids = (await prisma.kwKeyword.findMany({ where: keywordWhere(tab === "new" ? "new" : "main", params), orderBy: keywordOrder(params), take: 5000, select: { id: true } })).map((k) => k.id);
  const added = await enqueue(kind === "volume" ? "volume" : "serp", ids);
  revalidatePath(COLLECT);
  return { added, total: ids.length };
}

/** Очередь: убрать ждущие задания вида kind или вернуть упавшие. */
export async function queueControlAction(op: "clear" | "retry", kind: "serp" | "volume"): Promise<void> {
  await requireKeywords();
  if (op === "clear") await prisma.kwTask.deleteMany({ where: { kind, status: "QUEUED" } });
  else await prisma.kwTask.updateMany({ where: { kind, status: "FAILED" }, data: { status: "QUEUED", attempts: 0, error: null } });
  revalidatePath(COLLECT);
}

// ---------------- Сравнение аккаунтов ----------------

/** Новая выборка для сравнения двух аккаунтов: одни и те же ключи в очередь выдачи для обоих. */
export async function compareAccountsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireKeywords();
  const a = String(f.get("accountA") ?? "");
  const b = String(f.get("accountB") ?? "");
  const count = Number(f.get("count") ?? COMPARE_DEFAULT) || COMPARE_DEFAULT;
  let r: Awaited<ReturnType<typeof createCompare>>;
  try {
    r = await createCompare(a, b, count, me.name || me.email);
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/pinterest/keywords/compare");
  revalidatePath(COLLECT);
  redirect(`/pinterest/keywords/compare?id=${r.id}`);
}

// ---------------- Виды экрана и колонки ----------------

export type ViewItem = { id: string; name: string; query: string; columns: string[] | null; shared: boolean; mine: boolean };

/** Сохранить текущие фильтры (и колонки) как вид. Тот же автор + то же имя — перезаписывает. */
export async function saveViewAction(name: string, query: string, columns: string[] | null, shared: boolean): Promise<ViewItem> {
  const me = await requireKeywords();
  const n = name.trim().slice(0, 120);
  if (!n) throw new Error("Впишите название");
  const q = query.replace(/(^|&)pg=\d+/g, "").replace(/^&/, "").slice(0, 4000);
  const cols = columns ? columns.filter((c) => FIELD.has(c)).slice(0, 80) : null;
  const ex = await prisma.kwView.findFirst({ where: { userId: me.id, name: n } });
  const data = { query: q, columns: cols ?? Prisma.DbNull, shared };
  const v = ex ? await prisma.kwView.update({ where: { id: ex.id }, data }) : await prisma.kwView.create({ data: { userId: me.id, name: n, ...data } });
  return { id: v.id, name: v.name, query: v.query, columns: (v.columns as string[] | null) ?? null, shared: v.shared, mine: true };
}

/** Удалить вид: свой — любой, чужой общий — только админ. */
export async function deleteViewAction(id: string): Promise<void> {
  const me = await requireKeywords();
  const v = await prisma.kwView.findUnique({ where: { id } });
  if (!v || (v.userId !== me.id && me.role !== "ADMIN")) return;
  await prisma.kwView.delete({ where: { id } });
}

/** Колонки таблицы и размер страницы — личная настройка. */
export async function savePrefsAction(columns: string[], perPage?: number): Promise<void> {
  const me = await requireKeywords();
  const cols = columns.filter((c) => FIELD.has(c)).slice(0, 80);
  const pp = perPage && [25, 50, 100, 200].includes(perPage) ? perPage : undefined;
  await prisma.kwPrefs.upsert({ where: { userId: me.id }, update: { columns: cols, ...(pp ? { perPage: pp } : {}) }, create: { userId: me.id, columns: cols, perPage: pp ?? 50 } });
}
