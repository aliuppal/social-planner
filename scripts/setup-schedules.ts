/**
 * Creates (or updates) the recurring QStash jobs. Safe to re-run: fixed schedule ids.
 *   QSTASH_TOKEN=... APP_URL=https://social-planner-nine.vercel.app pnpm qstash:schedules
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { Client } from "@upstash/qstash";

const JOBS = [
  { id: "planner-sweep", job: "sweep", cron: "*/5 * * * *", why: "publish anything due that its exact-time trigger missed" },
  { id: "planner-sync", job: "sync", cron: "*/30 * * * *", why: "import posts made in the Instagram app" },
  { id: "planner-tokens", job: "tokens", cron: "0 3 * * *", why: "refresh Instagram tokens (03:00 UTC daily)" },
];

async function main() {
  const token = process.env.QSTASH_TOKEN;
  const appUrl = process.env.APP_URL;
  if (!token || !appUrl?.startsWith("https://")) throw new Error("Set QSTASH_TOKEN and a public https APP_URL.");
  const client = new Client({ token, baseUrl: process.env.QSTASH_URL });
  for (const j of JOBS) {
    await client.schedules.create({ scheduleId: j.id, destination: `${appUrl.replace(/\/$/, "")}/api/jobs/${j.job}`, cron: j.cron, retries: 1 });
    console.log(`✓ ${j.id.padEnd(15)} ${j.cron.padEnd(13)} ${j.why}`);
  }
}

main().catch((err) => {
  console.error("setup-schedules failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
