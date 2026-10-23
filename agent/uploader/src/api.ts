/** Клиент портала: POST /api/uploader/agent/{action} с токеном агента; скачивание CSV. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentError } from "./errors";
import { filesDir } from "./paths";
import { AGENT_VERSION, type AgentTask, type ErrorKind, type HelloResponse, type NextResponse, type VerifyResult } from "./protocol";

export class PortalClient {
  constructor(private portal: string, private token: string) {}

  private async call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.portal}/api/uploader/agent/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ version: AGENT_VERSION, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = new Error(`${action}: ${json.error ?? res.statusText} (${json.code ?? res.status})`) as Error & { code?: string; status?: number };
      err.code = typeof json.code === "string" ? json.code : undefined;
      err.status = res.status;
      throw err;
    }
    return json as T;
  }

  hello(hostInfo: Record<string, unknown>, state: string) { return this.call<HelloResponse>("hello", { hostInfo, state }); }
  profiles(profiles: Array<{ id: string; name: string; tags?: unknown; platform?: string | null }>) { return this.call<{ ok: boolean; saved: number }>("profiles", { profiles }); }
  next(busy: number, state: string) { return this.call<NextResponse>("next", { busy, state }); }
  progress(taskId: string, step: string, extra: { screenshot?: string | null; username?: string | null } = {}) { return this.call<{ ok: boolean }>("progress", { taskId, step, state: step, ...extra }); }
  finishUpload(taskId: string, result: { rowsSeen?: number | null; message?: string | null; screenshot?: string | null; timings?: Record<string, number> }) { return this.call<{ ok: boolean }>("finish", { taskId, result }); }
  finishVerify(taskId: string, verify: VerifyResult, screenshot: string | null) { return this.call<{ ok: boolean }>("finish", { taskId, result: { verify, screenshot } }); }
  fail(taskId: string, kind: ErrorKind, error: string, screenshot?: string | null, html?: string | null) { return this.call<{ ok: boolean; retry: boolean }>("fail", { taskId, kind, error, screenshot, html }); }
  state(state: string, busy: boolean) { return this.call<{ ok: boolean }>("state", { state, busy }); }

  /** CSV задания → файл на диске; имя — из заголовка X-File-Name. */
  async downloadFile(task: AgentTask): Promise<{ path: string; fileName: string; rows: number }> {
    if (!task.fileUrl) throw new AgentError("no_file", "у задания нет файла");
    const res = await fetch(`${this.portal}${task.fileUrl}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (res.status === 404) throw new AgentError("no_file", (await res.text().catch(() => "")) || "файл пуст");
    if (!res.ok) throw new AgentError("network", `скачивание файла: HTTP ${res.status}`);
    const fileName = res.headers.get("x-file-name") || task.fileName || `${task.day}_${task.site.name}.csv`;
    const rows = Number(res.headers.get("x-rows") || task.rows || 0);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20) throw new AgentError("no_file", "файл пустой");
    const path = join(filesDir(task.day), fileName.replace(/[\\/:*?"<>|]/g, "_"));
    writeFileSync(path, buf);
    return { path, fileName, rows };
  }
}
