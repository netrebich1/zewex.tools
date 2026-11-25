import { UploaderNav } from "@/components/uploader/UploaderNav";

export default function UploaderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <UploaderNav />
      {children}
    </div>
  );
}
