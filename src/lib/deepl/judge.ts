/**
 * Оценка качества итоговой статьи «главным редактором» (ИИ): по секциям сравнивается оригинал до переводов
 * и итог, модель ставит 1–5 по шкалам мова/факти/терміни/звертання/стиль и даёт цитаты с исправлением.
 * Нужна владельцу, чтобы видеть не «переписано 13%», а «факты 4/5: топ без бретелей — в оригинале на бретелях».
 * Модель — не та, что правила (JUDGE_MODEL), чтобы не было самооценки. Стоимость ≈ $0.003 на статью.
 */
import { chat, sectionsOf, type AiCtx } from "./edit";
import { mapLimit } from "./deepl";
import { addressStats, countCliches, countRussianisms, dominantAddress, visibleText } from "./html";
import { langPack } from "./lang";
import type { QualityIssueNote, QualityReport } from "./types";

type Raw = { mova?: unknown; fakty?: unknown; terminy?: unknown; zvertannia?: unknown; styl?: unknown; issues?: unknown };
const KEYS = ["mova", "fakty", "terminy", "zvertannia", "styl"] as const;

const score = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : null;
};

/** JSON из ответа модели: без обёрток ```json, с первого «{» до последнего «}». */
function parseJson(text: string): Raw | null {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as Raw;
  } catch {
    return null;
  }
}

/** Пары «оригинал секции — итог секции» по номерам H2; если число H2 не совпало — вся статья одной парой. */
function pairs(sourceHtml: string, finalHtml: string): Array<[string, string]> {
  const a = sectionsOf(sourceHtml).map(visibleText);
  const b = sectionsOf(finalHtml).map(visibleText);
  if (a.length === b.length && a.length > 1) return a.map((o, i) => [o, b[i]!] as [string, string]).filter(([o, e]) => o.length > 60 && e.length > 60);
  return [[visibleText(sourceHtml).slice(0, 14000), visibleText(finalHtml).slice(0, 14000)]];
}

export async function judgeArticle(ctx: AiCtx, sourceHtml: string, finalHtml: string, lang: string | null | undefined): Promise<QualityReport> {
  const L = langPack(lang);
  let costUsd = 0;
  const jctx: AiCtx = { ...ctx, onCost: (usd) => { costUsd += usd; ctx.onCost?.(usd); } };
  const list = pairs(sourceHtml, finalHtml);
  const sums: Record<(typeof KEYS)[number], number[]> = { mova: [], fakty: [], terminy: [], zvertannia: [], styl: [] };
  const issues: QualityIssueNote[] = [];
  let judged = 0;
  await mapLimit(list.map((_, i) => i), 3, async (i) => {
    const [o, e] = list[i]!;
    let raw: Raw | null = null;
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      try {
        raw = parseJson(await chat(jctx, L.judgeSystem, L.judgeUser(o, e), 0));
      } catch {
        raw = null;
      }
    }
    if (!raw) return;
    let any = false;
    for (const k of KEYS) {
      const v = score(raw[k]);
      if (v != null) {
        sums[k].push(v);
        any = true;
      }
    }
    if (!any) return;
    judged++;
    if (Array.isArray(raw.issues)) {
      for (const it of raw.issues.slice(0, 6) as Array<{ k?: unknown; q?: unknown; fix?: unknown }>) {
        const q = String(it?.q ?? "").trim();
        if (!q) continue;
        issues.push({ k: String(it?.k ?? "").trim() || "mova", q: q.slice(0, 200), fix: String(it?.fix ?? "").trim().slice(0, 200), section: list.length > 1 ? i : undefined });
      }
    }
  });
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const scores = { mova: avg(sums.mova), fakty: avg(sums.fakty), terminy: avg(sums.terminy), zvertannia: avg(sums.zvertannia), styl: avg(sums.styl) };
  const present = KEYS.map((k) => scores[k]).filter((v) => v > 0);
  const srcAddr = dominantAddress(sourceHtml);
  const fin = addressStats(finalHtml);
  return {
    model: ctx.model ?? "",
    sections: judged,
    scores,
    total: present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10 : 0,
    issues: issues.sort((a, b) => (a.k === "fakty" ? -1 : 0) - (b.k === "fakty" ? -1 : 0)).slice(0, 40),
    metrics: {
      russianisms: countRussianisms(finalHtml),
      clichesSource: countCliches(sourceHtml),
      clichesFinal: countCliches(finalHtml),
      addressSource: srcAddr,
      addressFinal: dominantAddress(finalHtml),
      addressMixed: fin.ty >= 2 && fin.vy >= 2,
    },
    costUsd: Math.round(costUsd * 1e6) / 1e6,
  };
}
