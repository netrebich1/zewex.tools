/** Скриншот шага инструкции (хранилище pins/guide). По клику открывается в полном размере; подпись под картинкой. */
export function GuideShot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="space-y-1">
      <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-line bg-ink/5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" className="w-full" />
      </a>
      {caption && <figcaption className="help">{caption}</figcaption>}
    </figure>
  );
}
