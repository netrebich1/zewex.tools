/** Проверка дат регулярных операций: npx tsx scripts/finance/recurring-test.ts (базу не трогает). */
process.env.DATABASE_URL ??= "mysql://u:p@localhost:3306/x"; // модуль тянет prisma, но соединение не открывается
let fails = 0;
(async () => {
  const { nextMonthly } = await import("../../src/lib/finance/recurring");
  const check = (from: string, day: number, want: string) => {
    const got = nextMonthly(from, day);
    if (got !== want) fails++;
    console.log(`${got === want ? "OK  " : "FAIL"} после ${from}, день ${day}: ${got}${got === want ? "" : ` (ждали ${want})`}`);
  };
  check("2026-11-25", 25, "2026-12-25");
  check("2026-11-25", 28, "2026-11-28");
  check("2026-11-25", 5, "2026-12-05");
  check("2026-12-25", 25, "2027-01-25");
  check("2027-01-31", 31, "2027-02-28");
  check("2027-02-28", 31, "2027-03-31");
  check("2028-01-31", 31, "2028-02-29");
  check("2026-11-30", 31, "2026-12-31");
  process.exit(fails ? 1 : 0);
})();
