import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { writeFileAtomic } from "@/lib/pins/storage";

export const dynamic = "force-dynamic";

/**
 * POST /api/pins/guide/shot?name=<файл> — принять скриншот для вкладки «Инструкция» (только администратор).
 * Тело — JPEG. Файл кладётся в хранилище pins/guide/<name>.jpg и отдаётся как /files/pins/guide/<name>.jpg.
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me || me.role !== "ADMIN") return NextResponse.json({ error: "Только администратор" }, { status: 403 });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!/^[a-z0-9-]{3,60}$/.test(name)) return NextResponse.json({ error: "Некорректное имя" }, { status: 400 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 1000 || buf.length > 4_000_000) return NextResponse.json({ error: `Размер ${buf.length} вне допустимого` }, { status: 400 });
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return NextResponse.json({ error: "Ожидается JPEG" }, { status: 400 });
  await writeFileAtomic(`pins/guide/${name}.jpg`, buf);
  return NextResponse.json({ ok: true, bytes: buf.length });
}
