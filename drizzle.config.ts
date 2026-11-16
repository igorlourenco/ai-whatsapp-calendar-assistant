import { defineConfig } from "drizzle-kit";

// Migrations are bundled into the worker and applied by the Scheduler
// Durable Object on startup (drizzle/migrations.js).
export default defineConfig({
  schema: "./src/worker/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
