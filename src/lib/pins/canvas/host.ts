/**
 * Абстракция «хоста» canvas: движок пинов не знает про браузер или Node.
 * В воркере хост — `host.node.ts` (@napi-rs/canvas). Тип контекста структурный:
 * нативный контекст приводится к CanvasRenderingContext2D (API совпадает).
 */

export interface HostImage { width: number; height: number }

export type Ctx2D = CanvasRenderingContext2D;

export interface HostCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): Ctx2D;
}

export interface CanvasHost {
  createCanvas(w: number, h: number): HostCanvas;
  /** Декодирует JPEG/PNG/WebP из буфера. */
  loadImage(data: Buffer): Promise<HostImage>;
  /** quality 0..1. */
  encodeJpeg(c: HostCanvas, quality: number): Promise<Buffer>;
  encodePng?(c: HostCanvas): Promise<Buffer>;
  /** Зарегистрировано ли семейство шрифта на хосте. */
  hasFont(family: string): boolean;
}

let host: CanvasHost | null = null;

export function setCanvasHost(h: CanvasHost): void {
  host = h;
}

export function getHost(): CanvasHost {
  if (!host) {
    throw new Error("Canvas host не задан: вызовите setCanvasHost() (в воркере — installNodeCanvasHost из host.node.ts)");
  }
  return host;
}

/** HostImage как источник для drawImage: нативный Image структурно совместим. */
export function asImageSource(img: HostImage): CanvasImageSource {
  return img as unknown as CanvasImageSource;
}
