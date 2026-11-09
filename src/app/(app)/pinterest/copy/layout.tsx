import { CopyNav } from "@/components/copy/CopyNav";

export default function CopyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <CopyNav />
      {children}
    </div>
  );
}
