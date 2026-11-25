import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { batchesData } from "@/lib/copy/batchQueries";
import { fmtDate, fmtMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "neutral" | "brand" }> = {
  running: { label: "Собирается", tone: "brand" }, paused: { label: "Пауза", tone: "warn" }, done: { label: "Собрана", tone: "ok" }, planned: { label: "Запланирована", tone: "neutral" },
};

/** Партии Article Copy: массовые запуски «N статей по нишам и частотности на выбранные сайты». */
export default async function CopyBatchesPage() {
  const me = await requireUser();
  const rows = await batchesData(me);
  return (
    <>
      <PageHeader
        title="Партии"
        subtitle="Основной способ запуска: задаёте, сколько статей каких ниш и частотности собрать и на какие сайты, — система подбирает темы и кадры, пишет и публикует."
        back={{ href: "/pinterest/copy", label: "Запас" }}
        actions={<Link href="/pinterest/copy/batches/new" className="btn-brand">Новая партия</Link>}
      />
      <Card>
        {rows.length === 0 ? (
          <Empty title="Партий ещё не было" hint="Нажмите «Новая партия», отметьте сайты и впишите, сколько статей собрать." action={<Link href="/pinterest/copy/batches/new" className="btn-brand btn-sm">Новая партия</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Партия</th><th>Состояние</th><th className="text-right">Запланировано</th><th className="text-right">Собрано</th><th className="text-right">Не вышло</th><th className="text-right">Опубликовано</th><th className="text-right">Ждут проверки</th><th className="text-right">Расход</th><th>Создана</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const s = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                  return (
                    <tr key={r.id}>
                      <td className="min-w-[200px]"><Link href={`/pinterest/copy/batches/${r.id}`} className="font-medium hover:underline">{r.name}</Link><div className="help">{r.author} · сайтов {(r.siteIds as string[]).length}{r.word ? ` · «${r.word}»` : ""} · фото {r.photos}{r.review ? " · с проверкой" : ""}</div></td>
                      <td><Badge tone={s.tone}>{s.label}</Badge></td>
                      <td className="text-right tabular-nums">{r.planned}</td>
                      <td className="text-right tabular-nums">{r.built}</td>
                      <td className="text-right tabular-nums text-muted">{r.failed}</td>
                      <td className="text-right tabular-nums text-ok">{r.published}</td>
                      <td className="text-right tabular-nums">{r.waiting || ""}</td>
                      <td className="text-right tabular-nums text-muted">{fmtMoney(r.cost)}</td>
                      <td className="whitespace-nowrap text-muted">{fmtDate(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
