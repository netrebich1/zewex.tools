/** «Как человек»: случайные паузы, движения мыши по кривой, прокрутка ленты, печать по символам. */
import type { Page } from "playwright-core";
import type { UplHumanize } from "./protocol";

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => Math.round(rand(a, b));
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Пауза из диапазона в секундах. */
export const pause = (range: [number, number]) => sleep(rand(range[0], range[1]) * 1000);

/** Мышь к точке по кривой Безье с 12–25 шагами и мелким дрожанием. */
export async function moveMouse(page: Page, x: number, y: number): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const from = { x: rand(0, vp.width), y: rand(0, vp.height) };
  const c1 = { x: from.x + rand(-200, 200), y: from.y + rand(-200, 200) };
  const c2 = { x: x + rand(-120, 120), y: y + rand(-120, 120) };
  const steps = randInt(12, 25);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = (1 - t) ** 3 * from.x + 3 * (1 - t) ** 2 * t * c1.x + 3 * (1 - t) * t ** 2 * c2.x + t ** 3 * x;
    const py = (1 - t) ** 3 * from.y + 3 * (1 - t) ** 2 * t * c1.y + 3 * (1 - t) * t ** 2 * c2.y + t ** 3 * y;
    await page.mouse.move(px + rand(-1.5, 1.5), py + rand(-1.5, 1.5));
    await sleep(rand(8, 30));
  }
}

/** Клик по элементу: подвести мышь по кривой, короткая пауза, клик. */
export async function humanClick(page: Page, selector: string | { x: number; y: number }, h: UplHumanize): Promise<void> {
  let x: number, y: number;
  if (typeof selector === "string") {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox();
    if (!box) throw new Error(`нет элемента для клика: ${selector}`);
    x = box.x + box.width * rand(0.3, 0.7);
    y = box.y + box.height * rand(0.3, 0.7);
  } else ({ x, y } = selector);
  await moveMouse(page, x, y);
  await sleep(rand(80, 250));
  await page.mouse.down();
  await sleep(rand(40, 120));
  await page.mouse.up();
  void h;
}

/** Прокрутить ленту несколько раз с паузами, иногда чуть вверх. */
export async function browseFeed(page: Page, h: UplHumanize): Promise<void> {
  const n = randInt(h.feedScrolls[0], h.feedScrolls[1]);
  for (let i = 0; i < n; i++) {
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    await moveMouse(page, rand(vp.width * 0.2, vp.width * 0.8), rand(vp.height * 0.3, vp.height * 0.8));
    const dy = rand(300, 900);
    const chunks = randInt(3, 7);
    for (let c = 0; c < chunks; c++) { await page.mouse.wheel(0, dy / chunks); await sleep(rand(30, 90)); }
    await pause(h.scrollPause);
    if (Math.random() < 0.25) { await page.mouse.wheel(0, -rand(100, 300)); await sleep(rand(400, 1200)); }
  }
}

/** Печать по символам с задержками из диапазона. */
export async function humanType(page: Page, selector: string, text: string, h: UplHumanize): Promise<void> {
  await humanClick(page, selector, h);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(h.typeMs[0], h.typeMs[1]));
  }
}
