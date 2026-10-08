import { LogoFull } from "@/components/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-8"><LogoFull className="h-9 w-auto" /></div>
      <div className="card w-full max-w-md p-6 sm:p-8">{children}</div>
      <p className="help mt-6">Внутренний портал инструментов Zewex</p>
    </div>
  );
}
