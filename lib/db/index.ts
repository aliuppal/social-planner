import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export { schema };

/** Any Drizzle Postgres database with our schema (Neon in the app, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

let cached: Db | undefined;

/**
 * Neon serverless Pool over WebSockets: needed for interactive transactions and
 * SELECT … FOR UPDATE SKIP LOCKED in the publisher (the HTTP driver can't do those).
 */
export function getDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
  if (typeof WebSocket === "undefined") {
    // Node < 22 has no global WebSocket
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    neonConfig.webSocketConstructor = require("ws");
  }
  const pool = new Pool({ connectionString: url });
  cached = drizzle({ client: pool, schema }) as unknown as Db;
  return cached;
}
