"use server";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createDomainRun } from "@/lib/domains/runs";
import { loadEmdTable } from "@/lib/domains/drive";
import { EMD_DEFAULTS, eligibleKeywords } from "@/lib/domains/emd";
import { normalizeTld, parseList } from "@/lib/domains/generator";
import { DEFAULT_SETTINGS, LIMITS, type BrandItem, type DomainRunSettings } from "@/lib/domains/types";
import type { FormState } from "./domains";

export type EmdPreview = {
  error?: string;
  fileName?: string;
  rows?: number;
  clusters?: number;
  keywords?: number;
  eligible?: number;
  countries?: Array<[string, number]>;
  projects?: Array<[string, number]>;
  problems?: string[];
};

const clamp = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : def;
};

/** Проверка таблицы до запуска: сколько кластеров, ключей, стран и проектов, сколько ключей проходит порог. */
export async function previewEmdTable(url: string, minVolume: number): Promise<EmdPreview> {
  await requireUser();
  try {
    const t = await loadEmdTable(url);
    const min = clamp(minVolume, EMD_DEFAULTS.minVolume, 0, 1_000_000);
    const countries = new Map<string, number>();
    const projects = new Map<string, number>();
    for (const c of t.clusters) {
      countries.set(c.country, (countries.get(c.country) ?? 0) + 1);
      for (const p of c.projects) projects.set(p, (projects.get(p) ?? 0) + 1);
    }
    return {
      fileName: t.fileName,
      rows: t.rows,
      clusters: t.clusters.length,
      keywords: t.clusters.reduce((a, c) => a + c.keywords.length, 0),
      eligible: t.clusters.reduce((a, c) => a + eligibleKeywords(c, min).length, 0),
      countries: [...countries.entries()].sort((a, b) => b[1] - a[1]),
      projects: [...projects.entries()],
      problems: t.problems,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Запуск подбора EMD: таблица скачивается заново (могла измениться), кластеры выбранных проектов становятся «брендами» подбора. */
export async function launchEmdRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const str = (k: string) => String(f.get(k) ?? "").trim();
  let id: string;
  try {
    const url = str("sourceUrl");
    const t = await loadEmdTable(url);
    const picked = f.getAll("project").map(String);
    const clusters = picked.length ? t.clusters.filter((c) => !c.projects.length || c.projects.some((p) => picked.includes(p))) : t.clusters;
    if (!clusters.length) throw new Error("Не выбран ни один проект с кластерами");
    if (clusters.length > LIMITS.brands) throw new Error(`Слишком много кластеров: ${clusters.length}, максимум ${LIMITS.brands} за подбор`);
    const tlds = Array.from(new Set(parseList(str("tlds")).map(normalizeTld).filter(Boolean)));
    const items: BrandItem[] = clusters.map(({ country, ...c }) => ({ brand: c.theme, country, modifiers: [], emd: c }));
    const settings: DomainRunSettings = {
      ...DEFAULT_SETTINGS,
      mode: "emd",
      emd: {
        sourceUrl: url,
        fileName: t.fileName,
        loadedAt: new Date().toISOString(),
        minVolume: clamp(str("minVolume"), EMD_DEFAULTS.minVolume, 0, 1_000_000),
        maxLen: clamp(str("maxLen"), EMD_DEFAULTS.maxLen, 8, 63),
        matchPct: clamp(str("matchPct"), EMD_DEFAULTS.matchPct, 10, 100),
      },
      brands: items.map((it) => it.brand),
      items,
      countryPresets: {},
      letterMode: "off",
      usePool: false,
      useKeywords: false,
      autoResearch: f.get("serp") === "on",
      checkAll: true,
      autoZones: f.get("autoZones") === "on",
      tlds,
      suffixTiers: [[], [], []],
      perBrand: clamp(str("perCluster"), 5, 1, LIMITS.perBrandMax),
      extraPerBrand: 0,
      allowHyphen: f.get("allowHyphen") === "on",
      countryCode: items[0]!.country,
      serpKeyword: "",
      minedSuffixes: [],
      serp: null,
    };
    const r = await createDomainRun(me, settings, str("name") || `EMD · ${t.fileName.replace(/\.xlsx$/i, "").slice(0, 80)}`);
    id = r.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  redirect(`/gambling/domains/runs/${id}`);
}
