import { PinsNav } from "@/components/pins/PinsNav";

export default function PinsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PinsNav />
      {children}
    </div>
  );
}
