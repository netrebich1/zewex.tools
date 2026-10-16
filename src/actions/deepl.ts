"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decryptSecret, encryptSecret, secretHint } from "@/lib/crypto";
import { createJob, deleteJob, publishItem, publishReady, resumeJob, retryItems, revertItem, stopJob, type LaunchPost } from "@/lib/deepl/jobs";
import { checkDeeplKey, mapLimit, refreshDeeplUsage, resetDeeplPool } from "@/lib/deepl/deepl";
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
    const ids = f.getAll("itemId").map(String).filter(Boolean);
    const n = await retryItems(me, str(f, "id"), ids.length ? ids : "failed", f.get("fresh") === "1");
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
/** Лимит бесплатного ключа DeepL в месяц — значение по умолчанию исходного сервиса. */
const DEFAULT_FREE_LIMIT = 500_000;
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
    const existing = new Set((await prisma.deeplKey.findMany({ select: { secretEnc: true } })).map((k) => decryptSecret(k.secretEnc).trim().toLowerCase()));
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
        rejected.push(`${secretHint(k.secret)} — ${c.note}`);
        continue;
      }
      await prisma.deeplKey.create({
        data: {
          label: k.label || `DeepL ${k.secret.endsWith(":fx") ? "Free" : "Pro"} ${secretHint(k.secret)}`,
          secretEnc: encryptSecret(k.secret),
          hint: secretHint(k.secret),
          charLimit: manualLimit ?? c.limit ?? DEFAULT_FREE_LIMIT,
          limitManual: manualLimit != null || c.limit == null,
          charUsed: c.used ?? 0,
          usageAt: new Date(),
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
    return rejected.length && !added ? { error: parts.join(" · ") } : { ok: parts.join(" · ") };
  } catch (e) {
    return fail(e);
  }
}

export async function updateDeeplKey(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const id = str(f, "id");
    const op = str(f, "op");
    if (op === "delete") await prisma.deeplKey.delete({ where: { id } });
    else if (op === "toggle") {
      const k = await prisma.deeplKey.findUniqueOrThrow({ where: { id } });
      await prisma.deeplKey.update({ where: { id }, data: { isActive: !k.isActive, lastError: k.isActive ? k.lastError : null } });
    } else if (op === "up" || op === "down") {
      const keys = await prisma.deeplKey.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
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
      if (limit == null) throw new Error("Укажите лимит символов числом, например 500000");
      if (op === "limit") await prisma.deeplKey.update({ where: { id }, data: { charLimit: limit, limitManual: true } });
      else await prisma.deeplKey.updateMany({ data: { charLimit: limit, limitManual: true } });
    } else if (op === "limit_auto") {
      // Снова брать лимит из DeepL: подтянется при «Обновить расход из DeepL».
      await prisma.deeplKey.update({ where: { id }, data: { limitManual: false } });
      await refreshDeeplUsage();
    } else if (op === "delete_dead") {
      // Выключенные (лимит, отказ DeepL) и исчерпанные ключи — одним нажатием.
      const keys = await prisma.deeplKey.findMany({ select: { id: true, isActive: true, charLimit: true, charUsed: true } });
      const dead = keys.filter((k) => !k.isActive || (k.charLimit != null && k.charUsed >= k.charLimit)).map((k) => k.id);
      await prisma.deeplKey.deleteMany({ where: { id: { in: dead } } });
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
    return r.failed ? { error: `Обновлено ${r.ok}, с ошибкой ${r.failed} — см. строку ключа${revived}` } : { ok: `Расход обновлён по ${r.ok} ключам${revived}` };
  } catch (e) {
    return fail(e);
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
