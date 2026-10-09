/** Тексты пина: чистка цифр, которых нет в источнике (порт canvasText.ts). */
export interface CanvasHookText {
  title: string;
  kicker: string;
  subtitle: string;
  cta: string;
}

export function sourceDigits(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    for (const match of String(part || "").matchAll(/\d+/g)) found.add(match[0]);
  }
  return Array.from(found).sort((a, b) => b.length - a.length);
}

export function cleanCanvasHook(hook: CanvasHookText, allowedDigits: string[]): CanvasHookText {
  const allowed = new Set(allowedDigits);
  const strip = (value: string) => String(value || "")
    .replace(/\d+/g, (digit) => (allowed.has(digit) ? digit : " "))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:—–-]+|[\s:—–-]+$/g, "")
    .trim();
  return {
    title: strip(hook.title),
    kicker: strip(hook.kicker),
    subtitle: strip(hook.subtitle),
    cta: strip(hook.cta),
  };
}
