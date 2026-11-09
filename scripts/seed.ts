/**
 * Seed: owner user, the uppal-nq1 brand and the hermes + inqi API clients.
 * Safe to re-run: existing rows are left alone. API keys are printed ONCE, when created.
 *   pnpm db:seed            # create what's missing
 *   pnpm db:seed --rotate   # also issue new keys for hermes and inqi (old keys stop working)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiClients, brandMembers, users } from "@/lib/db/schema";
import { systemActor, type Scope } from "@/lib/auth/guard";
import { MockInstagramClient } from "@/lib/instagram/mock";
import { logger } from "@/lib/logger";
import { MemoryQueue, PassthroughMediaStore, withActor } from "@/lib/services/context";
import { createBrand, findBrand } from "@/lib/services/brands";
import { insertApiClient, rotateApiClientKey } from "@/lib/services/api-clients";

const ALL_SCOPES: Scope[] = ["posts:read", "posts:write", "posts:approve", "posts:publish", "brands:read", "brands:write", "insights:read"];

async function main() {
  const rotate = process.argv.includes("--rotate");
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) throw new Error("Set OWNER_EMAIL in .env.local (the first admin login).");

  const db = getDb();
  const ctx = withActor(
    { db, ig: new MockInstagramClient(), igMode: "mock", queue: new MemoryQueue(), media: new PassthroughMediaStore(), now: () => new Date(), log: logger },
    systemActor("seed"),
  );

  // Owner
  let [owner] = await db.select().from(users).where(eq(users.email, ownerEmail));
  if (!owner) {
    [owner] = await db.insert(users).values({ id: randomUUID(), name: process.env.OWNER_NAME ?? "Owner", email: ownerEmail, role: "owner", emailVerified: true }).returning();
    console.log(`✓ owner user ${ownerEmail} created (sign-in arrives in phase 2)`);
  } else console.log(`• owner user ${ownerEmail} exists`);

  // Brand
  let brand = await findBrand(db, "uppal-nq1");
  if (!brand) {
    await createBrand(ctx, {
      name: "Uppal NQ1",
      slug: "uppal-nq1",
      instagramHandle: "@uppal.nq1",
      timezone: "Asia/Karachi",
      color: "#8b7bff",
      requiresApproval: true,
      postingSlots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: "17:00" })),
      guidelines: {
        focus: "NQ1 (Nasdaq-100 E-mini futures): real trade snapshots and the daily trading routine.",
        voice: "Calm, honest and process-focused. Say what happened and what was learned. No hype.",
        pillars: ["Trade snapshots", "Daily routine", "Risk management", "Lessons & mindset"],
        visualStyle: "Faceless: no people in images. Flat, non-cinematic illustration. Message-led: one clear line of text that is easy to read on a phone.",
        dos: ["Show real trades, wins and losses", "Keep on-image text short and readable", "Mention risk plainly"],
        donts: ["No people or faces in images", "No hype", "No guaranteed-profit or income claims", "No cinematic or photoreal renders"],
        hashtagSets: {
          core: ["#NQ1", "#NasdaqFutures", "#FuturesTrading", "#DayTrading", "#TradingJournal"],
          routine: ["#TraderRoutine", "#TradingDiscipline", "#ProcessOverOutcome"],
        },
        defaultCta: "Follow for the daily NQ1 recap.",
      },
    });
    brand = (await findBrand(db, "uppal-nq1"))!;
    console.log("✓ brand uppal-nq1 (@uppal.nq1, Asia/Karachi, daily 17:00, approval required) created");
  } else console.log("• brand uppal-nq1 exists");
  await db.insert(brandMembers).values({ brandId: brand.id, userId: owner.id }).onConflictDoNothing();

  // API clients
  const specs = [
    { name: "hermes", source: "hermes" as const, scopes: ALL_SCOPES, brandIds: "all" as const },
    { name: "inqi", source: "inqi" as const, scopes: ["posts:read", "posts:approve", "brands:read", "insights:read"] as Scope[], brandIds: [brand.id] },
  ];
  const keys: [string, string][] = [];
  for (const spec of specs) {
    const [existing] = await db.select().from(apiClients).where(eq(apiClients.name, spec.name));
    if (!existing) keys.push([spec.name, (await insertApiClient(db, spec)).apiKey]);
    else if (rotate) keys.push([spec.name, (await rotateApiClientKey(db, existing.id)).apiKey]);
    else console.log(`• api client ${spec.name} exists (run with --rotate to issue a new key)`);
  }

  if (keys.length) {
    console.log("\n================  API KEYS: shown once, store them now  ================");
    for (const [name, key] of keys) console.log(`${name.padEnd(8)} ${key}`);
    console.log("=========================================================================\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
