import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Empty, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { ColorDot } from "@/components/stylist/ItemCard";
import { BASE_PATH, CATEGORY_LABELS, COLOR_LABELS } from "@/lib/stylist/consts";
import { BRANDS } from "@/lib/stylist/dna";
import { canSee } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistBrands() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  // Сколько вещей каталога уже помечено «в духе» каждого бренда.
  const counts = Object.fromEntries(await Promise.all(BRANDS.map(async (b) => [b.id, await prisma.stItem.count({ where: { inStock: true, spirit: { contains: `|${b.id}|` } } })] as const)));
  const tiers = [
    { id: "heavy", label: "Тяжёлый люкс" },
    { id: "quiet", label: "Тихий люкс" },
  ];
  return (
    <>
      <StNav />
      <PageHeader
        title="ДНК брендов"
        subtitle="Справочник люксовых домов: суть стиля, узнаваемые коды и знаковые вещи. По нему вещи масс-маркета получают метку «в духе бренда»: сначала по словам в названии (пунктирная метка — предположение), а точнее — когда фото посмотрит ИИ (метка с процентом)."
      />
      {tiers.map((t) => (
        <div key={t.id} className="mb-6">
          <h2 className="h2 mb-3">{t.label}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {BRANDS.filter((b) => (b.tier === "quiet" ? "quiet" : "heavy") === t.id).map((b) => (
              <Card key={b.id} title={b.name} description={b.director} actions={counts[b.id] ? <Link href={`${BASE_PATH}?spirit=${b.id}&gender=any`} className="btn-ghost btn-sm">Вещи в духе: {counts[b.id]}</Link> : undefined}>
                <p className="text-[14px] leading-relaxed">{b.dna}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {b.codes.map((c) => <span key={c} className="rounded bg-ink/5 px-2 py-0.5 text-[12px]">{c}</span>)}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  Палитра: {b.palette.map((c) => <span key={c} className="flex items-center gap-1"><ColorDot color={c} /> {COLOR_LABELS[c] ?? c}</span>)}
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-[13px] font-medium">Знаковые вещи: {b.icons.length}</summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {b.icons.map((i) => (
                      <li key={i.name} className="text-[13px] leading-snug">
                        <b>{i.name}</b> <span className="text-muted">· {CATEGORY_LABELS[i.category] ?? i.category}</span>
                        <div className="text-ink-2">{i.look}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
