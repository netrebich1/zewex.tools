/**
 * Хост canvas для Node на @napi-rs/canvas (prebuilt Skia).
 *
 * Шрифты: `registerFontsFromDir(dir)` обходит `<dir>/<Family>/*.ttf|otf`.
 * Соглашение: имя папки = семейство с пробелами, заменёнными на дефисы
 * («Playfair-Display» → «Playfair Display»); файлы — любые начертания
 * (обычно `<weight>.ttf`, их кладёт scripts/pins/fetch-fonts.mjs).
 */
import { readdirSync, statSync } from "fs";
import { join } from "path";
import type { Canvas } from "@napi-rs/canvas";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { setCanvasHost, type CanvasHost, type Ctx2D, type HostCanvas, type HostImage } from "./host";

type NativeCanvas = Canvas;

const natives = new WeakMap<HostCanvas, NativeCanvas>();

function wrap(c: NativeCanvas): HostCanvas {
  const hc: HostCanvas = {
    width: c.width,
    height: c.height,
    getContext: () => c.getContext("2d") as unknown as Ctx2D,
  };
  natives.set(hc, c);
  return hc;
}

function native(c: HostCanvas): NativeCanvas {
  const n = natives.get(c);
  if (!n) throw new Error("HostCanvas создан не этим хостом");
  return n;
}

export const nodeCanvasHost: CanvasHost = {
  createCanvas: (w, h) => wrap(createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))) as Canvas),
  loadImage: async (data) => {
    const img = await loadImage(data);
    const out: HostImage = img;
    return out;
  },
  // napi-rs принимает качество 0..100.
  encodeJpeg: (c, quality) => native(c).encode("jpeg", Math.round(Math.max(0, Math.min(1, quality)) * 100)),
  encodePng: (c) => native(c).encode("png"),
  hasFont: (family) => GlobalFonts.has(family),
};

/** Имя папки → семейство: дефисы становятся пробелами. */
export function folderToFamily(folder: string): string {
  return folder.replace(/-/g, " ").trim();
}

/** Регистрирует все шрифты из `<dir>/<Family-With-Dashes>/*.ttf|otf`. */
export function registerFontsFromDir(dir: string): { families: number; files: number } {
  let families = 0;
  let files = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { families, files };
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const sub = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const family = folderToFamily(name);
    let n = 0;
    for (const f of readdirSync(sub)) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      if (GlobalFonts.registerFromPath(join(sub, f), family)) n++;
    }
    if (n) {
      families++;
      files += n;
    }
  }
  return { families, files };
}

/** Семейства, известные Skia (системные + зарегистрированные). */
export function loadedFamilies(): Set<string> {
  const list = GlobalFonts.families as ReadonlyArray<{ family: string }>;
  return new Set(list.map((f) => f.family));
}

/** Ставит Node-хост и (если задана папка) регистрирует шрифты. */
export function installNodeCanvasHost(fontsDir?: string): { families: number; files: number } {
  setCanvasHost(nodeCanvasHost);
  return fontsDir ? registerFontsFromDir(fontsDir) : { families: 0, files: 0 };
}
