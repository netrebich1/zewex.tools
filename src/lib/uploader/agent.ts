/**
 * Протокол агента «Zewex Uploader» (agent/uploader): токены, hello / profiles / next / progress / finish / fail / state.
 * API — src/app/api/uploader/agent/[action]/route.ts. Вход — токен агента (Authorization: Bearer zxu_…), не сессия.
 */
import { createHash } from "node:crypto";
import { Prisma, type UplAgent, type UplTask } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret, randomToken } from "@/lib/crypto";
import { canUseTool, resolvePermissions } from "@/lib/permissions";
import { writeFileAtomic, publicUrl } from "@/lib/pins/storage";
import { eventText, logEventByPinSite } from "@/lib/projects/events";
import { applyVerify, leaseUntil, settleRun, uplSettings } from "./runs";
import { ERROR_LABELS, MAX_ATTEMPTS, PAUSE_HOURS, PROTOCOL, TRANSIENT, UPLOADER, parseHumanize, type AgentTask, type ErrorKind, type Step, type TaskResult, type VerifyResult } from "./types";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class UploaderError extends Error {
  constructor(message: string, public status = 400, public code = "bad_request") {
    super(message);
  }
}

/** Новый токен агента: сам токен показывается один раз, в базе — только sha256. */
export async function issueAgentToken(userId: string, name: string): Promise<{ id: string; token: string }> {
  const token = `zxu_${randomToken(24)}`;
  const a = await prisma.uplAgent.create({ data: { userId, name: name.slice(0, 120) || "Агент", tokenHash: hashToken(token), tokenHint: token.slice(0, 10) }, select: { id: true } });
  return { id: a.id, token };
}

export type Ctx = { agent: UplAgent; userId: string };

export async function authAgent(req: Request): Promise<Ctx> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new UploaderError("Нет токена. Вставьте токен агента со страницы «Агенты».", 401, "no_token");
  const agent = await prisma.uplAgent.findUnique({ where: { tokenHash: hashToken(m[1]) } });
  if (!agent || agent.revokedAt) throw new UploaderError("Токен не найден или отозван. Выдайте новый на странице «Агенты».", 401, "bad_token");
  const user = await prisma.user.findUnique({ where: { id: agent.userId }, select: { id: true, role: true, isActive: true, permissions: true } });
  if (!user?.isActive) throw new UploaderError("Пользователь, на которого выдан токен, отключён.", 403, "user_off");
  const actor = { id: user.id, role: user.role, teamIds: [], leadTeamIds: [], perms: resolvePermissions(user.role, user.permissions) };
  if (!canUseTool(actor, UPLOADER)) throw new UploaderError("Инструмент «Заливка в Pinterest» этому пользователю не выдан.", 403, "no_access");
  return { agent, userId: user.id };
}

type Body = Record<string, unknown>;
const str = (v: unknown, max = 190) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

async function touch(ctx: Ctx, b: Body, status: "online" | "busy" = "online") {
  const state = str(b.state);
  const version = str(b.version, 20);
  ctx.agent = await prisma.uplAgent.update({ where: { id: ctx.agent.id }, data: { status, lastSeenAt: new Date(), ...(state ? { state } : {}), ...(version ? { version } : {}), ...(b.hostInfo && typeof b.hostInfo === "object" ? { hostInfo: b.hostInfo as Prisma.InputJsonValue } : {}) } });
}

/** Первое знакомство: токен Dolphin (расшифрованный — только агенту по его токену), «человечность», адрес массовой загрузки. */
export async function hello(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const s = await uplSettings();
  let dolphinToken: string | null = null;
  try { dolphinToken = s.dolphinTokenEnc ? decryptSecret(s.dolphinTokenEnc) : null; } catch { dolphinToken = null; }
  return { protocol: PROTOCOL, agent: { id: ctx.agent.id, name: ctx.agent.name }, dolphinToken, humanize: parseHumanize(s.humanize), bulkUrl: s.bulkUrl, pollSec: 20 };
}

/** Список профилей Dolphin от агента (для выпадающего списка сопоставления). */
export async function profiles(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const list = Array.isArray(b.profiles) ? (b.profiles as Array<Record<string, unknown>>) : [];
  const now = new Date();
  let n = 0;
  for (const p of list.slice(0, 5000)) {
    const id = str(p.id, 40);
    const name = str(p.name, 190);
    if (!id || !name) continue;
    const data = { agentId: ctx.agent.id, name, platform: str(p.platform, 20), tags: Array.isArray(p.tags) ? (p.tags.slice(0, 20) as Prisma.InputJsonValue) : Prisma.DbNull, seenAt: now };
    await prisma.uplProfile.upsert({ where: { id }, update: data, create: { id, ...data } });
    n++;
  }
  // Имена профилей в сопоставлениях обновляем (профиль могли переименовать в Dolphin).
  const accounts = await prisma.uplAccount.findMany({ where: { profileId: { in: list.map((p) => str(p.id, 40)).filter((x): x is string => !!x) } }, select: { id: true, profileId: true, profileName: true } });
  for (const a of accounts) {
    const p = list.find((x) => str(x.id, 40) === a.profileId);
    const name = p ? str(p.name, 190) : null;
    if (name && name !== a.profileName) await prisma.uplAccount.update({ where: { id: a.id }, data: { profileName: name } });
  }
  return { ok: true, saved: n };
}

async function toAgentTask(t: UplTask): Promise<AgentTask> {
  const [site, acc] = await Promise.all([
    prisma.pinSite.findUnique({ where: { id: t.pinSiteId }, select: { id: true, name: true } }),
    prisma.uplAccount.findUnique({ where: { pinSiteId: t.pinSiteId }, select: { profileName: true, pinUsername: true } }),
  ]);
  return {
    id: t.id, runId: t.runId, phase: t.phase as "upload" | "verify", steps: (t.steps as Step[]) ?? [],
    site: { id: t.pinSiteId, name: site?.name ?? "сайт" }, profileId: t.profileId, profileName: acc?.profileName ?? null, day: t.day,
    fileName: t.fileName, rows: t.rows, fileUrl: t.phase === "upload" ? `/api/uploader/file?task=${t.id}` : null,
    pinUsername: acc?.pinUsername ?? null, expectFileName: t.fileName,
  };
}

/**
 * Следующие задания агента: из его живых запусков, не больше `parallel` занятых одновременно.
 * Ответ: { tasks: AgentTask[], stop: runId[] } или { wait, reason }.
 */
export async function next(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const now = new Date();
  const busy = Math.max(0, num(b.busy) ?? 0);
  const runs = await prisma.uplRun.findMany({ where: { agentId: ctx.agent.id, status: { in: ["QUEUED", "RUNNING", "VERIFYING"] } }, orderBy: { createdAt: "asc" } });
  const stop = runs.filter((r) => r.stopRequested).map((r) => r.id);
  const out: AgentTask[] = [];
  for (const run of runs) {
    if (run.stopRequested) continue;
    const leased = await prisma.uplTask.count({ where: { runId: run.id, status: "LEASED", leaseUntil: { gt: now } } });
    let free = run.parallel - leased - busy - out.length;
    if (free <= 0) continue;
    const cands = await prisma.uplTask.findMany({ where: { runId: run.id, phase: run.phase, OR: [{ status: "QUEUED" }, { status: "LEASED", leaseUntil: { lt: now } }] }, orderBy: { order: "asc" }, take: free + 3 });
    for (const c of cands) {
      if (free <= 0) break;
      // Аккаунт мог уйти на паузу / потерять вход после создания запуска.
      const acc = await prisma.uplAccount.findUnique({ where: { pinSiteId: c.pinSiteId } });
      if (c.phase === "upload" && acc && (acc.status === "needs_login" || acc.status === "off" || acc.status === "banned" || ((acc.status === "paused" || acc.status === "limited") && acc.pausedUntil && acc.pausedUntil > now))) {
        await prisma.uplTask.update({ where: { id: c.id }, data: { status: "SKIPPED", error: `аккаунт: ${acc.status}`, errorKind: acc.status === "needs_login" ? "not_logged_in" : "rate_limited", finishedAt: now } });
        await settleRun(run.id);
        continue;
      }
      if (c.phase === "upload" && (await prisma.prjUpload.findUnique({ where: { pinSiteId_day: { pinSiteId: c.pinSiteId, day: c.day } }, select: { id: true } }))) {
        // Уже залито (другим запуском или руками) — второй раз тот же файл не отправляем.
        await prisma.uplTask.update({ where: { id: c.id }, data: { status: "SKIPPED", error: "уже отмечено залитым за этот день", finishedAt: now } });
        await settleRun(run.id);
        continue;
      }
      const won = await prisma.uplTask.updateMany({ where: { id: c.id, status: c.status, updatedAt: c.updatedAt }, data: { status: "LEASED", leaseUntil: leaseUntil(now), attempts: { increment: 1 }, startedAt: c.startedAt ?? now, step: "выдано агенту" } });
      if (!won.count) continue;
      if (run.status === "QUEUED") await prisma.uplRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: run.startedAt ?? now } });
      out.push(await toAgentTask({ ...c, status: "LEASED" }));
      free--;
    }
  }
  if (!out.length && !stop.length) return { tasks: [], stop: [], wait: 20, reason: runs.length ? "Все задания в работе." : "Запусков нет." };
  if (out.length) await prisma.uplAgent.update({ where: { id: ctx.agent.id }, data: { status: "busy" } });
  return { tasks: out, stop };
}

async function leasedTask(taskId: unknown): Promise<UplTask> {
  const t = typeof taskId === "string" ? await prisma.uplTask.findUnique({ where: { id: taskId } }) : null;
  if (!t) throw new UploaderError("Задание не найдено.", 404, "no_task");
  if (t.status !== "LEASED") throw new UploaderError("Задание уже закрыто или возвращено в очередь.", 409, "lost_lease");
  return t;
}

/** Снимок экрана от агента (base64 JPEG/PNG, ≤ 2 МБ) → файл хранилища, публичный адрес. */
async function saveShot(taskId: string, b64: unknown, label: string): Promise<string | null> {
  if (typeof b64 !== "string" || !b64) return null;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(b64);
  const raw = m ? m[2] : b64;
  if (raw.length > 2_800_000) return null;
  const ext = m?.[1] === "png" ? "png" : "jpg";
  const rel = `uploader/${taskId}/${label}-${Date.now()}.${ext}`;
  try {
    await writeFileAtomic(rel, Buffer.from(raw, "base64"));
    return publicUrl(rel);
  } catch {
    return null;
  }
}

const event = (pinSiteId: string, taskId: string | null, kind: string, result: "ok" | "error" | "empty", summary: string, payload?: unknown) =>
  prisma.uplEvent.create({ data: { pinSiteId, taskId, kind, result, summary: summary.slice(0, 255), payload: payload === undefined ? undefined : (payload as Prisma.InputJsonValue) } }).catch(() => null);

/** Шаг задания: строка состояния, продление аренды, снимок экрана (необязательно). */
export async function progress(ctx: Ctx, b: Body) {
  await touch(ctx, b, "busy");
  const t = await leasedTask(b.taskId);
  const shot = await saveShot(t.id, b.screenshot, "step");
  const prev = (t.result as TaskResult | null) ?? {};
  const data: Prisma.UplTaskUpdateInput = { leaseUntil: leaseUntil(), step: str(b.step) ?? t.step };
  if (shot) data.result = { ...prev, screenshot: shot } as Prisma.InputJsonValue;
  if (b.username) {
    const u = (str(b.username, 120) ?? "").replace(/^@/, "").toLowerCase();
    if (u) await prisma.uplAccount.updateMany({ where: { pinSiteId: t.pinSiteId, pinUsername: null }, data: { pinUsername: u } });
  }
  await prisma.uplTask.update({ where: { id: t.id }, data });
  return { ok: true };
}

/** Задание выполнено. upload: отметка в CRM и событие; verify: результат проверки в исходное задание. */
export async function finish(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const t = await leasedTask(b.taskId);
  const now = new Date();
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const shot = await saveShot(t.id, r.screenshot ?? b.screenshot, "done");
  const prev = (t.result as TaskResult | null) ?? {};
  if (t.phase === "upload") {
    const rows = num(r.rowsSeen);
    const result: TaskResult = { ...prev, accepted: true, rowsSeen: rows, message: str(r.message, 255), screenshot: shot ?? prev.screenshot ?? null, timings: (r.timings as Record<string, number>) ?? undefined };
    await prisma.uplTask.update({ where: { id: t.id }, data: { status: "DONE", leaseUntil: null, finishedAt: now, step: "готово", error: null, errorKind: null, result: result as Prisma.InputJsonValue } });
    const note = `авто · агент ${ctx.agent.name}${t.rows != null ? ` · ${t.rows} пинов` : ""}${shot ? ` · ${shot}` : ""}`;
    await prisma.prjUpload.upsert({ where: { pinSiteId_day: { pinSiteId: t.pinSiteId, day: t.day } }, update: { uploadedAt: now, uploadedById: null, source: "auto", note }, create: { pinSiteId: t.pinSiteId, day: t.day, uploadedById: null, source: "auto", note } });
    await prisma.uplAccount.updateMany({ where: { pinSiteId: t.pinSiteId }, data: { lastUploadAt: now, agentId: ctx.agent.id, status: "ok", pausedUntil: null, blockStep: 0, lastError: null } });
    void logEventByPinSite(t.pinSiteId, { kind: "export_uploaded", refId: `${t.pinSiteId}|${t.day}`, summary: eventText.exportUploadedAuto(t.day, t.rows ?? 0, ctx.agent.name), payload: { taskId: t.id, runId: t.runId, screenshot: shot } });
    await event(t.pinSiteId, t.id, "upload", "ok", `${t.day}: файл ${t.fileName ?? ""} принят${rows != null ? `, строк ${rows}` : ""}`);
  } else {
    const vr = (r.verify && typeof r.verify === "object" ? r.verify : r) as Record<string, unknown>;
    const v: VerifyResult = { published: num(vr.published), failed: num(vr.failed), processing: vr.processing === true, text: str(vr.text, 2000), screenshot: shot };
    await prisma.uplTask.update({ where: { id: t.id }, data: { status: "DONE", leaseUntil: null, finishedAt: now, step: "готово", result: { ...prev, verify: v, screenshot: shot } as Prisma.InputJsonValue } });
    await applyVerify(t, v);
    await event(t.pinSiteId, t.id, "check", "ok", `${t.day}: ${v.processing ? "ещё обрабатывается" : v.published == null ? "статус не прочитан" : `опубликовано ${v.published}, ошибок ${v.failed ?? 0}`}`);
  }
  await settleRun(t.runId);
  return { ok: true };
}

/**
 * Сбой задания. Временные (Dolphin/сеть) — ещё попытка до MAX_ATTEMPTS; остальные — FAILED.
 * Аккаунт: нет входа → needs_login; отказ/ограничение Pinterest → пауза на часы (ступени PAUSE_HOURS).
 */
export async function fail(ctx: Ctx, b: Body) {
  await touch(ctx, b);
  const t = await leasedTask(b.taskId);
  const now = new Date();
  const kind = (typeof b.kind === "string" && b.kind in ERROR_LABELS ? b.kind : "unknown") as ErrorKind;
  const msg = str(b.error, 255) ?? ERROR_LABELS[kind];
  const shot = await saveShot(t.id, b.screenshot, "fail");
  const prev = (t.result as TaskResult | null) ?? {};
  const result: TaskResult = { ...prev, message: msg, screenshot: shot ?? prev.screenshot ?? null, html: kind === "unknown" || kind === "upload_form_changed" ? str(b.html, 200_000) : prev.html ?? null };
  const stopped = kind === "stopped";
  const retry = !stopped && TRANSIENT.has(kind) && t.attempts < MAX_ATTEMPTS;
  await prisma.uplTask.update({
    where: { id: t.id },
    data: retry
      ? { status: "QUEUED", leaseUntil: null, step: null, error: msg, errorKind: kind, result: result as Prisma.InputJsonValue }
      : { status: stopped ? "SKIPPED" : "FAILED", leaseUntil: null, finishedAt: now, step: null, error: msg, errorKind: kind, result: result as Prisma.InputJsonValue },
  });
  const acc = await prisma.uplAccount.findUnique({ where: { pinSiteId: t.pinSiteId } });
  if (acc && kind === "not_logged_in") {
    await prisma.uplAccount.update({ where: { id: acc.id }, data: { status: "needs_login", lastError: msg } });
    await event(t.pinSiteId, t.id, "login_lost", "error", `${t.day}: ${msg}`);
  } else if (acc && (kind === "pinterest_rejected" || kind === "rate_limited")) {
    const hours = PAUSE_HOURS[Math.min(acc.blockStep, PAUSE_HOURS.length - 1)];
    await prisma.uplAccount.update({ where: { id: acc.id }, data: { status: kind === "rate_limited" ? "limited" : "paused", pausedUntil: new Date(now.getTime() + hours * 3600_000), blockStep: { increment: 1 }, lastError: msg } });
    await event(t.pinSiteId, t.id, "paused", "error", `${t.day}: ${msg}; пауза ${hours} ч`, { hours });
  } else {
    await event(t.pinSiteId, t.id, "fail", "error", `${t.day}: ${msg}${retry ? " (ещё попытка)" : ""}`);
    if (acc && !retry && !stopped) await prisma.uplAccount.update({ where: { id: acc.id }, data: { lastError: msg } });
  }
  if (!retry && !stopped && t.phase === "upload") {
    void logEventByPinSite(t.pinSiteId, { kind: "export_upload_failed", refId: `${t.pinSiteId}|${t.day}`, summary: eventText.exportUploadFailed(t.day, `${ERROR_LABELS[kind]}${msg && msg !== ERROR_LABELS[kind] ? ` — ${msg}` : ""}`), payload: { taskId: t.id, runId: t.runId, kind, screenshot: shot } });
  }
  if (!retry) await settleRun(t.runId);
  return { ok: true, retry };
}

/** Строка состояния агента (что делает сейчас). */
export async function state(ctx: Ctx, b: Body) {
  await touch(ctx, b, b.busy ? "busy" : "online");
  return { ok: true };
}
