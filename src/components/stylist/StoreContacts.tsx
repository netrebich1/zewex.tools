import type { StoreContacts as Contacts } from "@/lib/stylist/consts";

/**
 * Обычные магазины бренда: адрес, телефон, почта, часы. `ask` — вещь, о которой спрашиваем:
 * тогда почта открывается готовым письмом с артикулом (остаётся вписать размер и отправить).
 */
export function StoreContacts({ contacts, ask }: { contacts: unknown; ask?: { brand: string; name: string; sku: string; color: string; url: string } }) {
  const c = (contacts ?? {}) as Contacts;
  const branches = (c.branches ?? []).filter((b) => b && (b.name || b.address));
  const cs = c.customerService;
  if (!branches.length && !cs?.phone && !cs?.email) return null;
  const mail = (email: string) => {
    if (!ask) return `mailto:${email}`;
    const subject = `Availability request: ${ask.name}${ask.sku ? ` (ref. ${ask.sku})` : ""}`;
    const body = `Hello,\n\nCould you please tell me if this item is available in your store?\n\n${ask.brand} — ${ask.name}\n${ask.sku ? `Reference: ${ask.sku}\n` : ""}${ask.color ? `Colour: ${ask.color}\n` : ""}Size: \n${ask.url}\n\nThank you!`;
    return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  const tel = (p: string) => `tel:${p.replace(/[^+\d]/g, "")}`;
  return (
    <ul className="flex flex-col gap-2.5 text-[13px]">
      {(cs?.phone || cs?.email) && (
        <li>
          <b>Служба поддержки</b>
          <div className="flex flex-wrap gap-x-3">
            {cs.phone && <a href={tel(cs.phone)} className="underline">{cs.phone}</a>}
            {cs.email && <a href={mail(cs.email)} className="underline">{cs.email}</a>}
          </div>
          {cs.note && <div className="text-muted">{cs.note}</div>}
        </li>
      )}
      {branches.map((b, i) => (
        <li key={`${b.name}-${i}`}>
          <b>{b.name || b.address}</b>
          {b.name && b.address && <div className="text-ink-2">{b.address}</div>}
          <div className="flex flex-wrap gap-x-3">
            {b.phone && <a href={tel(b.phone)} className="underline">{b.phone}</a>}
            {b.email && <a href={mail(b.email)} className="underline">{ask ? `написать: ${b.email}` : b.email}</a>}
          </div>
          {b.hours && <div className="text-muted">{b.hours}</div>}
          {b.note && <div className="text-muted">{b.note}</div>}
        </li>
      ))}
    </ul>
  );
}

export const branchCount = (contacts: unknown) => ((contacts as Contacts | null)?.branches ?? []).length;
