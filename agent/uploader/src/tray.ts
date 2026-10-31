/**
 * Окошко состояния: маленький локальный веб-сервер (http://127.0.0.1:47831) с состоянием и журналом —
 * открывается из консоли ссылкой или из ярлыка. Иконка в трее (следующий этап) будет открывать этот же адрес.
 */
import { createServer } from "node:http";
import { log } from "./log";

export function startTray(info: { portal: string; version: string }): void {
  const port = Number(process.env.ZEWEX_UPLOADER_PORT || 47831);
  const html = () => `<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Zewex Uploader</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}pre{background:#fff;border:1px solid #ddd;padding:12px;max-height:60vh;overflow:auto;font-size:12px}.s{font-size:18px;font-weight:600}a{color:#c0392b}</style>
<h1>Zewex Uploader <small style="font-weight:400;color:#888">${info.version}</small></h1>
<p class="s">Состояние: ${escape(log.state())}</p>
<p><a href="${info.portal}/pinterest/uploader" target="_blank">Открыть портал</a> · страница обновляется каждые 5 с</p>
<pre>${log.lines().slice(-80).map(escape).join("\n")}</pre></html>`;
  const srv = createServer((req, res) => {
    if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ state: log.state(), lines: log.lines().slice(-50) })); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html());
  });
  srv.on("error", (e) => log.warn(`окно состояния не открылось на порту ${port}`, e));
  srv.listen(port, "127.0.0.1", () => log.info(`окно состояния: http://127.0.0.1:${port}/`));
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
