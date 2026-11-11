"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createRun, deleteRun, retryItems, saveMetricoolHeader, savePostText, saveSchedule } from "@/lib/social/runs";
import { headerFromTemplate } from "@/lib/social/metricool";
import { BASE_PATH, parseSettings } from "@/lib/social/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const runPath = (id: string) => `${BASE_PATH}/runs/${id}`;

export async function launchSocialRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let id: string;
  try {
    const settings = parseSettings({
      networks: f.getAll("networks").map(String),
      language: str(f, "language") || "auto",
      notes: str(f, "notes"),
      emoji: f.get("emoji") === "on",
      utm: f.get("utm") === "on",
      draft: f.get("draft") === "on",
      maxImages: str(f, "maxImages"),
      brand: str(f, "brand"),
      schedule: { startDate: str(f, "startDate"), perDay: str(f, "perDay"), fromHour: str(f, "fromHour"), toHour: str(f, "toHour") },
    });
    id = await createRun(me, str(f, "name"), String(f.get("urls") ?? ""), settings);
  } catch (e) {
    return fail(e);
  }
  redirect(runPath(id));
}

export async function retrySocialItems(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const n = await retryItems(me, str(f, "runId"), str(f, "item") || "failed");
    revalidatePath(runPath(str(f, "runId")));
    return { ok: n ? `В очередь: ${n}` : "Нечего повторять" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSocialRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await deleteRun(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  redirect(BASE_PATH);
}

export async function saveSocialPost(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await savePostText(me, str(f, "itemId"), str(f, "net"), String(f.get("text") ?? ""));
    revalidatePath(runPath(str(f, "runId")));
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

export async function saveSocialSchedule(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await saveSchedule(me, str(f, "runId"), {
      startDate: str(f, "startDate"),
      perDay: Number(str(f, "perDay")),
      fromHour: Number(str(f, "fromHour")),
      toHour: Number(str(f, "toHour")),
      brand: str(f, "brand"),
      draft: f.get("draft") === "on",
    });
    revalidatePath(runPath(str(f, "runId")));
    return { ok: "Расписание обновлено — скачайте файлы заново" };
  } catch (e) {
    return fail(e);
  }
}

/** Шаблон Metricool: файл CSV из аккаунта или вставленная строка заголовков. Менять может админ или лидер команды. */
export async function saveSocialTemplate(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    if (me.role !== "ADMIN" && !me.leadTeamIds.length) throw new Error("Шаблон меняет администратор или лидер команды");
    if (str(f, "reset") === "1") {
      await saveMetricoolHeader(me, null);
      revalidatePath(`${BASE_PATH}/settings`);
      return { ok: "Возвращены заголовки из справки Metricool" };
    }
    const file = f.get("file");
    let text = str(f, "header");
    if (file instanceof File && file.size > 0) {
      if (file.size > 2 * 1024 * 1024) throw new Error("Файл больше 2 МБ — это не шаблон");
      text = Buffer.from(await file.arrayBuffer()).toString("utf8");
    }
    if (!text) throw new Error("Выберите файл шаблона или вставьте строку заголовков");
    const header = headerFromTemplate(text);
    await saveMetricoolHeader(me, header);
    revalidatePath(`${BASE_PATH}/settings`);
    return { ok: `Шаблон сохранён: ${header.length} колонок` };
  } catch (e) {
    return fail(e);
  }
}
