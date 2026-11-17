"use server";
/** Раздел «Проекты»: ручной слой карточки (статус, этапы, задачи, заметки, кластеры, заливка выгрузок). Все правки пишут историю. */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { loadAccessForUser } from "@/lib/projects/access";
import { ensureCard } from "@/lib/projects/card";
import { logEventByCard, logEventByPinSite, eventText } from "@/lib/projects/events";
import { DEFAULT_STEPS, PROJECT_STATUSES, statusLabel } from "@/lib/projects/steps";
import { canAccessPinSite } from "@/lib/sites/access";
import { slugify } from "@/lib/utils";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const dateOrNull = (s: string): Date | null => { if (!s) return null; const d = new Date(s.length === 10 ? `${s}T12:00:00Z` : s); return Number.isNaN(d.getTime()) ? null : d; };

/** Карточка по доступу с проверкой, что сайт виден этому человеку. */
async function cardFor(me: CurrentUser, accessId: string) {
  const access = await loadAccessForUser(me, accessId);
  if (!access) throw new Error("Сайт не найден или закрыт для вас");
  const card = await ensureCard(accessId);
  return { access, card };
}
const refresh = (accessId: string) => { revalidatePath(`/pinterest/projects/${accessId}`); revalidatePath("/pinterest/projects"); revalidatePath("/pinterest/projects/tasks"); };
async function userName(id: string | null): Promise<string> {
  if (!id) return "никто";
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true, email: true } });
  return u?.name || u?.email || "сотрудник";
}

export async function setProjectStatus(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), status = str(f, "status");
  if (!PROJECT_STATUSES.some((s) => s.key === status)) return { error: "Неизвестный статус" };
  try {
    const { card } = await cardFor(me, accessId);
    if (card.status === status) return {};
    await prisma.prjCard.update({ where: { id: card.id }, data: { status: status as never } });
    await logEventByCard(card.id, { kind: "status_changed", userId: me.id, summary: `Статус: ${statusLabel(card.status)} → ${statusLabel(status)}` });
    refresh(accessId);
    return { ok: "Статус изменён" };
  } catch (e) { return fail(e); }
}

export async function setProjectOwner(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), ownerId = str(f, "ownerId") || null;
  try {
    const { card } = await cardFor(me, accessId);
    if (card.ownerId === ownerId) return {};
    await prisma.prjCard.update({ where: { id: card.id }, data: { ownerId } });
    await logEventByCard(card.id, { kind: "owner_changed", userId: me.id, summary: `Ответственный: ${await userName(ownerId)}` });
    refresh(accessId);
    return { ok: "Ответственный изменён" };
  } catch (e) { return fail(e); }
}

/** Поля карточки одной формой: ниша, «что дальше», стратегии, описание, Pinterest-аккаунт. */
export async function saveProjectCard(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId");
  try {
    const { card } = await cardFor(me, accessId);
    const strategies = [...new Set(str(f, "strategies").split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean))];
    const before = ((card.strategies as string[] | null) ?? []).join(", ");
    const data = {
      niche: str(f, "niche") || null,
      nextAction: str(f, "nextAction") || null,
      nextDueAt: dateOrNull(str(f, "nextDueAt")),
      strategies,
      summary: str(f, "summary") || null,
      pinAccount: str(f, "pinAccount") || null,
      pinUrl: str(f, "pinUrl") || null,
      pinStartedAt: dateOrNull(str(f, "pinStartedAt")),
      pinStatus: str(f, "pinStatus") || null,
      pinNotes: str(f, "pinNotes") || null,
      priority: Number(str(f, "priority")) || 0,
    };
    await prisma.prjCard.update({ where: { id: card.id }, data });
    if (strategies.join(", ") !== before) await logEventByCard(card.id, { kind: "strategy_changed", userId: me.id, summary: `Стратегии: ${strategies.join(", ") || "—"}` });
    else await logEventByCard(card.id, { kind: "card_changed", userId: me.id, summary: data.nextAction ? `Что дальше: ${data.nextAction}` : "Карточка обновлена" });
    refresh(accessId);
    return { ok: "Сохранено" };
  } catch (e) { return fail(e); }
}

/** Этап: клик по кнопке переключает состояние (todo → doing → done → todo), «не нужно» — отдельной кнопкой. */
export async function setProjectStep(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), stepId = str(f, "stepId"), state = str(f, "state");
  if (!["todo", "doing", "done", "skip"].includes(state)) return { error: "Неизвестное состояние" };
  try {
    const { card } = await cardFor(me, accessId);
    const step = await prisma.prjStep.findFirst({ where: { id: stepId, cardId: card.id } });
    if (!step) return { error: "Этап не найден" };
    await prisma.prjStep.update({ where: { id: step.id }, data: { state, doneAt: state === "done" ? new Date() : null, doneById: state === "done" ? me.id : null, note: str(f, "note") || step.note } });
    const label = { todo: "не начато", doing: "в работе", done: "сделано", skip: "не нужно" }[state];
    await logEventByCard(card.id, { kind: "step_changed", userId: me.id, summary: `Этап «${step.title}»: ${label}` });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function addProjectStep(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), title = str(f, "title");
  if (!title) return { error: "Введите название этапа" };
  try {
    const { card } = await cardFor(me, accessId);
    const key = `custom:${slugify(title)}-${Date.now().toString(36)}`;
    const order = (await prisma.prjStep.count({ where: { cardId: card.id } })) + DEFAULT_STEPS.length;
    await prisma.prjStep.create({ data: { cardId: card.id, key, title, order } });
    await logEventByCard(card.id, { kind: "step_changed", userId: me.id, summary: `Добавлен этап «${title}»` });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function deleteProjectStep(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), stepId = str(f, "stepId");
  try {
    const { card } = await cardFor(me, accessId);
    const step = await prisma.prjStep.findFirst({ where: { id: stepId, cardId: card.id } });
    if (!step) return { error: "Этап не найден" };
    if (!step.key.startsWith("custom:")) return { error: "Предзаданный этап можно отметить «не нужно», но не удалить" };
    await prisma.prjStep.delete({ where: { id: step.id } });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function addProjectNote(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), text = str(f, "text");
  if (!text) return { error: "Пустая заметка" };
  try {
    const { card } = await cardFor(me, accessId);
    await prisma.prjNote.create({ data: { cardId: card.id, userId: me.id, text } });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function deleteProjectNote(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), noteId = str(f, "noteId");
  try {
    const { card } = await cardFor(me, accessId);
    const note = await prisma.prjNote.findFirst({ where: { id: noteId, cardId: card.id } });
    if (!note) return { error: "Заметка не найдена" };
    if (note.userId !== me.id && me.role !== "ADMIN") return { error: "Удалить может автор или админ" };
    await prisma.prjNote.delete({ where: { id: note.id } });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

// ── Задачи ──
export async function addProjectTask(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), title = str(f, "title");
  if (!title) return { error: "Введите задачу" };
  try {
    const { card } = await cardFor(me, accessId);
    const assigneeId = str(f, "assigneeId") || null;
    const task = await prisma.prjTask.create({ data: { cardId: card.id, title, description: str(f, "description") || null, assigneeId, dueAt: dateOrNull(str(f, "dueAt")), createdById: me.id } });
    await logEventByCard(card.id, { kind: "task_created", userId: me.id, refId: task.id, summary: `Задача: ${title}${assigneeId ? ` → ${await userName(assigneeId)}` : ""}${task.dueAt ? ` до ${task.dueAt.toLocaleDateString("ru-RU")}` : ""}` });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function setProjectTask(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), taskId = str(f, "taskId"), status = str(f, "status");
  if (!["open", "doing", "done", "delete"].includes(status)) return { error: "Неизвестный статус" };
  try {
    const { card } = await cardFor(me, accessId);
    const task = await prisma.prjTask.findFirst({ where: { id: taskId, cardId: card.id } });
    if (!task) return { error: "Задача не найдена" };
    if (status === "delete") {
      await prisma.prjTask.delete({ where: { id: task.id } });
    } else {
      await prisma.prjTask.update({ where: { id: task.id }, data: { status, doneAt: status === "done" ? new Date() : null, doneById: status === "done" ? me.id : null } });
      if (status === "done" && task.status !== "done") await logEventByCard(card.id, { kind: "task_done", userId: me.id, refId: task.id, summary: `Сделано: ${task.title}` });
    }
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

// ── Кластеры ──
export async function saveProjectCluster(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), id = str(f, "id"), name = str(f, "name");
  if (!name) return { error: "Введите название кластера" };
  try {
    const { card } = await cardFor(me, accessId);
    const keywords = str(f, "keywords") || null;
    const keywordsCount = keywords ? keywords.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean).length : Number(str(f, "keywordsCount")) || 0;
    const status = ["planned", "written", "pinned"].includes(str(f, "status")) ? str(f, "status") : "planned";
    const data = { name, keywords, keywordsCount, status, articleUrl: str(f, "articleUrl") || null, note: str(f, "note") || null };
    if (id) {
      const c = await prisma.prjCluster.findFirst({ where: { id, cardId: card.id } });
      if (!c) return { error: "Кластер не найден" };
      await prisma.prjCluster.update({ where: { id }, data });
      if (c.status !== status || c.name !== name) await logEventByCard(card.id, { kind: "cluster_changed", userId: me.id, refId: id, summary: `Кластер «${name}»: ${status === "pinned" ? "пины есть" : status === "written" ? "статья есть" : "прописан"}` });
    } else {
      const c = await prisma.prjCluster.create({ data: { ...data, cardId: card.id } });
      await logEventByCard(card.id, { kind: "cluster_changed", userId: me.id, refId: c.id, summary: `Кластер «${name}» добавлен (${keywordsCount} ключ.)` });
    }
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

/** Быстрый ввод: по одному кластеру на строку («название | ключей» или просто название). */
export async function addProjectClustersBulk(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId");
  const lines = str(f, "lines").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { error: "Пусто" };
  try {
    const { card } = await cardFor(me, accessId);
    const data = lines.map((l) => { const [name, cnt] = l.split("|").map((s) => s.trim()); return { cardId: card.id, name, keywordsCount: Number(cnt) || 0 }; }).filter((d) => d.name);
    await prisma.prjCluster.createMany({ data });
    await logEventByCard(card.id, { kind: "cluster_changed", userId: me.id, summary: `Добавлено кластеров: ${data.length}` });
    refresh(accessId);
    return { ok: `Добавлено: ${data.length}` };
  } catch (e) { return fail(e); }
}

export async function deleteProjectCluster(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId"), id = str(f, "id");
  try {
    const { card } = await cardFor(me, accessId);
    await prisma.prjCluster.deleteMany({ where: { id, cardId: card.id } });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

// ── Заливка выгрузок в Pinterest ──
async function pinSiteFor(me: CurrentUser, pinSiteId: string) {
  const site = await prisma.pinSite.findUnique({ where: { id: pinSiteId }, select: { id: true, teamId: true, wpConnectionId: true } });
  if (!site || !(await canAccessPinSite(me, site))) throw new Error("Сайт пинов не найден или закрыт для вас");
  return site;
}

export async function markUploaded(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const pinSiteId = str(f, "pinSiteId"), day = str(f, "day"), accessId = str(f, "accessId");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Неверный день" };
  try {
    await pinSiteFor(me, pinSiteId);
    await prisma.prjUpload.upsert({ where: { pinSiteId_day: { pinSiteId, day } }, update: { uploadedAt: new Date(), uploadedById: me.id, source: "manual" }, create: { pinSiteId, day, uploadedById: me.id, source: "manual" } });
    await logEventByPinSite(pinSiteId, { kind: "export_uploaded", userId: me.id, refId: `${pinSiteId}|${day}`, summary: eventText.exportUploaded(day) });
    if (accessId) refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function unmarkUploaded(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const pinSiteId = str(f, "pinSiteId"), day = str(f, "day"), accessId = str(f, "accessId");
  try {
    await pinSiteFor(me, pinSiteId);
    await prisma.prjUpload.deleteMany({ where: { pinSiteId, day } });
    await logEventByPinSite(pinSiteId, { kind: "export_unmarked", userId: me.id, summary: `Снята отметка заливки за ${day}` });
    if (accessId) refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

/** «Залито всё по эту дату»: отмечает все дни с выгрузкой ≤ day, у которых отметки ещё нет. */
export async function markUploadedThrough(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const pinSiteId = str(f, "pinSiteId"), day = str(f, "day"), accessId = str(f, "accessId");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Укажите дату" };
  try {
    await pinSiteFor(me, pinSiteId);
    const [days, have] = await Promise.all([
      prisma.pinExportLog.findMany({ where: { siteId: pinSiteId, day: { lte: day } }, select: { day: true }, distinct: ["day"] }),
      prisma.prjUpload.findMany({ where: { pinSiteId }, select: { day: true } }),
    ]);
    const haveSet = new Set(have.map((h) => h.day));
    const todo = days.map((d) => d.day).filter((d) => !haveSet.has(d));
    if (todo.length) await prisma.prjUpload.createMany({ data: todo.map((d) => ({ pinSiteId, day: d, uploadedById: me.id, source: "manual" })), skipDuplicates: true });
    await logEventByPinSite(pinSiteId, { kind: "export_uploaded", userId: me.id, summary: `Залито в Pinterest всё по ${day} (${todo.length} дн.)` });
    if (accessId) refresh(accessId);
    return { ok: `Отмечено дней: ${todo.length}` };
  } catch (e) { return fail(e); }
}
