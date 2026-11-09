// Симуляция расписания (без базы): npx tsx scripts/pins/sched-test.ts
import { scheduleItems, type ScheduleItem } from "@/lib/pins/schedule/plan";
const mk = (pages: number, per: number, tag = "p") => { const m = new Map<string, ScheduleItem[]>(); for (let p = 0; p < pages; p++) m.set(`${tag}${p}`, Array.from({ length: per }, (_, i) => ({ id: `${tag}${p}-${i}`, scheduledAt: null, scheduleFixed: false }))); return m; };
const base = { existingLoad: new Map<string, number>(), startFrom: "2026-10-13", now: new Date("2026-10-12T10:00:00Z"), seed: 7, tz: "Europe/Kyiv" };
const show = (name: string, r: ReturnType<typeof scheduleItems>) => {
  const days = [...r.newPerDay.entries()].sort();
  console.log(name, "| placed", r.assignments.size, "| unscheduled", r.unscheduled.length, "| days", days.length, "|", days.slice(0, 7).map(([d, n]) => `${d.slice(5)}:${n}(${r.perDay.get(d)})`).join(" "), "…", days.slice(-1).map(([d, n]) => `${d.slice(5)}:${n}`).join(" "), "| report:", r.limitReport ? `moved ${r.limitReport.moved} from ${r.limitReport.days.length} days` : "none");
};
const items = mk(100, 5);
show("fixed 100, empty site      ", scheduleItems({ ...base, itemsByPage: items, pinsPerDay: 100, mode: "fixed" }));
show("fixed 30, empty site       ", scheduleItems({ ...base, itemsByPage: items, pinsPerDay: 30, mode: "fixed" }));
const load40 = new Map<string, number>(); for (let d = 13; d <= 22; d++) load40.set(`2026-10-${d}`, 40);
show("fixed 50 + 40 already      ", scheduleItems({ ...base, existingLoad: load40, itemsByPage: items, pinsPerDay: 50, mode: "fixed" }));
const load70 = new Map<string, number>(); for (let d = 13; d <= 17; d++) load70.set(`2026-10-${d}`, 70);
show("fixed 50 + 70 already 5d   ", scheduleItems({ ...base, existingLoad: load70, itemsByPage: items, pinsPerDay: 50, mode: "fixed" }));
show("dates 10d + 70 already 5d  ", scheduleItems({ ...base, existingLoad: load70, itemsByPage: items, pinsPerDay: 100, mode: "dates", lastDate: "2026-10-22" }));
const full = new Map<string, number>(); for (let d = 13; d <= 15; d++) full.set(`2026-10-${d}`, 100);
show("fixed 50, 3 days full, auto", scheduleItems({ ...base, startFrom: "next_free_day", existingLoad: full, itemsByPage: items, pinsPerDay: 50, mode: "fixed" }));
