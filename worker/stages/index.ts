import type { PinJob, PinRun } from "@prisma/client";
import type { JobStage } from "@/lib/pins/types";

/**
 * Контракт этапа. Этап делает только недостающую работу (идемпотентен),
 * регулярно зовёт ctx.tick() — это продлевает lease, пишет прогресс и
 * сообщает, что пользователь нажал «Стоп».
 */
export type StageCtx = {
  job: PinJob;
  run: PinRun;
  signal: AbortSignal;
  /** Продлить lease, обновить прогресс; бросает StopRequested, если нажали «Стоп». */
  tick: (patch?: { done?: number; total?: number; label?: string }) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
};

export type StageResult = {
  /** Сколько элементов осталось с временными ошибками (стоит повторить позже). */
  retryLater?: number;
  /** Фатальная причина: прогон блокируется с этим текстом. */
  fatal?: string;
  /** Короткая сводка в лог/label. */
  summary?: string;
};

export type StageHandler = (ctx: StageCtx) => Promise<StageResult>;

export class StopRequested extends Error {
  constructor() {
    super("stop requested");
    this.name = "StopRequested";
  }
}

const noop: StageHandler = async (ctx) => {
  const total = Number((ctx.job.options as { steps?: number } | null)?.steps ?? 5);
  for (let i = 1; i <= total; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await ctx.tick({ done: i, total, label: `тест ${i}/${total}` });
  }
  return { summary: `noop ${total} шагов` };
};

import { meta } from "./meta";
import { photos } from "./photos";
import { plan } from "./plan";
import { prompts } from "./prompts";
import { images } from "./images";
import { upload } from "./upload";
import { texts } from "./texts";
import { schedule } from "./schedule";
import { canvasStage } from "./canvas";
import { previews } from "./previews";

export const STAGES: Partial<Record<JobStage, StageHandler>> = { noop, meta, photos, plan, prompts, images, texts, upload, schedule, canvas: canvasStage, previews };
