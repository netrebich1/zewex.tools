"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { randomToken } from "@/lib/crypto";
import { requireTasks, taskPeople } from "@/lib/tasks/access";
import { isMode, isRule, isStatus, isYmd, normPriority, statusLabel, todayYmd, ymdToDate, type Status } from "@/lib/tasks/consts";
import { createFromQuick, logEvent, moveDay, planOn, setStatus } from "@/lib/tasks/ops";
import { firstNext } from "@/lib/tasks/routines";
import { appUrl, esc, tgGetMe } from "@/lib/tasks/telegram";
import { notifyUser } from "@/lib/tasks/digest";

export type TkState = { error?: string; ok?: string; at?: number; id?: string };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || null;
const date = (f: FormData, k: string) => { const v = str(f, k); if (!v) return null; if (!isYmd(v)) throw new Error("Неверная дата"); return ymdToDate(v); };
const fail = (e: unknown): TkState => ({ error: e instanceof Error ? e.message : String(e) });
const done = (ok: string, extra: Partial<TkState> = {}): TkState => { revalidatePath("/tasks", "layout"); return { ok, at: Date.now(), ...extra }; };

/* ---------- Быстрый ввод ---------- */

export async function quickAdd(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const text = str(f, "text");
    if (!text) throw new Error("Напишите, что сделать");
    const status = str(f, "status");
    const r = await createFromQuick(text, me.id, { projectId: opt(f, "projectId"), assigneeId: opt(f, "assigneeId"), parentId: opt(f, "parentId"), status: isStatus(status) ? status : undefined });
    const plan = str(f, "planDate");
    if (plan && isYmd(plan) && !r.parsed.planDate) await prisma.tkTask.update({ where: { id: r.id }, data: { planDate: ymdToDate(plan), status: status && isStatus(status) ? status : "planned" } });
    const assignee = await prisma.tkTask.findUnique({ where: { id: r.id }, select: { assigneeId: true } });
    if (assignee?.assigneeId && assignee.assigneeId !== me.id) void notifyUser(assignee.assigneeId, `➕ <b>${esc(me.name)}</b> поставил(а) вам задачу:\n<a href="${appUrl(`/tasks/t/${r.id}`)}">${esc(r.title)}</a>`);
    const warn = r.unknown.length ? ` (не нашёл: ${r.unknown.join(", ")})` : "";
    return done(`Добавлено: ${r.title}${warn}`, { id: r.id });
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Задача: сохранить / удалить ---------- */

export async function saveTask(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const id = str(f, "id");
    const title = str(f, "title").slice(0, 300);
    if (!title) throw new Error("Название обязательно");
    const mode = str(f, "mode"); if (!isMode(mode)) throw new Error("Выберите способ");
    const status = str(f, "status"); if (!isStatus(status)) throw new Error("Выберите статус");
    const people = await taskPeople();
    const assigneeId = opt(f, "assigneeId");
    if (assigneeId && !people.some((p) => p.id === assigneeId)) throw new Error("Исполнитель не найден");
    const projectId = opt(f, "projectId");
    if (projectId && !(await prisma.tkProject.findUnique({ where: { id: projectId }, select: { id: true } }))) throw new Error("Проект не найден");
    const parentId = opt(f, "parentId");
    if (parentId && parentId === id) throw new Error("Задача не может быть своей подзадачей");
    const labelIds = f.getAll("labelIds").map(String).filter(Boolean);
    const data = {
      title, description: opt(f, "description")?.slice(0, 20000) ?? null, mode, status, priority: normPriority(str(f, "priority")),
      assigneeId, projectId, parentId, counterpart: mode === "do" ? null : opt(f, "counterpart")?.slice(0, 120) ?? null,
      waitUntil: mode === "do" ? null : date(f, "waitUntil"), planDate: date(f, "planDate"), startAt: date(f, "startAt"), dueAt: date(f, "dueAt"),
    };
    if (status === "planned" && !data.planDate) data.planDate = ymdToDate(todayYmd());
    if (id) {
      const old = await prisma.tkTask.findUnique({ where: { id }, select: { status: true, assigneeId: true, title: true } });
      if (!old) throw new Error("Задача не найдена");
      await prisma.tkTask.update({ where: { id }, data: { ...data, doneAt: status === "done" ? (old.status === "done" ? undefined : new Date()) : null, labels: { deleteMany: {}, create: labelIds.map((labelId) => ({ labelId })) } } });
      if (old.status !== status) await logEvent(id, me.id, `${statusLabel(old.status)} → ${statusLabel(status)}`);
      if (old.assigneeId !== assigneeId) {
        await logEvent(id, me.id, `Исполнитель: ${people.find((p) => p.id === assigneeId)?.name ?? "никто"}`);
        if (assigneeId && assigneeId !== me.id) void notifyUser(assigneeId, `➜ <b>${esc(me.name)}</b> назначил(а) вам задачу:\n<a href="${appUrl(`/tasks/t/${id}`)}">${esc(title)}</a>`);
      }
      return done("Сохранено", { id });
    }
    const last = await prisma.tkTask.aggregate({ _min: { order: true }, where: { status } });
    const t = await prisma.tkTask.create({ data: { ...data, order: (last._min.order ?? 0) - 1, createdById: me.id, labels: { create: labelIds.map((labelId) => ({ labelId })) } } });
    if (assigneeId && assigneeId !== me.id) void notifyUser(assigneeId, `➕ <b>${esc(me.name)}</b> поставил(а) вам задачу:\n<a href="${appUrl(`/tasks/t/${t.id}`)}">${esc(title)}</a>`);
    return done("Создано", { id: t.id });
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTask(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    await prisma.tkTask.updateMany({ where: { parentId: id }, data: { parentId: null } });
    await prisma.tkTask.delete({ where: { id } });
    revalidatePath("/tasks", "layout");
  } catch (e) {
    return fail(e);
  }
  redirect(str(f, "back") || "/tasks/board");
}

/* ---------- Быстрые действия (кнопки в карточке / канбане) ---------- */

export async function changeStatus(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    await setStatus(str(f, "id"), str(f, "status"), me.id);
    return done("Статус изменён");
  } catch (e) { return fail(e); }
}

/** Перетаскивание в канбане: новый статус и порядок соседей (id через запятую). */
export async function moveCard(id: string, status: string, orderedIds: string[]): Promise<TkState> {
  const me = await requireTasks();
  try {
    if (!isStatus(status)) throw new Error("Неизвестный статус");
    const t = await prisma.tkTask.findUnique({ where: { id }, select: { status: true } });
    if (!t) throw new Error("Задача не найдена");
    if (t.status !== status) await setStatus(id, status, me.id);
    await prisma.$transaction(orderedIds.slice(0, 500).map((tid, i) => prisma.tkTask.update({ where: { id: tid }, data: { order: i } })));
    revalidatePath("/tasks", "layout");
    return { ok: "ok" };
  } catch (e) { return fail(e); }
}

export async function planTask(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const ymd = str(f, "ymd");
    if (!isYmd(ymd)) throw new Error("Неверная дата");
    await planOn(str(f, "id"), ymd, me.id);
    return done("Запланировано");
  } catch (e) { return fail(e); }
}

export async function moveAllToDay(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const from = str(f, "from"), to = str(f, "to");
    if (!isYmd(from) || !isYmd(to)) throw new Error("Неверная дата");
    const n = await moveDay(from, to, opt(f, "assigneeId"), me.id);
    return done(n ? `Перенесено: ${n}` : "Нечего переносить");
  } catch (e) { return fail(e); }
}

export async function nudged(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const id = str(f, "id");
    const days = Math.max(1, Math.min(30, Number(str(f, "days")) || 2));
    const until = new Date(ymdToDate(todayYmd())); until.setUTCDate(until.getUTCDate() + days);
    await prisma.tkTask.update({ where: { id }, data: { nudgedAt: new Date(), waitUntil: until, status: "waiting" } });
    await logEvent(id, me.id, `Напомнили, ждём ещё ${days} дн.`);
    return done("Отмечено");
  } catch (e) { return fail(e); }
}

/* ---------- Комментарии и чеклист ---------- */

export async function addNote(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const taskId = str(f, "taskId"), text = str(f, "text").slice(0, 5000);
    if (!text) throw new Error("Пустой комментарий");
    await prisma.tkNote.create({ data: { taskId, userId: me.id, kind: "comment", text } });
    const t = await prisma.tkTask.findUnique({ where: { id: taskId }, select: { title: true, assigneeId: true, createdById: true } });
    const others = new Set([t?.assigneeId, t?.createdById].filter((x): x is string => !!x && x !== me.id));
    for (const uid of others) void notifyUser(uid, `💬 <b>${esc(me.name)}</b> в задаче <a href="${appUrl(`/tasks/t/${taskId}`)}">${esc(t?.title ?? "")}</a>:\n${esc(text.slice(0, 500))}`);
    return done("Добавлено");
  } catch (e) { return fail(e); }
}

export async function addCheck(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const taskId = str(f, "taskId");
    const lines = str(f, "text").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!lines.length) throw new Error("Пустой пункт");
    const max = await prisma.tkCheck.aggregate({ _max: { order: true }, where: { taskId } });
    let o = (max._max.order ?? -1) + 1;
    await prisma.tkCheck.createMany({ data: lines.map((text) => ({ taskId, text: text.slice(0, 300), order: o++ })) });
    return done("Добавлено");
  } catch (e) { return fail(e); }
}

export async function toggleCheck(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    const c = await prisma.tkCheck.findUnique({ where: { id } });
    if (!c) throw new Error("Пункт не найден");
    await prisma.tkCheck.update({ where: { id }, data: { done: !c.done } });
    return done("");
  } catch (e) { return fail(e); }
}

export async function deleteCheck(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try { await prisma.tkCheck.delete({ where: { id: str(f, "id") } }); return done(""); } catch (e) { return fail(e); }
}

/* ---------- Проекты ---------- */

export async function saveProject(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    const name = str(f, "name").slice(0, 120);
    if (!name) throw new Error("Название обязательно");
    const parentId = opt(f, "parentId");
    if (parentId && parentId === id) throw new Error("Проект не может быть внутри себя");
    const color = /^#[0-9a-fA-F]{6}$/.test(str(f, "color")) ? str(f, "color") : "#64748b";
    const data = { name, parentId, color, ownerId: opt(f, "ownerId"), description: opt(f, "description")?.slice(0, 5000) ?? null, archived: f.get("archived") === "1" };
    if (id) { await prisma.tkProject.update({ where: { id }, data }); return done("Проект сохранён", { id }); }
    const max = await prisma.tkProject.aggregate({ _max: { order: true }, where: { parentId } });
    const p = await prisma.tkProject.create({ data: { ...data, order: (max._max.order ?? 0) + 1 } });
    return done("Проект создан", { id: p.id });
  } catch (e) { return fail(e); }
}

export async function deleteProject(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    const n = await prisma.tkTask.count({ where: { projectId: id } });
    const kids = await prisma.tkProject.count({ where: { parentId: id } });
    if (n || kids) throw new Error(`В проекте ${n} задач и ${kids} подпроектов — сначала перенесите их или заархивируйте проект`);
    await prisma.tkProject.delete({ where: { id } });
    return done("Проект удалён");
  } catch (e) { return fail(e); }
}

/* ---------- Метки ---------- */

export async function saveLabel(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    const name = str(f, "name").slice(0, 60);
    if (!name) throw new Error("Название метки обязательно");
    const color = /^#[0-9a-fA-F]{6}$/.test(str(f, "color")) ? str(f, "color") : "#64748b";
    if (id) await prisma.tkLabel.update({ where: { id }, data: { name, color } });
    else {
      const max = await prisma.tkLabel.aggregate({ _max: { order: true } });
      await prisma.tkLabel.create({ data: { name, color, order: (max._max.order ?? 0) + 1 } });
    }
    return done("Метка сохранена");
  } catch (e) { return fail(e); }
}
export async function deleteLabel(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try { await prisma.tkLabel.delete({ where: { id: str(f, "id") } }); return done("Метка удалена"); } catch (e) { return fail(e); }
}

/* ---------- Регламенты ---------- */

export async function saveRoutine(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const id = str(f, "id");
    const title = str(f, "title").slice(0, 300);
    if (!title) throw new Error("Название обязательно");
    const rule = str(f, "rule"); if (!isRule(rule)) throw new Error("Выберите расписание");
    let ruleArg = "1";
    if (rule === "weekly") { const days = f.getAll("days").map(String).filter((d) => /^[1-7]$/.test(d)); if (!days.length) throw new Error("Выберите дни недели"); ruleArg = days.join(","); }
    if (rule === "monthly") { const n = Number(str(f, "dom")); if (!(n >= 1 && n <= 31)) throw new Error("Число месяца от 1 до 31"); ruleArg = String(n); }
    if (rule === "every_n") { const n = Number(str(f, "n")); if (!(n >= 1 && n <= 365)) throw new Error("Период от 1 до 365 дней"); ruleArg = String(n); }
    const mode = str(f, "mode"); if (!isMode(mode)) throw new Error("Выберите способ");
    const steps = str(f, "steps").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const data = { title, description: opt(f, "description")?.slice(0, 5000) ?? null, rule, ruleArg, steps, mode, priority: normPriority(str(f, "priority")), assigneeId: opt(f, "assigneeId"), projectId: opt(f, "projectId"), active: f.getAll("active").map(String).includes("1") };
    const old = id ? await prisma.tkRoutine.findUnique({ where: { id }, select: { lastAt: true } }) : null;
    const nextAt = ymdToDate(firstNext(rule, ruleArg, old?.lastAt ? old.lastAt.toISOString().slice(0, 10) : null));
    if (id) await prisma.tkRoutine.update({ where: { id }, data: { ...data, nextAt } });
    else await prisma.tkRoutine.create({ data: { ...data, nextAt } });
    return done("Регламент сохранён");
  } catch (e) { return fail(e); }
}
export async function deleteRoutine(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try { await prisma.tkRoutine.delete({ where: { id: str(f, "id") } }); return done("Регламент удалён"); } catch (e) { return fail(e); }
}

/* ---------- Telegram ---------- */

export async function saveBot(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  if (!me.superAdmin) return { error: "Токен бота меняет только главный админ" };
  try {
    const token = str(f, "token");
    if (!token) {
      await prisma.tkSettings.upsert({ where: { id: "main" }, update: { botTokenEnc: null, botUsername: null, tgOffset: 0 }, create: { id: "main" } });
      return done("Бот отключён");
    }
    const me2 = await tgGetMe(token);
    if (!me2.ok) throw new Error(`Telegram не принял токен: ${me2.error}`);
    await prisma.tkSettings.upsert({ where: { id: "main" }, update: { botTokenEnc: encryptSecret(token), botUsername: me2.username, tgOffset: 0, lastError: null }, create: { id: "main", botTokenEnc: encryptSecret(token), botUsername: me2.username } });
    return done(`Бот @${me2.username} подключён`);
  } catch (e) { return fail(e); }
}

export async function saveDigestHours(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try {
    const m = Number(str(f, "morningHour")), e = Number(str(f, "eveningHour"));
    if (!(m >= 0 && m <= 23) || !(e >= 0 && e <= 23)) throw new Error("Часы от 0 до 23");
    await prisma.tkSettings.upsert({ where: { id: "main" }, update: { morningHour: m, eveningHour: e }, create: { id: "main", morningHour: m, eveningHour: e } });
    return done("Часы дайджестов сохранены");
  } catch (e) { return fail(e); }
}

/** Код привязки для сотрудника (себе — любой с доступом; другим — главный админ). */
export async function issueLinkCode(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const userId = str(f, "userId") || me.id;
    if (userId !== me.id && !me.superAdmin) throw new Error("Коды другим сотрудникам выдаёт главный админ");
    const code = randomToken(6).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "ZX" + Date.now().toString(36).toUpperCase();
    await prisma.tkTgLink.upsert({ where: { userId }, update: { code }, create: { userId, code } });
    return done(`Код: ${code}`);
  } catch (e) { return fail(e); }
}

export async function unlinkTg(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const userId = str(f, "userId") || me.id;
    if (userId !== me.id && !me.superAdmin) throw new Error("Только главный админ");
    await prisma.tkTgLink.updateMany({ where: { userId }, data: { chatId: null, code: null, tgName: null } });
    return done("Привязка снята");
  } catch (e) { return fail(e); }
}

export async function toggleDigest(_p: TkState, f: FormData): Promise<TkState> {
  const me = await requireTasks();
  try {
    const kind = str(f, "kind");
    const link = await prisma.tkTgLink.findUnique({ where: { userId: me.id } });
    if (!link) throw new Error("Сначала привяжите Telegram");
    await prisma.tkTgLink.update({ where: { userId: me.id }, data: kind === "morning" ? { morning: !link.morning } : { evening: !link.evening } });
    return done("Сохранено");
  } catch (e) { return fail(e); }
}

export async function deleteReport(_p: TkState, f: FormData): Promise<TkState> {
  await requireTasks();
  try { await prisma.tkReport.delete({ where: { id: str(f, "id") } }); return done("Отчёт удалён"); } catch (e) { return fail(e); }
}

export type { Status };
