const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
export const log = {
  info: (msg: string, extra?: unknown) => console.log(`${ts()} INFO  ${msg}${extra !== undefined ? " " + safe(extra) : ""}`),
  warn: (msg: string, extra?: unknown) => console.warn(`${ts()} WARN  ${msg}${extra !== undefined ? " " + safe(extra) : ""}`),
  error: (msg: string, extra?: unknown) => console.error(`${ts()} ERROR ${msg}${extra !== undefined ? " " + safe(extra) : ""}`),
};
function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
