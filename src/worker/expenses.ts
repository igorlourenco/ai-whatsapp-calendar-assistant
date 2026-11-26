import { and, asc, desc, eq, gte, lte } from "drizzle-orm";

import { matchTitles, normText, slugify } from "./calendar/store";
import type { Db } from "./db/client";
import { expenseCategories, expenses, type Expense, type ExpenseCategory, type ExpenseRef } from "./db/schema";
import { addDays, diffDays, shortDatePt, weekdayOf } from "./time";

/*
 * Spending log ("gastei 45 no ifood"). Lives in the Durable Object's SQLite
 * next to tasks. Amounts are integer cents (BRL). Every reply is built from
 * rows re-read here; the model only says what was spent, never the totals.
 */

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const STOP = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "no", "na", "nos", "nas", "com", "e", "pra", "para", "gasto", "gastei"]);

/** Warn when a monthly limit reaches these shares. */
export const BUDGET_WARN = 0.8;

/* -------------------------------- money --------------------------------- */

/** 123450 → "R$ 1.234,50" */
export function brl(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${int},${String(abs % 100).padStart(2, "0")}`;
}

/** 45.5 (reais, from the model) → 4550. Not finite / ≤ 0 → null. */
export function toCents(reais: number | null | undefined): number | null {
  if (reais == null || !Number.isFinite(reais) || reais <= 0) return null;
  return Math.round(reais * 100);
}

/* -------------------------------- dates --------------------------------- */

/** "2026-11-26" → ["2026-11-01", "2026-11-30"] */
export function monthRange(ymd: string): [string, string] {
  const [y, m] = ymd.split("-").map(Number);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return [first, addDays(next, -1)];
}

/** Monday..Sunday week containing ymd. */
export function weekRange(ymd: string): [string, string] {
  const monday = addDays(ymd, -((weekdayOf(ymd) + 6) % 7));
  return [monday, addDays(monday, 6)];
}

export const monthName = (ymd: string) => MONTHS[Number(ymd.slice(5, 7)) - 1]!;

/** "hoje" · "ontem" · "seg 24/11" */
export function dayLabel(ymd: string, today: string): string {
  const d = diffDays(ymd, today);
  if (d === 0) return "hoje";
  if (d === 1) return "ontem";
  return `${WEEKDAY_SHORT[weekdayOf(ymd)]} ${shortDatePt(ymd)}`;
}

/* ------------------------------ categories ------------------------------ */

export async function listExpenseCategories(db: Db): Promise<ExpenseCategory[]> {
  return db.select().from(expenseCategories).orderBy(asc(expenseCategories.createdAt), asc(expenseCategories.slug));
}

/** The category the model (or the user) named; null when unknown. */
export function findExpenseCategory(cats: ExpenseCategory[], raw: string | null | undefined): ExpenseCategory | null {
  if (!raw) return null;
  const want = slugify(raw);
  return cats.find((c) => c.slug === want) ?? cats.find((c) => slugify(c.name) === want) ?? null;
}

export const defaultExpenseCategory = (cats: ExpenseCategory[]) => cats.find((c) => c.isDefault) ?? cats.at(-1) ?? null;

/** Category of a row; unknown slug (category removed) → the default one. */
export function categoryOf(e: Pick<Expense, "category">, cats: ExpenseCategory[]): ExpenseCategory | null {
  return cats.find((c) => c.slug === e.category) ?? defaultExpenseCategory(cats);
}

export async function createExpenseCategory(db: Db, name: string, emoji: string): Promise<{ cat: ExpenseCategory; created: boolean }> {
  const cats = await listExpenseCategories(db);
  const hit = findExpenseCategory(cats, name);
  if (hit) return { cat: hit, created: false };
  const slug = slugify(name);
  const clean = name.trim().charAt(0).toUpperCase() + name.trim().slice(1);
  await db.insert(expenseCategories).values({ slug, name: clean, emoji }).onConflictDoNothing();
  const [cat] = await db.select().from(expenseCategories).where(eq(expenseCategories.slug, slug));
  if (!cat) throw new Error("write verification failed: expense category not found after insert");
  return { cat, created: true };
}

/** Monthly limit in cents; null removes it. */
export async function setCategoryBudget(db: Db, slug: string, budget: number | null): Promise<ExpenseCategory> {
  await db.update(expenseCategories).set({ budget }).where(eq(expenseCategories.slug, slug));
  const [cat] = await db.select().from(expenseCategories).where(eq(expenseCategories.slug, slug));
  if (!cat || cat.budget !== budget) throw new Error("write verification failed: budget not saved");
  return cat;
}

/* -------------------------------- rows ---------------------------------- */

export type ExpenseInput = { amount: number; description: string; category: string; spentOn: string };

export function expenseId(sourceMessageId: string | null | undefined, description: string, amount: number): string {
  return sourceMessageId ? `${sourceMessageId}:${normText(description)}:${amount}` : crypto.randomUUID();
}

/** "uber" → "Uber"; keeps brand casing ("iFood"). */
export function cleanDescription(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const first = t.split(" ")[0] ?? "";
  if (/[A-Z]/.test(first.slice(1))) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Insert (no-op if this message already logged it) and re-read. */
export async function addExpense(db: Db, id: string, input: ExpenseInput): Promise<{ row: Expense; created: boolean }> {
  const inserted = await db.insert(expenses).values({ id, ...input }).onConflictDoNothing().returning({ id: expenses.id });
  const row = await getExpense(db, id);
  if (!row) throw new Error(`write verification failed: expense ${id} not found after insert`);
  return { row, created: inserted.length > 0 };
}

export async function getExpense(db: Db, id: string): Promise<Expense | null> {
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  return row ?? null;
}

export async function updateExpense(db: Db, id: string, patch: Partial<ExpenseInput>): Promise<Expense | null> {
  if (Object.keys(patch).length) await db.update(expenses).set(patch).where(eq(expenses.id, id));
  return getExpense(db, id);
}

export async function deleteExpense(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(expenses).where(eq(expenses.id, id)).returning({ id: expenses.id });
  return res.length > 0;
}

/** Spent between two local dates (inclusive), oldest first. */
export async function expensesBetween(db: Db, from: string, to: string): Promise<Expense[]> {
  return db
    .select()
    .from(expenses)
    .where(and(gte(expenses.spentOn, from), lte(expenses.spentOn, to)))
    .orderBy(asc(expenses.spentOn), asc(expenses.createdAt));
}

const AMOUNT = /(?:r\$\s*)?\b(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\b(?:\s*(?:reais|conto|pila))?/giu;

/**
 * Expenses matching a search, last 90 days, newest first. A value in it
 * ("uber de 23,50", "o de 45") narrows by amount instead of by words.
 */
export async function searchExpenses(db: Db, search: string, today: string, onDate?: string | null): Promise<Expense[]> {
  const rows = await db
    .select()
    .from(expenses)
    .where(onDate ? eq(expenses.spentOn, onDate) : gte(expenses.spentOn, addDays(today, -90)))
    .orderBy(desc(expenses.spentOn), desc(expenses.createdAt));
  const amounts = [...search.matchAll(AMOUNT)].map((m) => Number(m[1]!.replace(/\./g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0")));
  const words = search.replace(AMOUNT, " ").replace(/\s+/g, " ").trim();
  const byAmount = amounts.length ? rows.filter((r) => amounts.includes(r.amount)) : rows;
  const meaningful = normText(words).split(/\W+/u).some((w) => w && !STOP.has(w));
  return meaningful ? matchTitles(byAmount, (e) => e.description, words, STOP) : amounts.length ? byAmount : [];
}

/** "iFood · R$ 45,00 · hoje (alimentacao)": what the model sees as G1… */
export function toExpenseRef(e: Expense, today: string): ExpenseRef {
  return { expenseId: e.id, label: `${e.description} · ${brl(e.amount)} · ${dayLabel(e.spentOn, today)} (${e.category})` };
}

export const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

/* ------------------------------ formatting ------------------------------ */

/** "🍔 iFood — R$ 45,00 · ontem" */
export function expenseLine(e: Expense, cats: ExpenseCategory[], today: string, withDay = true): string {
  const c = categoryOf(e, cats);
  return `${c?.emoji ?? "💸"} ${e.description} — ${brl(e.amount)}${withDay ? ` · ${dayLabel(e.spentOn, today)}` : ""}`;
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 100);

/** "🍔 Alimentação: R$ 400,00 (32%)" per category, biggest first. */
export function categoryBreakdown(rows: Expense[], cats: ExpenseCategory[], opts: { budgets?: boolean } = {}): string[] {
  const total = sum(rows);
  const by = new Map<string, number>();
  for (const r of rows) {
    const slug = categoryOf(r, cats)?.slug ?? r.category;
    by.set(slug, (by.get(slug) ?? 0) + r.amount);
  }
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, amount]) => {
      const c = cats.find((x) => x.slug === slug);
      const share = total ? ` (${pct(amount, total)}%)` : "";
      const limit = opts.budgets && c?.budget ? ` · ${budgetMark(amount, c.budget)} ${pct(amount, c.budget)}% de ${brl(c.budget)}` : "";
      return `${c?.emoji ?? "💸"} ${c?.name ?? slug}: ${brl(amount)}${share}${limit}`;
    });
}

const budgetMark = (spent: number, budget: number) => (spent >= budget ? "🚨" : spent >= budget * BUDGET_WARN ? "⚠️" : "✅");

/** "↑ 12% vs semana passada (R$ 795,00)" */
function comparison(now: number, before: number, what: string): string {
  if (!before) return "";
  const d = pct(now - before, before);
  const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "=";
  return `\n${arrow} ${Math.abs(d)}% vs ${what} (${brl(before)})`;
}

/**
 * Progress of the limits touched by `slugs` in the month of `day`:
 * category limits always shown, the overall one from 80% on.
 */
export async function budgetStatus(db: Db, day: string, slugs: string[], totalBudget: number | null): Promise<string[]> {
  const [from, to] = monthRange(day);
  const rows = await expensesBetween(db, from, to);
  const cats = await listExpenseCategories(db);
  const lines: string[] = [];
  for (const slug of [...new Set(slugs)]) {
    const c = cats.find((x) => x.slug === slug);
    if (!c?.budget) continue;
    const spent = sum(rows.filter((r) => categoryOf(r, cats)?.slug === slug));
    lines.push(budgetLine(`${c.emoji} ${c.name}`, spent, c.budget, day));
  }
  const total = sum(rows);
  if (totalBudget && total >= totalBudget * BUDGET_WARN) lines.push(budgetLine("💰 Total", total, totalBudget, day));
  return lines;
}

function budgetLine(label: string, spent: number, budget: number, day: string): string {
  const head = `📊 ${label} em ${monthName(day)}: ${brl(spent)} de ${brl(budget)} (${pct(spent, budget)}%)`;
  if (spent > budget) return `${head}\n🚨 *Limite estourado* em ${brl(spent - budget)}`;
  if (spent === budget) return `${head}\n🚨 *Limite atingido*`;
  if (spent >= budget * BUDGET_WARN) return `${head}\n⚠️ Restam ${brl(budget - spent)}`;
  return head;
}

/** Limits overview ("meus limites"). */
export async function formatBudgets(db: Db, today: string, totalBudget: number | null): Promise<string> {
  const cats = await listExpenseCategories(db);
  const [from, to] = monthRange(today);
  const rows = await expensesBetween(db, from, to);
  const withBudget = cats.filter((c) => c.budget);
  if (!withBudget.length && !totalBudget) {
    return "📊 Nenhum limite definido. Ex: _limite de 800 em alimentação_ ou _limite total de 5000 por mês_.";
  }
  const lines = withBudget.map((c) => {
    const spent = sum(rows.filter((r) => categoryOf(r, cats)?.slug === c.slug));
    return `${budgetMark(spent, c.budget!)} ${c.emoji} ${c.name}: ${brl(spent)} de ${brl(c.budget!)} (${pct(spent, c.budget!)}%)`;
  });
  if (totalBudget) {
    const total = sum(rows);
    lines.push(`${budgetMark(total, totalBudget)} 💰 Total: ${brl(total)} de ${brl(totalBudget)} (${pct(total, totalBudget)}%)`);
  }
  return `📊 *Limites de ${monthName(today)}*\n${lines.join("\n")}`;
}

/** Numbered list of single expenses (they become G1…). */
const MAX_LISTED = 15;

/**
 * Answer to "quanto gastei …": total, then each expense when there are few,
 * else the per-category breakdown plus the biggest ones. Returns the rows
 * listed with numbers (for G refs).
 */
export function formatQuery(
  rows: Expense[],
  cats: ExpenseCategory[],
  today: string,
  title: string,
  opts: { category?: ExpenseCategory | null } = {},
): { text: string; listed: Expense[] } {
  if (!rows.length) return { text: `💸 ${title}: nenhum gasto ✨`, listed: [] };
  const head = `💸 *${title}*: ${brl(sum(rows))}${rows.length > 1 ? ` · ${rows.length} gastos` : ""}`;
  const singleDay = rows.every((r) => r.spentOn === rows[0]!.spentOn);
  if (rows.length <= MAX_LISTED) {
    const listed = [...rows].reverse();
    const items = listed.map((e, i) => `${i + 1}. ${expenseLine(e, cats, today, !singleDay)}`).join("\n");
    const breakdown = !opts.category && rows.length > 3 && new Set(rows.map((r) => r.category)).size > 1 ? `\n\n${categoryBreakdown(rows, cats).join("\n")}` : "";
    return { text: `${head}\n${items}${breakdown}`, listed };
  }
  const top = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const breakdown = opts.category ? "" : `\n${categoryBreakdown(rows, cats).join("\n")}\n`;
  return {
    text: `${head}\n${breakdown}\n🔝 *Maiores*\n${top.map((e, i) => `${i + 1}. ${expenseLine(e, cats, today)}`).join("\n")}`,
    listed: top,
  };
}

/* ------------------------------ summaries ------------------------------- */

/** 22:30 "today" summary; null when nothing was spent. */
export async function daySummary(db: Db, today: string, totalBudget: number | null): Promise<{ text: string; listed: Expense[] } | null> {
  const rows = await expensesBetween(db, today, today);
  if (!rows.length) return null;
  const cats = await listExpenseCategories(db);
  const q = formatQuery(rows, cats, today, `Gastos de hoje (${shortDatePt(today)})`);
  const [from] = monthRange(today);
  const month = sum(await expensesBetween(db, from, today));
  const limits = await budgetStatus(db, today, rows.map((r) => categoryOf(r, cats)?.slug ?? r.category), totalBudget);
  const warn = limits.filter((l) => l.includes("⚠️") || l.includes("🚨"));
  return {
    text: `${q.text}\n\n_No mês: ${brl(month)}_${warn.length ? `\n\n${warn.join("\n")}` : ""}\n_Errado? manda_ *muda o 2 pra 30* _ou_ *apaga o 1*`,
    listed: q.listed,
  };
}

/** Sunday: Monday..Sunday ending today; null when nothing was spent. */
export async function weekSummary(db: Db, sunday: string): Promise<string | null> {
  const [from, to] = weekRange(sunday);
  const rows = await expensesBetween(db, from, to);
  if (!rows.length) return null;
  const cats = await listExpenseCategories(db);
  const before = sum(await expensesBetween(db, addDays(from, -7), addDays(to, -7)));
  const days = new Set(rows.map((r) => r.spentOn)).size;
  return `📅 *Resumo da semana* (${shortDatePt(from)} a ${shortDatePt(to)})
Total: *${brl(sum(rows))}* · média ${brl(Math.round(sum(rows) / 7))}/dia · gastou em ${days} de 7 dias${comparison(sum(rows), before, "semana passada")}

${categoryBreakdown(rows, cats).join("\n")}`;
}

/** Last day of the month: the whole month; null when nothing was spent. */
export async function monthSummary(db: Db, lastDay: string, totalBudget: number | null): Promise<string | null> {
  const [from, to] = monthRange(lastDay);
  const rows = await expensesBetween(db, from, to);
  if (!rows.length) return null;
  const cats = await listExpenseCategories(db);
  const prev = monthRange(addDays(from, -1));
  const before = sum(await expensesBetween(db, prev[0], prev[1]));
  const total = sum(rows);
  const today = lastDay;
  const top = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const overall = totalBudget ? `\n${budgetMark(total, totalBudget)} limite total: ${pct(total, totalBudget)}% de ${brl(totalBudget)}` : "";
  return `🗓️ *Resumo de ${monthName(lastDay)}*
Total: *${brl(total)}* · ${rows.length} gastos${comparison(total, before, monthName(prev[0]))}${overall}

${categoryBreakdown(rows, cats, { budgets: true }).join("\n")}

🔝 *Maiores gastos*
${top.map((e, i) => `${i + 1}. ${expenseLine(e, cats, today, false)} · ${shortDatePt(e.spentOn)}`).join("\n")}`;
}
