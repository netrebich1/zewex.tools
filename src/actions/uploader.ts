"use server";
/** Заливка в Pinterest (Pin Uploader): агенты и токены, сопоставление сайт ↔ профиль Dolphin, запуски, настройки. */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { encryptSecret, secretHint } from "@/lib/crypto";
import { TZ } from "@/lib/pins/runs/stats";
import { todayKey } from "@/lib/pins/schedule/math";
import { agentFor, isAdmin, requireUploader, runFor, visiblePinSites } from "@/lib/uploader/access";
import { issueAgentToken } from "@/lib/uploader/agent";
import { publishAgentBuild } from "@/lib/uploader/release";
import { createRun, retryFailed, stopRun, uplSettings } from "@/lib/uploader/runs";
import { ACCOUNT_STATUS_LABELS, DEFAULT_HUMANIZE, HUMANIZE_FIELDS, isDay, parseHumanize, parseSchedule, type UplHumanize } from "@/lib/uploader/types";

export type FormState = { error?: string; ok?: string };
export type TokenState = FormState & { token?: string };
export type StartState = FormState & { runId?: string; skipped?: Array<{ siteName: string; reason: string }> };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const BASE = "/pinterest/uploader";
const refresh = (...paths: string[]) => { revalidatePath(BASE); for (const p of paths) revalidatePath(p); };

// ───────────── агенты ─────────────

export async function issueAgentAction(_p: TokenState, f: FormData): Promise<TokenState> {
  const me = await requireUploader();
  try {
    const { token } = await issueAgentToken(me.id, str(f, "name") || `Агент ${me.name}`);
    refresh(`${BASE}/agents`);
    return { ok: "Токен выдан. Скопируйте его сейчас — второй раз он не показывается.", token };
  } catch (e) { return fail(e); }
}

export async function revokeAgentAction(agentId: string): Promise<FormState> {
  const me = await requireUploader();
  try {
    const a = await agentFor(me, agentId);
    await prisma.uplAgent.update({ where: { id: a.id }, data: { revokedAt: new Date(), status: "offline" } });
    await prisma.uplRun.updateMany({ where: { agentId: a.id, status: { in: ["QUEUED", "RUNNING", "VERIFY_WAIT", "VERIFYING"] } }, data: { status: "STOPPED", stopRequested: true, finishedAt: new Date(), error: "агент отозван" } });
    refresh(`${BASE}/agents`);
    return { ok: "Агент отозван" };
  } catch (e) { return fail(e); }
}

/** Настройки агента: параллельность и расписание (сохраняется при смене любого поля). */
export async function saveAgentAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  try {
    const a = await agentFor(me, str(f, "agentId"));
    const parallel = Math.max(1, Math.min(5, Number(str(f, "parallel")) || 1));
    const time = str(f, "time");
    const schedule = { enabled: str(f, "enabled") === "on", time: /^\d{2}:\d{2}$/.test(time) ? time : parseSchedule(a.schedule).time, tz: str(f, "tz") || parseSchedule(a.schedule).tz };
    const name = str(f, "name").slice(0, 120) || a.name;
    await prisma.uplAgent.update({ where: { id: a.id }, data: { name, settings: { parallel }, schedule } });
    refresh(`${BASE}/agents`);
    return { ok: "Сохранено" };
  } catch (e) { return fail(e); }
}

/** Загрузка сборки агента (ZIP) — только админ. */
export async function uploadAgentBuildAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  if (!isAdmin(me)) return { error: "Только администратор" };
  const file = f.get("zip");
  const version = str(f, "version");
  if (!(file instanceof File) || !file.size) return { error: "Выберите ZIP со сборкой" };
  if (file.size > 150 * 1024 * 1024) return { error: "ZIP больше 150 МБ" };
  try {
    await publishAgentBuild(version, Buffer.from(await file.arrayBuffer()));
    refresh(`${BASE}/agents`);
    return { ok: `Сборка ${version} опубликована` };
  } catch (e) { return fail(e); }
}

// ───────────── сопоставление ─────────────

/** Сайт ↔ профиль Dolphin (селект отправляется сам). Пустое значение — снять сопоставление. */
export async function setProfileAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  const pinSiteId = str(f, "pinSiteId"), profileId = str(f, "profileId");
  try {
    if (!(await visiblePinSites(me)).some((s) => s.id === pinSiteId)) throw new Error("Сайт не найден или закрыт для вас");
    const profile = profileId ? await prisma.uplProfile.findUnique({ where: { id: profileId } }) : null;
    if (profileId && !profile) throw new Error("Профиль не найден в списке агентов");
    const taken = profileId ? await prisma.uplAccount.findFirst({ where: { profileId, pinSiteId: { not: pinSiteId } }, select: { pinSiteId: true } }) : null;
    if (taken) {
      const other = await prisma.pinSite.findUnique({ where: { id: taken.pinSiteId }, select: { name: true } });
      throw new Error(`Профиль «${profile!.name}» уже привязан к сайту «${other?.name ?? "?"}» (1 сайт = 1 профиль)`);
    }
    await prisma.uplAccount.upsert({
      where: { pinSiteId },
      update: { profileId: profile?.id ?? null, profileName: profile?.name ?? null, ...(profile ? {} : { pinUsername: null }) },
      create: { pinSiteId, profileId: profile?.id ?? null, profileName: profile?.name ?? null },
    });
    refresh(`${BASE}/mapping`);
    return { ok: profile ? `Привязан профиль «${profile.name}»` : "Сопоставление снято" };
  } catch (e) { return fail(e); }
}

/** Состояние аккаунта вручную: снять паузу / «нужен вход» / выключить. */
export async function setAccountStatusAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  const pinSiteId = str(f, "pinSiteId"), status = str(f, "status");
  if (!(status in ACCOUNT_STATUS_LABELS)) return { error: "Неизвестный статус" };
  try {
    if (!(await visiblePinSites(me)).some((s) => s.id === pinSiteId)) throw new Error("Сайт не найден или закрыт для вас");
    await prisma.uplAccount.upsert({
      where: { pinSiteId },
      update: { status, ...(status === "ok" ? { pausedUntil: null, blockStep: 0, lastError: null } : {}) },
      create: { pinSiteId, status },
    });
    await prisma.uplEvent.create({ data: { pinSiteId, kind: "manual", result: "ok", summary: `${me.name}: статус → ${ACCOUNT_STATUS_LABELS[status as keyof typeof ACCOUNT_STATUS_LABELS]}` } });
    refresh(`${BASE}/mapping`);
    return { ok: "Сохранено" };
  } catch (e) { return fail(e); }
}

// ───────────── запуски ─────────────

/** «Запустить»: выбранные сайты (или все с файлом на день) → запуск на агенте. */
export async function startRunAction(_p: StartState, f: FormData): Promise<StartState> {
  const me = await requireUploader();
  const agentId = str(f, "agentId");
  const day = str(f, "day") || todayKey(new Date(), TZ);
  if (!isDay(day)) return { error: "Неверный день" };
  const siteIds = f.getAll("site").map(String).filter(Boolean);
  const parallelRaw = Number(str(f, "parallel"));
  const force = str(f, "force") === "on";
  if (!agentId) return { error: "Выберите агента (он должен быть запущен на ПК)" };
  if (!siteIds.length) return { error: "Отметьте хотя бы один сайт" };
  try {
    const r = await createRun(me, { agentId, day, siteIds, parallel: Number.isFinite(parallelRaw) && parallelRaw >= 1 ? parallelRaw : undefined, force });
    refresh(`${BASE}/runs`);
    if (!r.runId) return { error: `Нечего запускать: ${r.skipped.map((s) => `${s.siteName} — ${s.reason}`).join("; ")}`, skipped: r.skipped };
    return { ok: `Запуск создан: ${r.queued} сайт(ов)${r.skipped.length ? `, пропущено ${r.skipped.length}` : ""}`, runId: r.runId, skipped: r.skipped };
  } catch (e) { return fail(e); }
}

export async function stopRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  const id = str(f, "id");
  try {
    if (!(await runFor(me, id))) throw new Error("Запуск не найден");
    await stopRun(id);
    refresh(`${BASE}/runs`, `${BASE}/runs/${id}`);
    return { ok: "Остановка: ждущие задания сняты, текущее агент завершит" };
  } catch (e) { return fail(e); }
}

export async function retryRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  const id = str(f, "id");
  try {
    if (!(await runFor(me, id))) throw new Error("Запуск не найден");
    const n = await retryFailed(id);
    refresh(`${BASE}/runs`, `${BASE}/runs/${id}`);
    return n ? { ok: `В очередь снова: ${n}` } : { error: "Нечего повторять" };
  } catch (e) { return fail(e); }
}

export async function deleteRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  const id = str(f, "id");
  try {
    const run = await runFor(me, id);
    if (!run) throw new Error("Запуск не найден");
    if (["RUNNING", "VERIFYING"].includes(run.status)) throw new Error("Сначала остановите запуск");
    await prisma.uplRun.delete({ where: { id } });
    refresh(`${BASE}/runs`);
    return { ok: "Запуск удалён" };
  } catch (e) { return fail(e); }
}

// ───────────── настройки ─────────────

export async function saveDolphinTokenAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  if (!isAdmin(me)) return { error: "Только администратор" };
  const token = str(f, "token");
  if (!token) return { error: "Вставьте токен Dolphin API" };
  try {
    await prisma.uplSettings.upsert({ where: { id: "main" }, update: { dolphinTokenEnc: encryptSecret(token), dolphinHint: secretHint(token) }, create: { id: "main", dolphinTokenEnc: encryptSecret(token), dolphinHint: secretHint(token) } });
    refresh(`${BASE}/settings`);
    return { ok: "Токен Dolphin сохранён; агенты получат его при следующем выходе на связь" };
  } catch (e) { return fail(e); }
}

export async function saveSettingsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUploader();
  if (!isAdmin(me)) return { error: "Только администратор" };
  try {
    const cur = parseHumanize((await uplSettings()).humanize);
    const h: UplHumanize = { ...cur, browseFeed: str(f, "browseFeed") === "on" };
    for (const { key } of HUMANIZE_FIELDS) {
      const a = Number(str(f, `${key}_min`)), b = Number(str(f, `${key}_max`));
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a) h[key] = [a, b];
      else h[key] = DEFAULT_HUMANIZE[key];
    }
    const int = (k: string, d: number, min: number, max: number) => { const v = Number(str(f, k)); return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d; };
    const bulkUrl = str(f, "bulkUrl").slice(0, 255) || null;
    if (bulkUrl && !/^https:\/\/([a-z0-9-]+\.)*pinterest\.com\//i.test(bulkUrl)) return { error: "Адрес массовой загрузки должен быть на pinterest.com" };
    await prisma.uplSettings.upsert({
      where: { id: "main" },
      update: { humanize: h as unknown as Prisma.InputJsonValue, verifyDelayMin: int("verifyDelayMin", 10, 1, 240), verifyRetryMin: int("verifyRetryMin", 30, 5, 720), verifyRetries: int("verifyRetries", 3, 0, 10), bulkUrl },
      create: { id: "main", humanize: h as unknown as Prisma.InputJsonValue, verifyDelayMin: int("verifyDelayMin", 10, 1, 240), verifyRetryMin: int("verifyRetryMin", 30, 5, 720), verifyRetries: int("verifyRetries", 3, 0, 10), bulkUrl },
    });
    refresh(`${BASE}/settings`);
    return { ok: "Настройки сохранены" };
  } catch (e) { return fail(e); }
}
