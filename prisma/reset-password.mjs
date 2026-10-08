// Emergency password reset for a locked-out user (run on the server, in the app folder):
//   sudo -u zewex_tools_usr -H node prisma/reset-password.mjs user@example.com 'new-password'
// Also restores admin role and access, and drops the user's sessions.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error("Usage: node prisma/reset-password.mjs <email> <password (8+ chars)>");
  process.exit(1);
}
const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}
await prisma.user.update({
  where: { id: user.id },
  data: { passwordHash: await bcrypt.hash(password, 11), role: "ADMIN", isActive: true, inviteToken: null, inviteExpires: null },
});
await prisma.session.deleteMany({ where: { userId: user.id } });
console.log(`Password reset for ${user.email}; role=ADMIN, sessions cleared.`);
await prisma.$disconnect();
