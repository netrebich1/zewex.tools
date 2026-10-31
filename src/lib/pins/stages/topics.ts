// Порт legacy src/lib/pageTopics.ts: справочник тем страниц (id для ИИ-классификации и подписи).
export interface PageTopic { id: string; label: string }

/** Shared page/pin topics (used for pin-set page type and example previews). */
export const PAGE_TOPICS: PageTopic[] = [
  { id: "nails", label: "Ногти" },
  { id: "hair", label: "Волосы" },
  { id: "haircuts", label: "Стрижки" },
  { id: "outfit", label: "Одежда / Аутфиты" },
  { id: "makeup", label: "Макияж" },
  { id: "skincare", label: "Уход" },
  { id: "home", label: "Дом / Декор" },
  { id: "food", label: "Еда" },
  { id: "other", label: "Другое" },
];

export const TOPIC_LABEL: Record<string, string> = Object.fromEntries(
  PAGE_TOPICS.map((t) => [t.id, t.label]),
);
