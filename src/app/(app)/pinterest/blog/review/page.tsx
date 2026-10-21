import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Alert, Badge, Card, Empty, Field, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { approvePostAction, reworkPostAction } from "@/actions/blog";
import { canAccessBlogPost } from "@/lib/blog/access";
import { reviewQueue } from "@/lib/blog/queries";
import { StatusBadge } from "@/components/blog/StatusBadge";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Очередь проверки перед публикацией: список слева, предпросмотр и решения справа. Замена фото и правка текста — в карточке статьи. */
export default async function BlogReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const q = await searchParams;
  const items = await reviewQueue(me);
  const wanted = sp(q, "post");
  const currentId = wanted && items.some((i) => i.id === wanted) ? wanted : wanted && (await canAccessBlogPost(me, wanted)) ? wanted : items[0]?.id ?? null;
  const post = currentId ? await prisma.blogPost.findUnique({ where: { id: currentId }, include: { site: { select: { name: true } }, photos: { where: { excluded: false }, orderBy: { position: "asc" } } } }) : null;
  const next = post ? items.find((i) => i.id !== post.id) : null;

  return (
    <>
      <PageHeader title="Проверка перед публикацией" subtitle="Статьи, собранные полностью: прочитайте, замените слабые фото или поправьте текст в карточке, затем одобрите или верните в доработку." />
      {items.length === 0 && !post ? <Empty title="Проверять нечего" hint="Статьи появятся здесь после сборки, если у сайта включена проверка перед публикацией." /> : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card className="lg:sticky lg:top-4 self-start max-h-[80vh] overflow-auto">
            <h3 className="h2 mb-2">Очередь · {items.length}</h3>
            <ul className="space-y-1">{items.map((i) => (
              <li key={i.id}><Link href={`/pinterest/blog/review?post=${i.id}`} className={`block rounded-lg px-3 py-2 text-[13px] ${i.id === post?.id ? "bg-ink text-bg" : "hover:bg-ink/5"}`}><div className="truncate font-medium">{i.keyword}</div><div className={`truncate text-[11.5px] ${i.id === post?.id ? "text-bg/70" : "text-muted"}`}>{i.siteName} · {i.wordCount} слов · {i.photos} фото{i.status === "NEEDS_REWORK" ? " · в доработку" : ""}</div></Link></li>
            ))}</ul>
          </Card>
          {post ? (
            <div className="space-y-4">
              <Card>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={post.status} />
                  <Link href={`/pinterest/blog/posts/${post.id}`} className="font-semibold hover:underline">{post.keyword}</Link>
                  <span className="help">{post.site.name} · {post.wordCount} слов · {post.photos.length} фото · собрана {fmtDate(post.updatedAt)}</span>
                  <Link href={`/pinterest/blog/posts/${post.id}?tab=photos`} className="btn-ghost btn-sm ml-auto">Заменить фото</Link>
                  <Link href={`/pinterest/blog/posts/${post.id}?tab=text`} className="btn-ghost btn-sm">Править текст</Link>
                </div>
                {post.note && <p className="help mt-2">{post.note}</p>}
                {post.error && <div className="mt-2"><Alert tone="danger">{post.error}</Alert></div>}
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <ActionForm action={approvePostAction} hidden={{ id: post.id }} className="flex flex-wrap items-end gap-2">
                    <Field label="Заметка (необязательно)"><input name="note" className="input py-2" placeholder="что поправили" /></Field>
                    <SubmitButton className="btn-brand" pendingText="…">Одобрить и опубликовать</SubmitButton>
                  </ActionForm>
                  <ActionForm action={reworkPostAction} hidden={{ id: post.id }} className="flex flex-wrap items-end gap-2">
                    <Field label="В доработку"><select name="what" className="input py-2"><option value="write">переписать текст</option><option value="outline">новый план, фото и текст</option></select></Field>
                    <Field label="Замечание"><input name="note" className="input py-2" placeholder="что не так" /></Field>
                    <SubmitButton className="btn-ghost" pendingText="…">Отправить</SubmitButton>
                  </ActionForm>
                  {next && <Link href={`/pinterest/blog/review?post=${next.id}`} className="btn-ghost ml-auto">Следующая →</Link>}
                </div>
              </Card>
              <Card title={post.h1 || post.keyword} description={<span><Badge>title</Badge> {post.metaTitle} · <Badge>slug</Badge> /{post.slug} · <Badge>description</Badge> {post.metaDescription}</span>}>
                {post.html ? <article className="prose max-w-none text-[15px] leading-relaxed [&_h2]:mt-7 [&_h2]:text-[1.35em] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_img]:my-3 [&_img]:max-w-[480px] [&_img]:rounded-xl [&_table]:my-4 [&_script]:hidden" dangerouslySetInnerHTML={{ __html: post.html }} /> : <p className="help">HTML ещё не собран.</p>}
              </Card>
            </div>
          ) : <Card><p className="help">Выберите статью слева.</p></Card>}
        </div>
      )}
    </>
  );
}
