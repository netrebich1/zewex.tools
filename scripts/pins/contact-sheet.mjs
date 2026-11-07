// Контактный лист из JPEG: node scripts/pins/contact-sheet.mjs <dir> <out.jpg> [cols=6] [cellW=300] [filter]
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readdir, writeFile } from "fs/promises";
import { join } from "path";

const [dir, out, colsArg = "6", cellArg = "300", filter = "", startArg = "0", limitArg = "1000"] = process.argv.slice(2);
const cols = Number(colsArg), cw = Number(cellArg), ch = Math.round(cw * 1.5), label = 28;
const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg") && f.includes(filter)).sort().slice(Number(startArg), Number(startArg) + Number(limitArg));
const rows = Math.ceil(files.length / cols);
const cv = createCanvas(cols * cw, rows * (ch + label));
const ctx = cv.getContext("2d");
ctx.fillStyle = "#222"; ctx.fillRect(0, 0, cv.width, cv.height);
for (let i = 0; i < files.length; i++) {
  const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + label);
  try { ctx.drawImage(await loadImage(join(dir, files[i])), x, y, cw, ch); } catch {}
  ctx.fillStyle = "#fff"; ctx.font = "13px sans-serif";
  ctx.fillText(`${Number(startArg) + i + 1}. ${files[i].replace(/\.jpg$/, "").replace(/^cat_/, "").slice(0, 44)}`, x + 4, y + ch + 18);
}
await writeFile(out, cv.toBuffer("image/jpeg", 82));
console.log(out, files.length);
