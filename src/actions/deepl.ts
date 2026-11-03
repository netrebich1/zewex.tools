"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { createJob, deleteJob, publishItem, publishReady, resumeJob, retryItems, revertItem, stopJob, type LaunchPost } from "@/lib/deepl/jobs";
import { checkDeeplKey, deeplHint, mapLimit, refreshDeeplUsage, resetDeeplPool } from "@/lib/deepl/deepl";
import { BASE_PATH, parseSettings, type DeeplSettings } from "@/lib/deepl/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const runPath = (id: string) => `${BASE_PATH}/runs/${id}`;

/** Тексты промтов на момент запуска кладём в настройки прогона: правка промта потом не меняет идущий прогон. */
async function withPromptBodies(s: DeeplSettings): Promise<DeeplSettings> {
  const ids = [s.headings.promptId, s.postEdit.promptId].filter(Boolean);
  const prompts = ids.length ? await prisma.deeplPrompt.findMany({ where: { id: { in: ids } } }) : [];
  const body = (id: string) => prompts.find((p) => p.id === id)?.body ?? "";
  const out: DeeplSettings = {
    ...s,
    headings: { ...s.headings, prompt: s.headings.enabled ? body(s.headings.promptId) : "" },
    postEdit: { ...s.postEdit, prompt: s.postEdit.enabled ? body(s.postEdit.promptId) : "" },
  };
  if (out.headings.enabled && !out.headings.prompt) throw new Error("Выберите промт для заголовков H2");
  if (out.postEdit.enabled && !out.postEdit.prompt) throw new Error("Выберите промт постредактуры");
  return out;
}

function settingsFromForm(f: FormData): DeeplSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(str(f, "settings") || "null");
  } catch {
    throw new Error("Не удалось прочитать настройки — обновите страницу");
  }
  const s = parseSettings(raw);
  for (const st of s.translateSteps) if (!st.target) throw new Error("У шага перевода не выбран язык");
  return s;
}

/* ---------- Прогоны ---------- */

export async function launchDeeplJob(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let id: string;
  try {
    const settings = await withPromptBodies(settingsFromForm(f));
    let posts: LaunchPost[] = [];
    try {
      posts = JSON.parse(str(f, "posts") || "[]");
    } catch {
      posts = [];
    }
    id = await createJob(me, str(f, "accessId"), settings, Array.isArray(posts) ? posts : [], str(f, "name"));
  } catch (e) {
    return fail(e);
  }
  redirect(runPath(id));
}

export async function stopDeeplJob(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await stopJob(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  revalidatePath(runPath(str(f, "id")));
  return { ok: "Останавливаю: статьи в работе допишут текущий этап, остальные встанут." };
}

export async function resumeDeeplJob(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const n = await resumeJob(me, str(f, "id"));
    revalidatePath(runPath(str(f, "id")));
    return { ok: `Продолжаю: в очереди ${n} статей.` };
  } catch (e) {
    return fail(e);
  }
}

export async function retryDeeplItems(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    // Без рабочего ключа статьи сразу упадут снова — говорим об этом до постановки в очередь.
    if (!(await prisma.deeplKey.count({ where: { isActive: true, deletedAt: null } }))) {
      throw new Error("Нет рабочих ключей DeepL — сначала добавьте или включите ключ на вкладке «Ключи DeepL», потом перезапускайте");
    }
    const ids = f.getAll("itemId").map(String).filter(Boolean);
    const all = f.get("all") === "1";
    const n = await retryItems(me, str(f, "id"), all ? "all" : ids.length ? ids : "failed", all || f.get("fresh") === "1");
    revalidatePath(runPath(str(f, "id")));
    return n ? { ok: `Снова в очереди: ${n}` } : { error: "Нечего повторять" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDeeplJob(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await deleteJob(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  redirect(BASE_PATH);
}

export async function publishDeeplItem(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const link = await publishItem(me, str(f, "itemId"), str(f, "mode") === "new" ? "new" : "source", str(f, "status") || "draft");
    revalidatePath(runPath(str(f, "id")));
    return { ok: `Опубликовано: ${link}` };
  } catch (e) {
    return fail(e);
  }
}

export async function publishDeeplReady(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const r = await publishReady(me, str(f, "id"), str(f, "mode") === "new" ? "new" : "source", str(f, "status") || "draft", f.get("withWarnings") === "on");
    revalidatePath(runPath(str(f, "id")));
    if (!r.ok && !r.failed.length) return { error: "Нет готовых неопубликованных статей" };
    return r.failed.length
      ? { error: `Опубликовано ${r.ok}, не удалось ${r.failed.length}: ${r.failed.slice(0, 3).join(" · ")}` }
      : { ok: `Опубликовано статей: ${r.ok}` };
  } catch (e) {
    return fail(e);
  }
}

export async function revertDeeplItem(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    if (str(f, "confirm").toLowerCase() !== "вернуть") throw new Error("Для отката впишите слово «вернуть»");
    await revertItem(me, str(f, "itemId"));
    revalidatePath(runPath(str(f, "id")));
    return { ok: "Оригинал возвращён в WordPress" };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Ключи DeepL (только внутри инструмента; управляет любой, кому открыт DeepL Articler) ---------- */

const KEYS_PATH = `${BASE_PATH}/keys`;
/** Лимит символов на ключ по умолчанию (правило владельца 2026-10-16: 1 000 000). */
const DEFAULT_KEY_LIMIT = 1_000_000;
/** «500 000», «500000», «0,5 млн» → число символов; пусто или мусор — null. */
function parseLimit(v: string): number | null {
  const t = v.toLowerCase().replace(/\s+/g, "").replace(",", ".");
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)(млн|m|тыс|k)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "млн" || m[2] === "m" ? 1_000_000 : m[2] === "тыс" || m[2] === "k" ? 1000 : 1);
  return n > 0 ? Math.round(n) : null;
}
/** Ключ DeepL — UUID, у бесплатного в конце «:fx». Из вставленного текста берём все такие ключи, как бы они ни были разделены. */
const KEY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::fx)?/gi;

/** Добавить сразу много ключей: по строке «ключ» или «название ключ». Каждый проверяется в DeepL, дубли пропускаются. */
export async function addDeeplKeys(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const text = String(f.get("keys") ?? "");
    const found: { secret: string; label: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
      let prevEnd = 0;
      for (const m of line.matchAll(KEY_RE)) {
        // Название — только текст между предыдущим ключом строки и этим.
        const label = line.slice(prevEnd, m.index).replace(/^[\s|:;,]+|[\s|:;,]+$/g, "").slice(0, 80);
        prevEnd = (m.index ?? 0) + m[0].length;
        found.push({ secret: m[0], label });
      }
    }
    if (!found.length) throw new Error("Не нашёл ни одного ключа DeepL. Ключ выглядит так: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx");
    const existing = new Set((await prisma.deeplKey.findMany({ where: { deletedAt: null }, select: { secretEnc: true } })).map((k) => decryptSecret(k.secretEnc).trim().toLowerCase()));
    const fresh = found.filter((k, i) => !existing.has(k.secret.toLowerCase()) && found.findIndex((x) => x.secret.toLowerCase() === k.secret.toLowerCase()) === i);
    const dupes = found.length - fresh.length;
    // Лимит для новых ключей, как «Лимит символов» в исходном сервисе: задан — фиксируем вручную, пусто — берём из DeepL.
    const manualLimit = parseLimit(str(f, "limit"));
    const checks = await mapLimit(fresh, 5, (k) => checkDeeplKey(k.secret));
    const max = await prisma.deeplKey.aggregate({ _max: { sortOrder: true } });
    let order = max._max.sortOrder ?? 0;
    let added = 0;
    const rejected: string[] = [];
    for (const [i, k] of fresh.entries()) {
      const c = checks[i]!;
      if (!c.ok) {
        rejected.push(`${deeplHint(k.secret)} — ${c.note}`);
        continue;
      }
      await prisma.deeplKey.create({
        data: {
          label: k.label || `DeepL ${k.secret.endsWith(":fx") ? "Free" : "Pro"} ${deeplHint(k.secret)}`,
          secretEnc: encryptSecret(k.secret),
          hint: deeplHint(k.secret),
          charLimit: manualLimit ?? c.limit ?? DEFAULT_KEY_LIMIT,
          limitManual: manualLimit != null || c.limit == null,
          charUsed: c.used ?? 0,
          usageAt: new Date(),
          lastCheckedAt: new Date(),
          lastCheckOk: true,
          lastCheckNote: c.note,
          sortOrder: ++order,
        },
      });
      added++;
    }
    resetDeeplPool();
    revalidatePath(KEYS_PATH);
    revalidatePath(BASE_PATH);
    const parts = [`Добавлено ключей: ${added}`];
    if (dupes) parts.push(`уже были: ${dupes}`);
    if (rejected.length) parts.push(`не приняты DeepL: ${rejected.length} (${rejected.slice(0, 5).join("; ")}${rejected.length > 5 ? "…" : ""})`);
    // Отклонённый ключ не сохраняется, и об этом говорит красное сообщение, даже если остальные ключи добавились.
    return rejected.length ? { error: parts.join(" · ") } : { ok: parts.join(" · ") };
  } catch (e) {
    return fail(e);
  }
}

export async function updateDeeplKey(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const id = str(f, "id");
    const op = str(f, "op");
    // Удаление мягкое: строка нужна статистике «через сколько ключи выходят из строя».
    if (op === "delete") await prisma.deeplKey.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    else if (op === "check") {
      const r = await refreshDeeplUsage([id]);
      resetDeeplPool();
      revalidatePath(KEYS_PATH);
      revalidatePath(BASE_PATH);
      const k = await prisma.deeplKey.findUniqueOrThrow({ where: { id } });
      return r.ok ? { ok: `«${k.label}»: ${k.lastCheckNote ?? "ключ работает"}${r.revived ? " · снова в работе" : ""}` } : { error: `«${k.label}»: ${k.lastCheckNote ?? "проверка не прошла"}` };
    } else if (op === "toggle") {
      const k = await prisma.deeplKey.findUniqueOrThrow({ where: { id } });
      // Включили вручную — ключ снова считается живым; откажет опять — отметка поставится заново.
      await prisma.deeplKey.update({ where: { id }, data: k.isActive ? { isActive: false } : { isActive: true, lastError: null, deadAt: null, deadReason: null } });
    } else if (op === "up" || op === "down") {
      const keys = await prisma.deeplKey.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
      const i = keys.findIndex((k) => k.id === id);
      const j = op === "up" ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < keys.length) {
        [keys[i], keys[j]] = [keys[j]!, keys[i]!];
        await prisma.$transaction(keys.map((k, n) => prisma.deeplKey.update({ where: { id: k.id }, data: { sortOrder: n } })));
      }
    } else if (op === "label") {
      await prisma.deeplKey.update({ where: { id }, data: { label: str(f, "label").slice(0, 80) || "DeepL" } });
    } else if (op === "limit" || op === "limit_all") {
      const limit = parseLimit(str(f, "limit"));
      if (limit == null) throw new Error("Укажите лимит символов числом, например 1000000");
      if (op === "limit") await prisma.deeplKey.update({ where: { id }, data: { charLimit: limit, limitManual: true } });
      else await prisma.deeplKey.updateMany({ where: { deletedAt: null }, data: { charLimit: limit, limitManual: true } });
    } else if (op === "limit_auto") {
      // Снова брать лимит из DeepL: подтянется при «Обновить расход из DeepL».
      await prisma.deeplKey.update({ where: { id }, data: { limitManual: false } });
      await refreshDeeplUsage();
    } else if (op === "delete_dead") {
      // Выключенные (лимит, отказ DeepL) и исчерпанные ключи — одним нажатием.
      const keys = await prisma.deeplKey.findMany({ where: { deletedAt: null }, select: { id: true, isActive: true, charLimit: true, charUsed: true } });
      const dead = keys.filter((k) => !k.isActive || (k.charLimit != null && k.charUsed >= k.charLimit)).map((k) => k.id);
      await prisma.deeplKey.updateMany({ where: { id: { in: dead } }, data: { deletedAt: new Date(), isActive: false } });
      resetDeeplPool();
      revalidatePath(KEYS_PATH);
      return { ok: `Удалено ключей: ${dead.length}` };
    }
    resetDeeplPool();
    revalidatePath(KEYS_PATH);
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

export async function refreshDeeplKeys(_p: FormState, _f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const r = await refreshDeeplUsage();
    revalidatePath(KEYS_PATH);
    revalidatePath(BASE_PATH);
    const revived = r.revived ? ` · снова в работе после обновления лимита: ${r.revived}` : "";
    const bad = r.notes.length ? ` (${r.notes.slice(0, 5).join("; ")}${r.notes.length > 5 ? "…" : ""})` : "";
    return r.failed ? { error: `Проверено ${r.ok + r.failed}: работают ${r.ok}, с ошибкой ${r.failed}${bad}${revived}` } : { ok: `Все ключи работают (${r.ok}), расход обновлён${revived}` };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Проверка ключей без сохранения (вкладка «Проверка ключей») ---------- */

export type KeyCheckRow = { secret: string; hint: string; label: string; plan: "Free" | "Pro"; ok: boolean; note: string; used: number | null; limit: number | null; inTool: boolean };
export type KeyCheckState = { error?: string; rows?: KeyCheckRow[]; at?: string };

/** Вставили ключи — спросили DeepL (/v2/usage) про каждый: принят ли, сколько символов израсходовано и осталось. Ничего не сохраняет. */
export async function checkDeeplKeysTool(_p: KeyCheckState, f: FormData): Promise<KeyCheckState> {
  try {
    await requireUser();
    const found: { secret: string; label: string }[] = [];
    for (const line of String(f.get("keys") ?? "").split(/\r?\n/)) {
      let prevEnd = 0;
      for (const m of line.matchAll(KEY_RE)) {
        const label = line.slice(prevEnd, m.index).replace(/^[\s|:;,]+|[\s|:;,]+$/g, "").slice(0, 80);
        prevEnd = (m.index ?? 0) + m[0].length;
        if (!found.some((x) => x.secret.toLowerCase() === m[0].toLowerCase())) found.push({ secret: m[0], label });
      }
    }
    if (!found.length) throw new Error("Не нашёл ни одного ключа DeepL. Ключ выглядит так: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx");
    if (found.length > 300) throw new Error(`За раз — до 300 ключей, вставлено ${found.length}`);
    const inTool = new Set((await prisma.deeplKey.findMany({ where: { deletedAt: null }, select: { secretEnc: true } })).map((k) => decryptSecret(k.secretEnc).trim().toLowerCase()));
    const checks = await mapLimit(found, 8, (k) => checkDeeplKey(k.secret));
    return {
      at: new Date().toISOString(),
      rows: found.map((k, i) => {
        const c = checks[i]!;
        return { secret: k.secret, hint: deeplHint(k.secret), label: k.label, plan: k.secret.toLowerCase().endsWith(":fx") ? "Free" : "Pro", ok: c.ok, note: c.note, used: c.ok ? (c.used ?? 0) : null, limit: c.ok ? (c.limit ?? null) : null, inTool: inTool.has(k.secret.toLowerCase()) };
      }),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- Промты ---------- */

export async function saveDeeplPrompt(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const name = str(f, "name");
    const body = String(f.get("body") ?? "").trim();
    const purpose = ["headings", "post_edit"].includes(str(f, "purpose")) ? str(f, "purpose") : "any";
    if (!name || !body) throw new Error("Заполните название и текст промта");
    const id = str(f, "id");
    if (id) await prisma.deeplPrompt.update({ where: { id }, data: { name, body, purpose } });
    else await prisma.deeplPrompt.create({ data: { name, body, purpose } });
    revalidatePath(`${BASE_PATH}/settings`);
    return { ok: "Промт сохранён" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDeeplPrompt(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    await prisma.deeplPrompt.delete({ where: { id: str(f, "id") } });
    revalidatePath(`${BASE_PATH}/settings`);
    return { ok: "Промт удалён" };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Сценарии ---------- */

export async function saveDeeplScenario(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const name = str(f, "scenarioName");
    if (!name) throw new Error("Назовите сценарий");
    const s = settingsFromForm(f);
    // Сценарий хранит ссылки на промты, а не их тексты: правка промта сразу действует во всех сценариях.
    const settings = { ...s, headings: { ...s.headings, prompt: "" }, postEdit: { ...s.postEdit, prompt: "" } } as unknown as Prisma.InputJsonValue;
    const existing = await prisma.deeplScenario.findFirst({ where: { name } });
    if (existing) await prisma.deeplScenario.update({ where: { id: existing.id }, data: { settings } });
    else await prisma.deeplScenario.create({ data: { name, settings } });
    revalidatePath(`${BASE_PATH}/new`);
    return { ok: existing ? `Сценарий «${name}» обновлён` : `Сценарий «${name}» сохранён` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDeeplScenario(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    await prisma.deeplScenario.delete({ where: { id: str(f, "id") } });
    revalidatePath(`${BASE_PATH}/settings`);
    return { ok: "Сценарий удалён" };
  } catch (e) {
    return fail(e);
  }
}
