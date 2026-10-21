/**
 * JSON-LD инфо-статьи: Article (+ image[]), FAQPage (если есть FAQ), HowTo (если есть блок steps с нумерованным списком).
 * Адрес статьи ещё неизвестен до публикации — поле url не пишем; WordPress/Yoast добавят своё.
 */
import { firstWords } from "./text";

export type SchemaInput = {
  h1: string;
  description: string;
  images: string[];
  faq: Array<{ question: string; answer: string }>;
  sections: Array<{ kind: string; heading: string; html: string }>;
  datePublished?: string;
};

const text = (html: string) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Шаги из первого блока steps: элементы <ol><li>; имя шага — текст до первой точки (или метка <strong>). */
export function extractSteps(sections: SchemaInput["sections"]): Array<{ name: string; text: string }> {
  const steps = sections.find((s) => s.kind === "steps" && /<ol\b/i.test(s.html));
  if (!steps) return [];
  const ol = steps.html.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i)?.[1] ?? "";
  const items = [...ol.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]);
  return items.map((li) => {
    const label = li.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1];
    const full = text(li);
    const name = text(label ?? "") || full.split(/[.:!?]/)[0].slice(0, 80);
    return { name: name.replace(/[:.]\s*$/, "").slice(0, 100), text: full.slice(0, 600) };
  }).filter((s) => s.name && s.text).slice(0, 25);
}

export function buildJsonLd(input: SchemaInput): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [];
  graph.push({
    "@type": "Article",
    headline: input.h1.slice(0, 110),
    description: input.description.slice(0, 300),
    ...(input.images.length ? { image: input.images } : {}),
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
  });
  if (input.faq.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: input.faq.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: text(f.answer) } })),
    });
  }
  const steps = extractSteps(input.sections);
  if (steps.length >= 2) {
    graph.push({
      "@type": "HowTo",
      name: input.h1.slice(0, 110),
      description: firstWords(input.description, 40),
      ...(input.images.length ? { image: input.images[0] } : {}),
      step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, name: s.name, text: s.text })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}
