// Prints the parts of DATABASE_URL from a .env file, one per line: user, password, host, port, database.
// Used by deploy/backup-db.sh so the shell never has to parse (and mis-decode) the URL itself.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const env = readFileSync(file, "utf8");
const m = env.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/m);
if (!m) {
  console.error(`DATABASE_URL not found in ${file}`);
  process.exit(1);
}
const raw = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
const u = new URL(raw);
process.stdout.write(
  [decodeURIComponent(u.username), decodeURIComponent(u.password), u.hostname, u.port || "3306", u.pathname.replace(/^\//, "")].join("\n") + "\n",
);
