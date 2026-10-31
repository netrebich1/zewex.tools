import { BlogNav } from "@/components/blog/BlogNav";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { blogPostWhere } from "@/lib/blog/access";

export default async function BlogLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentUser();
  const review = me ? await prisma.blogPost.count({ where: { ...(await blogPostWhere(me)), status: { in: ["REVIEW_PENDING", "NEEDS_REWORK"] } } }).catch(() => 0) : 0;
  return (
    <div>
      <BlogNav counts={{ review }} />
      {children}
    </div>
  );
}
