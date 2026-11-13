/**
 * Local Postgres for development without Neon: PGlite (real Postgres in-process, stored in ./.pglite)
 * served over the Postgres wire protocol, with migrations applied on start.
 *   pnpm dev:db        # leave running
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres   (in .env.local)
 *   pnpm db:seed && pnpm dev
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const PORT = Number(process.env.DEV_DB_PORT ?? 54329);

async function main() {
  const db = new PGlite("./.pglite");
  await migrate(drizzle({ client: db }), { migrationsFolder: "drizzle" });
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  console.log(`Local Postgres ready: postgres://postgres@127.0.0.1:${PORT}/postgres  (data in ./.pglite, Ctrl+C to stop)`);
  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("dev-db failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
