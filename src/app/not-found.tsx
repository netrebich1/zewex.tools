import Link from "next/link";
export default function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-3 px-4">
      <p className="text-[40px] font-bold">404</p>
      <p className="help">Такой страницы нет.</p>
      <Link href="/" className="btn-primary">На главную</Link>
    </div>
  );
}
