"use client";

/** «Печать / PDF»: в окне печати браузера можно выбрать «Сохранить как PDF». */
export function PrintButton({ label = "Печать / сохранить PDF" }: { label?: string }) {
  return <button type="button" className="btn-primary" onClick={() => window.print()}>{label}</button>;
}

/** Нужный клиенту размер: меняется выбором, сохраняется сразу. */
export function AutoSubmitSelect({ name, defaultValue, options, className = "input !w-auto !py-1 text-[13px]" }: { name: string; defaultValue: string; options: Array<{ value: string; label: string }>; className?: string }) {
  return (
    <select name={name} defaultValue={defaultValue} className={className} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
