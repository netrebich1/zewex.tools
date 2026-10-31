/**
 * Обработка одной статьи прогона в воркере (порт processItem из article-jumble-maker pipeline-worker).
 * План: загрузка из WP → переводы DeepL (до 3 шагов) → H2 → постредактура → добор ключей → (публикация).
 * Каждый этап пишет снимок; при перезапуске берётся непрерывный префикс готовых снимков — платные шаги не повторяются.
 * Плохой этап откатывается ко входу; провал перевода останавливает цепочку (иначе гибрид языков).
 */
import { Prisma, type DeeplItem, type DeeplJob } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  anchorsFromTokens, changedWordCount, checkIntegrity, countKeyword, detectLangMismatch, extractKeywords, keywordTarget, protectHtml,
  restoreHtml, type QualityIssue,
} from "./html";
import { runTranslate, sourceCode, translateKeywords } from "./deepl";
import { KEYWORD_TOPUP_PROMPT, runEdit, runHeadings, type AiCtx } from "./edit";
import { getPost, savePost, siteCreds } from "./wp";
import { parseSettings, type KeywordStat, type Snapshot, type Warning } from "./types";

export const ITEM_LEASE_SECONDS = 180;

type StageResult = { html: string; warnings: QualityIssue[]; rolledBack?: number; changedWords?: number; chars?: number };
type PlanStage = { id: string; stage: string; label: string; run: (html: string) => Promise<StageResult>; critical?: boolean; expectLang?: string; allowPartial?: boolean; reviewNoop?: boolean };

export function extractH1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const text = m ? m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  return text || null;
}

function uniqueWarnings(items: Warning[]): Warning[] {
  const seen = new Set<string>();
  return items.filter((w) => {
    const k = `${w.code}\n${w.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const upsertSnapshot = (list: Snapshot[], s: Snapshot) => {
  const i = list.findIndex((x) => x.key === s.key);
  if (i >= 0) list[i] = s;
  else list.push(s);
};

/** Почему остановились между этапами. */
type Interrupt = "stop" | "release" | null;

export type ProcessOutcome = "done" | "stopped" | "released" | "lost";

export async function processItem(item: DeeplItem, job: DeeplJob, workerId: string, shouldStop: () => boolean): Promise<ProcessOutcome> {
  const cfg = parseSettings(job.settings);
  const warnings: Warning[] = [];
  let costUsd = 0;
  let deeplChars = 0;
  const ai: AiCtx = { userId: job.createdById, teamId: job.teamId, refId: item.id, model: cfg.model, onCost: (usd) => (costUsd += usd) };

  /** Продление аренды и проверка, что статья всё ещё наша и прогон не остановлен. */
  const touch = async (stage?: string): Promise<Interrupt | "lost"> => {
    const rows = await prisma.$queryRaw<Array<{ workerId: string | null; jobStatus: string; stopRequested: number | boolean }>>`
      SELECT i.workerId, j.status AS jobStatus, j.stopRequested FROM DeeplItem i JOIN DeeplJob j ON j.id = i.jobId WHERE i.id = ${item.id}`;
    const r = rows[0];
    if (!r || r.workerId !== workerId) return "lost";
    await prisma.$executeRaw`UPDATE DeeplItem SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${ITEM_LEASE_SECONDS} SECOND) ${stage ? Prisma.sql`, stage = ${stage}` : Prisma.empty} WHERE id = ${item.id}`;
    if (r.jobStatus === "STOPPED" || Boolean(r.stopRequested)) return "stop";
    if (shouldStop()) return "release";
    return null;
  };
  const heartbeat = setInterval(() => {
    prisma.$executeRaw`UPDATE DeeplItem SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${ITEM_LEASE_SECONDS} SECOND) WHERE id = ${item.id} AND workerId = ${workerId}`.catch(() => {});
  }, 30_000);

  const flushCost = async () => {
    if (!costUsd && !deeplChars) return;
    await prisma.deeplItem.update({ where: { id: item.id }, data: { costUsd: { increment: costUsd }, deeplChars: { increment: deeplChars } } });
    costUsd = 0;
    deeplChars = 0;
  };

  const interrupted = async (why: Interrupt | "lost"): Promise<ProcessOutcome> => {
    await flushCost().catch(() => {});
    if (why === "lost") return "lost";
    if (why === "release") {
      await prisma.deeplItem.update({ where: { id: item.id }, data: { status: "pending", workerId: null, leaseUntil: null, warnings: uniqueWarnings(warnings) as unknown as Prisma.InputJsonValue } });
      return "released";
    }
    await prisma.deeplItem.update({ where: { id: item.id }, data: { status: "stopped", workerId: null, leaseUntil: null, warnings: uniqueWarnings(warnings) as unknown as Prisma.InputJsonValue } });
    return "stopped";
  };

  try {
    // ---- Исходник из WordPress (один раз; дальше берётся из базы) ----
    let sourceHtml = item.sourceHtml ?? "";
    let title = item.title;
    if (!sourceHtml.trim()) {
      const why = await touch("fetch");
      if (why) return await interrupted(why);
      if (!job.accessId || !item.wpPostId) throw new Error("Нет сайта или ID поста для загрузки статьи");
      const post = await getPost(await siteCreds(job.accessId), item.wpPostId);
      if (!post.html.trim()) throw new Error("В WordPress у поста пустой текст");
      sourceHtml = post.html;
      title = post.title || title;
      await prisma.deeplItem.update({ where: { id: item.id }, data: { sourceHtml, title, sourceUrl: post.link || item.sourceUrl, wpStatus: post.status, wpDate: post.date.slice(0, 16).replace("T", " ") } });
    }
    const h1 = extractH1(sourceHtml);

    // ---- План этапов: фиксированный порядок и стабильные id ----
    const steps = cfg.translateSteps;
    const finalLang: string | null = steps.length ? steps[steps.length - 1]!.target : null;
    let anchorTexts: string[] = [];
    let seoKeys: string[] | null = null;
    let seoSourceKeys: string[] = [];
    let seoReport: KeywordStat[] = [];
    const seoOn = cfg.seo.enabled && cfg.postEdit.enabled;

    /** Ключи на языке текущего текста + их дефицит относительно исходника. */
    const prepareSeo = async (currentHtml: string) => {
      if (!seoOn) return [] as { key: string; need: number }[];
      if (!seoKeys) {
        // Ручной ключ берём, только если он есть в исходнике: список общий на весь прогон, а статьи разные.
        const manual = cfg.seo.keywords.flatMap((l) => l.split(/[,;]/)).map((k) => k.trim()).filter((k) => k && countKeyword(sourceHtml, k) > 0);
        const auto = cfg.seo.auto ? extractKeywords(sourceHtml, title, 10) : [];
        seoSourceKeys = [...new Set([...manual, ...auto])].slice(0, 20);
        const firstSrc = sourceCode(steps[0]?.source);
        const sameLang = !finalLang || (firstSrc && sourceCode(finalLang) === firstSrc);
        const translated = sameLang ? seoSourceKeys : await translateKeywords(seoSourceKeys, finalLang, firstSrc);
        seoKeys = translated.length === seoSourceKeys.length ? translated : seoSourceKeys;
      }
      seoReport = seoKeys.map((key, i) => {
        const source = countKeyword(sourceHtml, seoSourceKeys[i] || key);
        const current = countKeyword(currentHtml, key);
        const { min, max } = keywordTarget(source, cfg.seo.minPct, cfg.seo.maxPct);
        return { key, source, current, min, max, ok: current >= min && current <= max };
      });
      return seoReport.filter((r) => r.current < r.min).map((r) => ({ key: r.key, need: r.min - r.current }));
    };

    const plan: PlanStage[] = [];
    steps.forEach((s, i) => {
      const label = steps.length > 1 ? `Перевод ${i + 1} (${s.target})` : `Перевод (${s.target})`;
      plan.push({
        id: `translate#${i}:${s.source || "auto"}>${s.target}`, stage: "translate", label, critical: true, expectLang: s.target,
        run: async (h) => {
          const r = await runTranslate(h, s.target, s.source, true);
          deeplChars += r.chars;
          return { html: r.html, warnings: r.warnings, rolledBack: r.rolledBack };
        },
      });
    });
    if (cfg.headings.enabled && cfg.headings.prompt.trim()) {
      plan.push({ id: "headings#0", stage: "headings", label: "Заголовки H2", run: (h) => runHeadings({ ...ai, model: cfg.headingsModel || cfg.model }, h, cfg.headings.prompt, { title, h1 }) });
    }
    if (cfg.postEdit.enabled && cfg.postEdit.prompt.trim()) {
      plan.push({
        id: "post_edit#0", stage: "post_edit", label: "Постредактура", critical: true, allowPartial: true, reviewNoop: true,
        // Только язык: ключи сюда намеренно не передаются, их вписывает следующий независимый этап.
        run: (h) => runEdit(ai, h, cfg.postEdit.prompt, { title, h1, lightTouch: true, anchors: anchorTexts }, true, {
          sections: 3, maxTextGrowthPct: 12, maxRewritePct: 22,
          // Оригинал той же секции — сверить термины, факты и обращение после цепочки переводов (формулировки не возвращаются).
          referenceHtml: steps.length ? protectHtml(sourceHtml).text : undefined,
        }),
      });
      if (seoOn) {
        plan.push({
          id: "kw_topup#0", stage: "keyword_topup", label: "Добор ключей", allowPartial: true,
          run: async (h) => {
            const deficits = await prepareSeo(h);
            if (!deficits.length) return { html: h, warnings: [], changedWords: 0 };
            return runEdit(ai, h, KEYWORD_TOPUP_PROMPT, { title, h1, lightTouch: true, anchors: anchorTexts, keywordDeficits: deficits }, true, {
              sections: 2, maxTextGrowthPct: 4, maxRewritePct: 12, retryKeywordDeficits: true,
            });
          },
        });
      }
    }

    // ---- Возобновление: непрерывный префикс готовых этапов ----
    const prev: Snapshot[] = Array.isArray(item.stages) ? (item.stages as unknown as Snapshot[]) : [];
    const snapshots: Snapshot[] = [{ key: "source", label: "Исходный", html: sourceHtml, chars: sourceHtml.length }];
    let resumeHtml = sourceHtml;
    let startIdx = 0;
    for (let i = 0; i < plan.length; i++) {
      const done = prev.find((s) => s.key === plan[i]!.id);
      if (!done || typeof done.html !== "string" || !done.html.trim()) break;
      snapshots.push({ ...done, label: plan[i]!.label });
      resumeHtml = done.html;
      startIdx = i + 1;
    }
    if (startIdx > 0) warnings.push({ code: "resume", detail: `Возобновление: пропущено уже выполненных этапов — ${startIdx}` });

    await prisma.deeplItem.update({ where: { id: item.id }, data: { stages: snapshots as unknown as Prisma.InputJsonValue } });

    // Единая защита картинок/шорткодов/ссылок/iframe на весь оставшийся прогон статьи.
    const { text: protectedSource, tokens } = protectHtml(resumeHtml);
    anchorTexts = anchorsFromTokens(tokens).map((a) => a.text);
    let html = protectedSource;
    const problems: string[] = [];

    const saveSnapshot = async (key: string, label: string, extra?: Partial<Snapshot>) => {
      const restored = restoreHtml(html, tokens, finalLang);
      upsertSnapshot(snapshots, { key, label, html: restored, chars: restored.length, ...extra });
      await prisma.deeplItem.update({ where: { id: item.id }, data: { stages: snapshots as unknown as Prisma.InputJsonValue, warnings: uniqueWarnings(warnings) as unknown as Prisma.InputJsonValue } });
    };

    let aborted = false;
    for (let i = startIdx; i < plan.length; i++) {
      const st = plan[i]!;
      const why = await touch(st.stage);
      if (why) return await interrupted(why);
      const before = html;
      const r = await st.run(html);
      warnings.push(...r.warnings.map((w) => ({ ...w, detail: `${st.label}: ${w.detail}` })));
      let rolledBack = false;
      if ((r.rolledBack ?? 0) > 0 && !st.allowPartial) {
        problems.push(`${st.label}: ${r.rolledBack} фрагм. остались без обработки`);
        warnings.push({ code: "stage_rollback", detail: `${st.label} откатана полностью: ${r.rolledBack} фрагм. не прошли проверку` });
        rolledBack = true;
      } else if ((r.rolledBack ?? 0) > 0) {
        problems.push(`${st.label}: ${r.rolledBack} фрагм. остались без обработки`);
        warnings.push({ code: "stage_partial_rollback", detail: `${st.label}: сохранены успешные фрагменты, ${r.rolledBack} фрагм. оставлены без изменений` });
      }
      if (!rolledBack) {
        const integrity = checkIntegrity(before, r.html);
        if (integrity.fatal) {
          warnings.push(...integrity.issues.map((w) => ({ code: w.code, detail: `${st.label} откачена — ${w.detail}` })));
          problems.push(`${st.label} откачена: ${integrity.issues.map((w) => w.detail).join("; ")}`);
          rolledBack = true;
        } else {
          warnings.push(...integrity.issues.map((w) => ({ ...w, detail: `${st.label}: ${w.detail}` })));
          html = r.html;
          if (html.trim() === before.trim()) {
            warnings.push({ code: `${st.stage}_noop`, detail: `${st.label}: изменений нет` });
            if (st.reviewNoop) problems.push(`${st.label}: изменений нет — проверьте промт или исходный текст`);
          }
        }
      }
      // Язык после перевода: ловим «половина статьи осталась на исходном языке».
      if (!rolledBack && st.expectLang) {
        const mismatch = detectLangMismatch(html, st.expectLang);
        if (mismatch) {
          warnings.push({ code: "lang_mismatch", detail: `${st.label}: ${mismatch}` });
          problems.push(`${st.label}: ${mismatch}`);
          rolledBack = true;
        }
      }
      if (rolledBack) {
        html = before;
        // Неудачный этап не отмечаем готовым: повтор статьи начнёт именно с него.
        await saveSnapshot(`${st.id}#failed`, `${st.label} — откатан`);
      } else {
        const changedWords = typeof r.changedWords === "number" ? r.changedWords : changedWordCount(before, html);
        const status = changedWords > 0 ? ((r.rolledBack ?? 0) > 0 ? "partial" : "changed") : "noop";
        if (changedWords === 0 && st.reviewNoop) await saveSnapshot(`${st.id}#noop`, `${st.label} — без изменений`, { changedWords: 0, status: "noop" });
        else await saveSnapshot(st.id, st.label, { changedWords, status });
      }
      await flushCost();
      if (rolledBack && st.critical) {
        warnings.push({ code: "chain_stopped", detail: `${st.label} не удалась — остальные этапы пропущены, статья требует ручной проверки` });
        aborted = true;
        break;
      }
    }

    const finalHtml = restoreHtml(html, tokens, finalLang);
    upsertSnapshot(snapshots, { key: "final", label: "Итоговый", html: finalHtml, chars: finalHtml.length });

    if (finalLang && !aborted) {
      const mismatch = detectLangMismatch(finalHtml, finalLang);
      if (mismatch) {
        warnings.push({ code: "lang_mismatch", detail: mismatch });
        problems.push(mismatch);
      }
    }

    if (seoOn) {
      await prepareSeo(finalHtml);
      const missed = seoReport.filter((r) => r.current < r.min);
      if (missed.length) {
        warnings.push({ code: "keywords_below_min", detail: `Ключи ниже минимума: ${missed.map((r) => `${r.key} (${r.current}/${r.min})`).join(", ")}` });
      }
      const over = seoReport.filter((r) => r.source > 0 && r.current > r.max);
      if (over.length) warnings.push({ code: "keywords_above_max", detail: `Ключи выше максимума: ${over.map((r) => `${r.key} (${r.current}/${r.max})`).join(", ")}` });
    }

    const needsReview = aborted || problems.length > 0;
    let published: { link: string; id: number; mode: string } | null = null;
    if (cfg.publish.enabled && !needsReview) {
      const why = await touch("publish");
      if (why === "lost") return "lost";
      published = await publishHtml(job, { ...item, title }, finalHtml, cfg.publish.target, cfg.publish.status);
    } else if (cfg.publish.enabled) {
      warnings.push({ code: "publish_blocked", detail: "Автопубликация отменена: статья не прошла проверку качества — опубликуйте вручную после просмотра" });
    }

    await flushCost();
    await prisma.deeplItem.update({
      where: { id: item.id },
      data: {
        finalHtml,
        stages: snapshots as unknown as Prisma.InputJsonValue,
        warnings: uniqueWarnings(warnings) as unknown as Prisma.InputJsonValue,
        keywordReport: seoReport as unknown as Prisma.InputJsonValue,
        stage: aborted ? "review" : "done",
        status: needsReview ? "warning" : "done",
        error: needsReview ? problems.slice(0, 3).join(" | ") || "Цепочка остановлена" : null,
        workerId: null,
        leaseUntil: null,
        finishedAt: new Date(),
        ...(published ? { publishedUrl: published.link, publishedPostId: published.id, publishMode: published.mode, publishedAt: new Date(), revertedAt: null } : {}),
      },
    });
    return "done";
  } catch (e) {
    await flushCost().catch(() => {});
    throw e;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Публикация итогового HTML: в исходный пост (перед первой заменой сохраняется оригинал из WP для отката) или новым постом.
 */
export async function publishHtml(
  job: Pick<DeeplJob, "accessId">,
  item: Pick<DeeplItem, "id" | "wpPostId" | "title" | "originalWpHtml">,
  html: string,
  target: "source" | "new",
  status: string,
): Promise<{ link: string; id: number; mode: string }> {
  if (!job.accessId) throw new Error("У прогона нет сайта");
  const creds = await siteCreds(job.accessId);
  const replace = target === "source" && !!item.wpPostId;
  if (target === "source" && !item.wpPostId) throw new Error("У статьи нет исходного поста — доступна только публикация новым постом");
  if (replace && !item.originalWpHtml) {
    const cur = await getPost(creds, item.wpPostId!);
    await prisma.deeplItem.update({ where: { id: item.id }, data: { originalWpHtml: cur.html, originalWpStatus: cur.status, originalWpTitle: cur.title } });
  }
  const payload: Record<string, unknown> = { content: html, status: status || "draft" };
  if (!replace && item.title) payload.title = item.title;
  const r = await savePost(creds, replace ? item.wpPostId! : null, payload);
  return { link: r.link, id: r.id, mode: replace ? "replace" : "new" };
}
