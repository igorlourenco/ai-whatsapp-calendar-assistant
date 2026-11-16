import type { StoreCategory } from "../calendar/store";
import { slugify } from "../calendar/store";
import { shortDatePt, weekdayOf } from "../time";
import { actionSchema, type Action } from "./extract";

/*
 * Events read from an image are never saved directly: the user gets a
 * numbered preview and answers "sim", "não", "1,3" or "todos menos 2".
 * The answer is parsed by these rules, not by a model.
 */

export type CreateAction = Extract<Action, { type: "create" }>;

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const BYDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Items stored in state are re-validated before use. */
export function batchItems(items: Record<string, unknown>[]): CreateAction[] {
  return items.flatMap((i) => {
    const p = actionSchema.safeParse(i);
    return p.success && p.data.type === "create" && p.data.date ? [p.data] : [];
  });
}

/** "1. 🎓 *Direito Penal II* — ter 24/11 · 19:00" */
export function previewLine(a: CreateAction, index: number, cats: StoreCategory[]): string {
  const cat =
    cats.find((c) => a.category && (c.slug === slugify(a.category) || slugify(c.name) === slugify(a.category))) ??
    cats.find((c) => c.isDefault) ??
    cats[0];
  const date = a.date!;
  const day = `${WEEKDAY_SHORT[weekdayOf(date)]} ${shortDatePt(date)}`;
  let when: string;
  if (a.last_date && a.last_date !== date) when = `${day} a ${WEEKDAY_SHORT[weekdayOf(a.last_date)]} ${shortDatePt(a.last_date)}`;
  else when = day;
  if (a.start_time) when += ` · ${a.start_time}${a.end_time ? `–${a.end_time}` : ""}`;
  else when += " · dia todo";
  const extras = [
    a.location ? `📍 ${a.location}` : null,
    a.recurrence
      ? `🔁 ${a.recurrence.freq === "weekly" && a.recurrence.byWeekday?.length ? `toda ${a.recurrence.byWeekday.map((d) => BYDAY[d]).join(", ")}` : "repete"}${a.recurrence.until ? ` até ${shortDatePt(a.recurrence.until)}` : ""}`
      : null,
  ].filter(Boolean);
  return `${index + 1}. ${cat?.emoji ?? "📌"} *${a.title}* — ${when}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

export function previewMessage(items: CreateAction[], cats: StoreCategory[], skipped: string[] = []): string {
  const n = items.length;
  const head = `📷 *Encontrei ${n} ${n === 1 ? "evento" : "eventos"} na imagem:*`;
  const list = items.map((a, i) => previewLine(a, i, cats)).join("\n");
  const skippedNote = skipped.length ? `\n\n_Sem data, não incluí: ${skipped.join(", ")}_` : "";
  const ask =
    n === 1
      ? "Salvo? Responda *sim* ou *não*."
      : "Salvo? Responda *sim* (todos), *não*, ou os números (ex: _1,3_ ou _todos menos 2_).";
  return `${head}\n\n${list}${skippedNote}\n\n${ask}\n_Algo errado? Responda *não* e mande corrigido em texto._`;
}

export type BatchAnswer = { kind: "all" } | { kind: "none" } | { kind: "some"; indexes: number[] };

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[!.?…👍✅]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const YES = /^(sim|s|ss|si|yes|y|ok|okay|pode|pode salvar|pode sim|salva|salvar|salva tudo|salva todos|salvar tudo|confirmo|confirma|confirmado|isso|isso mesmo|todos|todas|tudo|todos eles|bora|manda|beleza|blz|fechado|perfeito|certo|correto|show)$/;
const NO = /^(nao|n|nope|no|cancela|cancelar|nenhum|nenhuma|deixa|deixa pra la|esquece|descarta|descartar|nao salva|nao precisa)$/;

function numbers(s: string, max: number): number[] | null {
  const cleaned = s.replace(/\b(?:o|a|os|as|numero|numeros|item|itens)\b/g, " ");
  const parts = cleaned.split(/\s*(?:,|;|\be\b|\s)\s*/).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  const idx = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  return idx.every((i) => i >= 1 && i <= max) ? idx : null;
}

/**
 * Parse a reply to the preview. Returns null when the message isn't an answer
 * (then it's handled as a normal message and the batch keeps waiting).
 */
export function parseBatchReply(text: string, count: number): BatchAnswer | null {
  const t = norm(text);
  if (!t) return null;
  if (YES.test(t)) return { kind: "all" };
  if (NO.test(t)) return { kind: "none" };

  // "todos menos 2", "tudo exceto 1 e 3", "menos o 2"
  const except = /^(?:(?:salva\s+)?(?:todos|todas|tudo)\s+)?(?:menos|exceto|tirando|sem)\s+(?:[oa]s?\s+)?(.+)$/.exec(t);
  if (except) {
    const drop = numbers(except[1]!, count);
    if (!drop) return null;
    const keep = Array.from({ length: count }, (_, i) => i + 1).filter((i) => !drop.includes(i));
    return keep.length ? { kind: "some", indexes: keep } : { kind: "none" };
  }

  // "1,3", "1 e 3", "so o 2", "salva 1 e 2", "os dois primeiros" (not supported → null)
  // The capture must start with a digit, so the regex backtracks past
  // articles/words ("só o 2" → "2") instead of capturing them.
  const only = /^(?:(?:sim|s)\s*,?\s*)?(?:(?:so|somente|apenas|salva|salvar)\s+)?(?:(?:so|somente|apenas)\s+)?(?:[oa]s?\s+)?(?:numeros?\s+)?(\d.*)$/.exec(t);
  const idx = only ? numbers(only[1]!, count) : null;
  if (idx) return idx.length === count ? { kind: "all" } : { kind: "some", indexes: idx };
  return null;
}

