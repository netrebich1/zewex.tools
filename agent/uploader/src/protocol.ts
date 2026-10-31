/** Копия протокола портала (src/lib/uploader/types.ts) — ровно то, что нужно агенту. При изменении протокола править оба файла. */

export const AGENT_VERSION = "0.1.5";
export const PROTOCOL = 1;

export type StepKind = "upload_csv" | "check_history" | "analytics";
export type Step = { kind: StepKind };

export type ErrorKind = "dolphin_offline" | "dolphin_auth" | "profile_not_found" | "profile_busy" | "proxy_failed" | "browser_missing" | "not_logged_in" | "pinterest_rejected" | "rate_limited" | "upload_form_changed" | "no_file" | "network" | "stopped" | "unknown";

export type UplHumanize = {
  betweenSites: [number, number];
  afterOpen: [number, number];
  feedScrolls: [number, number];
  scrollPause: [number, number];
  beforeUpload: [number, number];
  afterUpload: [number, number];
  typeMs: [number, number];
  browseFeed: boolean;
};
export const DEFAULT_HUMANIZE: UplHumanize = {
  betweenSites: [60, 180], afterOpen: [3, 8], feedScrolls: [1, 3], scrollPause: [2, 5], beforeUpload: [2, 6], afterUpload: [5, 15], typeMs: [60, 180], browseFeed: true,
};

export type VerifyResult = { published: number | null; failed: number | null; processing: boolean; text?: string | null };

export type AgentTask = {
  id: string;
  runId: string;
  phase: "upload" | "verify";
  steps: Step[];
  site: { id: string; name: string };
  profileId: string;
  profileName: string | null;
  day: string;
  fileName: string | null;
  rows: number | null;
  fileUrl: string | null;
  pinUsername: string | null;
  expectFileName: string | null;
};

export type HelloResponse = { protocol: number; agent: { id: string; name: string }; dolphinToken: string | null; humanize: UplHumanize; bulkUrl: string | null; pollSec: number; latest?: string; latestUrl?: string | null };
export type NextResponse = { tasks: AgentTask[]; stop: string[]; wait?: number; reason?: string; latest?: string; latestUrl?: string | null };
