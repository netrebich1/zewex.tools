import type { ErrorKind } from "./protocol";

/** Ошибка с видом для портала: по виду портал решает, повторять ли задание и что делать с аккаунтом. */
export class AgentError extends Error {
  constructor(public kind: ErrorKind, message: string, public screenshot?: string | null, public html?: string | null) {
    super(message);
  }
}

export const isAgentError = (e: unknown): e is AgentError => e instanceof AgentError;

/** Любая неизвестная ошибка → unknown (с текстом), сетевые — network. */
export function toAgentError(e: unknown): AgentError {
  if (isAgentError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|ERR_INTERNET_DISCONNECTED|net::ERR/i.test(msg)) return new AgentError("network", msg.slice(0, 250));
  return new AgentError("unknown", msg.slice(0, 250));
}
