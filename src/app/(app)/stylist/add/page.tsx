import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { StNav } from "@/components/stylist/StNav";
import { addItemByLink } from "@/actions/stylist";
import { BASE_PATH, CATEGORIES, COLORS, GENDERS, GEO_LABELS, SEGMENT_LABELS } from "@/lib/stylist/consts";
import { canSee } from "@/lib/stylist/queries";

export const dynamic = "force-dynamic";

export default async function StylistAdd() {
  const me = await requireUser();
  if (!(await canSee(me))) return <Empty title="Нет доступа" hint="«Стилист» открыт команде Zewex." />;
  const stores = await prisma.stStore.findMany({ orderBy: [{ geo: "asc" }, { name: "asc" }], select: { id: true, name: true, geo: true, segment: true, currency: true } });
  return (
    <>
      <StNav />
      <PageHeader
        title="Добавить вещь"
        subtitle="Для магазинов, которые не собираются автоматически: вставьте ссылку на страницу вещи — название, фото и цену возьмём со страницы. Если магазин страницу не отдаёт, впишите их руками."
      />
      <Card>
        <ActionForm action={addItemByLink}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Магазин" hint="Нет нужного — добавьте его на вкладке «Магазины».">
              <select name="store" className="input" required defaultValue="">
                <option value="" disabled>выберите магазин</option>
                {Object.entries(GEO_LABELS).map(([geo, label]) => (
                  <optgroup key={geo} label={label}>
                    {stores.filter((s) => s.geo === geo).map((s) => <option key={s.id} value={s.id}>{s.name} · {SEGMENT_LABELS[s.segment] ?? s.segment} · {s.currency}</option>)}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Ссылка на страницу вещи">
              <input name="url" type="url" required placeholder="https://…" className="input" />
            </Field>
          </div>
          <p className="help">Поля ниже можно не заполнять — попробуем прочитать со страницы. Заполненное вами важнее найденного.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Название"><input name="name" className="input" maxLength={300} /></Field>
            <Field label="Цена (в валюте магазина)"><input name="price" inputMode="decimal" className="input" /></Field>
            <Field label="Ссылка на фото" hint="Правой кнопкой по картинке → «Копировать адрес изображения»."><input name="imageUrl" type="url" className="input" /></Field>
            <Field label="Тип вещи">
              <select name="category" className="input" defaultValue="">
                <option value="">определить по названию</option>
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Цвет">
              <select name="color" className="input" defaultValue="">
                <option value="">определить по названию</option>
                {COLORS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Для кого">
              <select name="gender" className="input" defaultValue="woman">
                {GENDERS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </Field>
            <Field label="Название цвета у магазина"><input name="colorName" className="input" maxLength={80} /></Field>
            <Field label="Размеры в наличии" hint="Через пробел или запятую: S M L"><input name="sizes" className="input" /></Field>
          </div>
          <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" name="toLook" /> сразу положить в собираемый образ</label>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingText="Читаю страницу…">Добавить</SubmitButton>
            <Link href={BASE_PATH} className="text-[13px] text-muted underline">в каталог</Link>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
