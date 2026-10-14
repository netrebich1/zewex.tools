import { ArticlesNav } from "@/components/articles/ArticlesNav";

export default function ArticlesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <ArticlesNav />
      {children}
    </div>
  );
}
