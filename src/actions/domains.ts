"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createDomainRun, deleteDomainRun, requestStopRun, restartDomainRun, settingsFromInput } from "@/lib/domains/runs";
import type { MinedSuffix, SerpSnapshot } from "@/lib/domains/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

/** Запуск подбора: настройки из формы, снимок выдачи и приставки из скрытых полей (JSON). */
export async function launchDomainRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let id: string;
  try {
    let mined: MinedSuffix[] = [];
    let serp: SerpSnapshot | null = null;
    try {
      mined = JSON.parse(str(f, "minedSuffixes") || "[]");
    } catch {
      mined = [];
    }
    try {
      const raw = str(f, "serp");
      serp = raw ? (JSON.parse(raw) as SerpSnapshot) : null;
    } catch {
      serp = null;
    }
    const settings = settingsFromInput({
      brands: str(f, "brands"),
      tlds: str(f, "tlds"),
      tier1: str(f, "tier1"),
      tier2: str(f, "tier2"),
      tier3: str(f, "tier3"),
      perBrand: str(f, "perBrand"),
      extraPerBrand: str(f, "extraPerBrand"),
      allowHyphen: f.get("allowHyphen") === "on",
      countryCode: str(f, "countryCode"),
      serpKeyword: str(f, "serpKeyword"),
      minedSuffixes: Array.isArray(mined) ? mined : [],
      serp: serp && Array.isArray(serp.domains) ? serp : null,
    });
    const r = await createDomainRun(me, settings, str(f, "name"));
    id = r.id;
  } catch (e) {
    return fail(e);
  }
  redirect(`/gambling/domains/runs/${id}`);
}

export async function stopDomainRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await requestStopRun(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/gambling/domains/runs/${str(f, "id")}`);
  return { ok: "Останавливаю: текущая пачка доменов будет дописана, результаты сохранятся." };
}

export async function restartDomainRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await restartDomainRun(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/gambling/domains/runs/${str(f, "id")}`);
  return { ok: "Подбор снова в очереди: прежние результаты стёрты." };
}

export async function deleteDomainRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await deleteDomainRun(me, str(f, "id"));
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/gambling/domains");
  redirect("/gambling/domains");
}
