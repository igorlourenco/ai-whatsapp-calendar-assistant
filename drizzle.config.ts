import { defineConfig } from "drizzle-kit";

process.loadEnvFile?.(".dev.vars");

export default defineConfig({
  schema: "./src/worker/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
