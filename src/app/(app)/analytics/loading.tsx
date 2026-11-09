/** Скелет на время загрузки данных кабинета. */
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="mb-6 h-8 w-64 rounded-lg bg-ink/10" />
      <div className="mb-5 h-10 w-full max-w-xl rounded-xl bg-ink/5" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 mb-4">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-24 rounded-2xl bg-ink/5" />)}
      </div>
      <div className="h-80 rounded-2xl bg-ink/5 mb-4" />
      <div className="h-64 rounded-2xl bg-ink/5" />
    </div>
  );
}
