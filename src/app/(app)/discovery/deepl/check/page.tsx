import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { DeeplNav } from "@/components/deepl/DeeplNav";
import { KeyChecker } from "@/components/deepl/KeyChecker";

export const dynamic = "force-dynamic";

/** Быстрая проверка ключей DeepL без сохранения: принят ли ключ и сколько свободных символов. */
export default async function DeeplCheckPage() {
  await requireUser();
  return (
    <>
      <DeeplNav />
      <PageHeader
        back={{ href: "/discovery/deepl/keys", label: "Ключи DeepL" }}
        title="Проверка ключей DeepL"
        subtitle="Вставьте ключи — портал спросит DeepL про каждый: принимает ли он ключ и сколько символов осталось в этом месяце. Ничего не сохраняется; рабочие ключи можно сразу добавить в инструмент."
      />
      <KeyChecker />
    </>
  );
}
