import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { categories } from "../src/worker/db/schema";

const db = drizzle(neon(process.env.DATABASE_URL!));

const defaults = [
  { slug: "faculdade", name: "Faculdade", emoji: "🎓", color: "#6366f1" },
  { slug: "trabalho", name: "Trabalho", emoji: "💼", color: "#0ea5e9" },
  { slug: "pessoal", name: "Pessoal", emoji: "🏠", color: "#22c55e" },
];

await db.insert(categories).values(defaults).onConflictDoNothing();
console.log("Seeded categories:", defaults.map((c) => `${c.emoji} ${c.name}`).join(", "));
