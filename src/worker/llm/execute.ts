import { formatAgenda, formatLine } from "../calendar/format";
import {
  UserError,
  defaultCategory,
  matchTitles,
  normText,
  slugify,
  type CalendarStore,
  type EventInput,
  type OccurrenceView,
  type StoreCategory,
} from "../calendar/store";
import type { Db } from "../db/client";
import { messageEvents, type FocusItem, type PendingPick, type Recurrence } from "../db/schema";
import {
  byDue,
  completeTask,
  groupTasks,
  taskCategory,
  createTask,
  deleteTask,
  findDuplicateTask,
  formatTaskList,
  getTask,
  openTasks,
  searchTasks,
  taskId,
  taskLine,
  taskSection,
  tasksDue,
  toTaskRef,
  updateTask,
  type TaskPatch,
} from "../tasks";
import type { Task, TaskRef } from "../db/schema";
import { addItems, findItem, formatShoppingList, joinNames, markBought, openItems, removeItems } from "../shopping";
import {
  addExpense,
  brl,
  budgetStatus,
  categoryOf,
  cleanDescription,
  createExpenseCategory,
  dayLabel,
  defaultExpenseCategory,
  deleteExpense,
  expenseId,
  expenseLine,
  expensesBetween,
  findExpenseCategory,
  formatBudgets,
  formatQuery,
  getExpense,
  listExpenseCategories,
  monthName,
  searchExpenses,
  setCategoryBudget,
  toCents,
  toExpenseRef,
  updateExpense,
  type ExpenseInput,
} from "../expenses";
import type { Expense, ExpenseRef } from "../db/schema";
import { nagMinutes, validTimezone } from "../config";
import { loadProfile, updateProfile, type ProfilePatch } from "../users";
import { addDays, diffDays, localDate, localDateTime, localTime, localToUtc, shortDatePt } from "../time";
import { renderConfirmations } from "./confirm";
import type { DeepSeekEnv } from "./deepseek";
import { batchItems, parseBatchReply, previewMessage, type BatchAnswer, type CreateAction } from "./batch";
import { extractActions, type Action } from "./extract";
import type { Transcribe } from "./transcribe";
import { MediaTooLarge, type Vision } from "./vision";
import { loadState, pushExpenses, pushFocus, pushTasks, saveState, toFocus, type State } from "./state";

export type AppCtx = {
  store: CalendarStore;
  /** Durable Object SQLite: inbox, state, tasks, logs (events live in the store). */
  db: Db;
  tz: string;
  defaultReminder: number;
  /** Minutes between task nags (shown in confirmations). */
  taskNagMinutes?: number;
  /** WhatsApp message being handled; makes creates idempotent on retry. */
  sourceMessageId?: string | null;
  /** Guests keep events in the bot (ICS feed); the owner uses iCloud. */
  user?: { guest: boolean; feedUrl: string | null; morningAt: string; eveningAt: string; expenseAt?: string; expenseDaily?: boolean };
};

export type WriteRecord =
  | { kind: "event_saved"; action: "created" | "updated" | "exists"; eventId: string }
  | { kind: "event_deleted"; title: string; occurrenceStart: Date | null }
  | { kind: "category"; action: "created"; label: string }
  | { kind: "task"; action: "created" | "updated" | "exists" | "done"; taskId: string; next?: string | null }
  | { kind: "task_deleted"; title: string };

export const HELP_TEXT = `🤔 Não entendi. Exemplos:
• _dentista sexta 15h_
• _prova de penal dia 25_
• _aula de civil toda terça e quinta 19h às 22h_
• _o que tenho amanhã?_
• _muda o dentista pra 16h_
• _cancela a academia de segunda_
• _me lembra de pagar o boleto sexta_
• _tarefas_ · _feito o 2_
• _compra leite e ovos_ · _lista_ · _comprei o leite_
• _gastei 45 no ifood_ · _quanto gastei esse mês?_ · _limite de 800 em alimentação_
• _resumo às 8h_ · _link da agenda_`;

export type Incoming = { text: string; mediaUrl?: string | null; mediaMime?: string | null };
type Download = (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
export type MediaDeps = {
  vision?: Vision;
  download?: Download;
  transcribe?: Transcribe;
  downloadAudio?: Download;
};

const BATCH_REMINDER = "📷 _Os eventos da imagem ainda esperam sua resposta (sim / não / números)._";

/**
 * One message in, one reply out. The only context is the structured State
 * (pending draft/pick/batch + recently touched events), built by code; the
 * model never sees past replies.
 */
export async function handleMessage(
  ctx: AppCtx,
  env: DeepSeekEnv,
  input: Incoming | string,
  media: MediaDeps = {},
): Promise<string> {
  const msg: Incoming = typeof input === "string" ? { text: input } : input;

  // Voice note: transcribed, then handled exactly like the typed message.
  if (msg.mediaUrl && msg.mediaMime?.startsWith("audio/")) {
    const heard = await transcribeAudio(msg, media);
    if (!heard.text) return heard.reply;
    return `${heard.reply}\n\n${await handleText(ctx, env, heard.text)}`;
  }

  if (msg.mediaUrl) {
    const state = await loadState(ctx.db);
    const categories = await ctx.store.listCategories();
    const r = await handleImage(ctx, env, msg, media, state, categories);
    await saveState(ctx.db, r.state);
    return r.reply;
  }
  return handleText(ctx, env, msg.text);
}

/** "🎤 _texto_" echo plus the text to act on, or a reply when there's nothing to act on. */
async function transcribeAudio(msg: Incoming, media: MediaDeps): Promise<{ text: string; reply: string }> {
  const stop = (reply: string) => ({ text: "", reply });
  if (!media.transcribe || !media.downloadAudio) return stop("🙏 Áudio não está ativado nesta instalação. Pode escrever?");
  let audio: { bytes: Uint8Array; mime: string };
  try {
    audio = await media.downloadAudio(msg.mediaUrl!);
  } catch (err) {
    if (err instanceof MediaTooLarge) return stop("🙏 Áudio muito longo. Manda um mais curto (até uns 2 min) ou escreve?");
    throw err;
  }
  const heard = await media.transcribe(audio.bytes, audio.mime);
  console.log("[transcribe]", heard.length, JSON.stringify(heard.slice(0, 300)));
  if (!heard) return stop("🤔 Não consegui entender o áudio. Pode repetir ou escrever?");
  const caption = msg.text.trim();
  const text = caption ? `${caption}\n${heard}` : heard;
  const shown = heard.length > 300 ? `${heard.slice(0, 300)}…` : heard;
  return { text, reply: `🎤 _${shown.replace(/[_*~]/g, "")}_` };
}

/** A typed (or transcribed) message. */
async function handleText(ctx: AppCtx, env: DeepSeekEnv, input: string): Promise<string> {
  const text = input.trim();
  const state = await loadState(ctx.db);
  const categories = await ctx.store.listCategories();
  const expenseCategories = await listExpenseCategories(ctx.db);

  // Answer to an image preview? Decided by rules, never by the model.
  if (state.batch) {
    const items = batchItems(state.batch.items);
    const answer = items.length ? parseBatchReply(text, items.length) : null;
    if (answer) {
      const r = await resolveBatch(ctx, state, items, answer);
      await saveState(ctx.db, r.state);
      return r.reply;
    }
    if (!items.length) state.batch = null; // unusable batch: drop it, handle the message normally
  }

  const extracted = await extractActions(env, text, { now: new Date(), tz: ctx.tz, categories, state, expenseCategories });
  console.log("[extract]", JSON.stringify(extracted));
  const { actions, blocked } = guardDeletes(text, extracted, state);
  const result = actions.length
    ? await executeActions(ctx, actions, state)
    : { reply: "", state: { ...state, draft: null, pick: null } };
  await saveState(ctx.db, result.state);
  const reply = [...blocked, result.reply].filter(Boolean).join("\n\n");
  return result.state.batch ? `${reply}\n\n${BATCH_REMINDER}` : reply;
}

const DELETE_WORDS = /\b(cancel|apag|desmarc|remov|retir|tira|exclu|delet|esquec|desist|nao vou mais|nao tem mais|nao precis)/u;

/**
 * Deleting is the one action that can't be undone, and the model sometimes
 * reads a correction ("não, era a doação de sangue") as "cancel". Without an
 * explicit delete word in the message (or a pending "which one to delete?"),
 * a delete is dropped and explained.
 */
export function guardDeletes(text: string, actions: Action[], state?: State): { actions: Action[]; blocked: string[] } {
  // Answering "qual deles?" for a delete asked in the previous message.
  const answeringDelete = state?.pick?.action === "delete" || state?.pick?.action === "delete_task" || state?.pick?.action === "delete_expense";
  if (answeringDelete || DELETE_WORDS.test(normText(text))) return { actions, blocked: [] };
  const blocked: string[] = [];
  const kept = actions.filter((a) => {
    if (a.type !== "delete" && a.type !== "delete_task" && a.type !== "delete_expense") return true;
    const what = a.search ? `“${a.search}”` : { delete: "esse evento", delete_task: "essa tarefa", delete_expense: "esse gasto" }[a.type];
    blocked.push(`❓ Não entendi se é pra apagar ${what}. Nada foi apagado. Se for, manda _cancela ${a.search ?? "…"}_.`);
    return false;
  });
  return { actions: kept, blocked };
}

/**
 * Image: transcribe → same extractor → numbered preview. NOTHING is saved
 * here; creates wait in state.batch for "sim / não / 1,3". Image text is
 * content, not commands: only creates (previewed) and queries are honored.
 */
async function handleImage(
  ctx: AppCtx,
  env: DeepSeekEnv,
  msg: Incoming,
  media: MediaDeps,
  state: State,
  categories: StoreCategory[],
): Promise<{ reply: string; state: State }> {
  const keep = (reply: string) => ({ reply, state });
  if (!media.vision || !media.download) return keep("🙏 Leitura de imagens não está ativada nesta instalação.");
  if (msg.mediaMime && !msg.mediaMime.startsWith("image/")) {
    return keep("🙏 Por enquanto leio texto e imagens. Se for PDF, manda um print da página.");
  }

  const { bytes, mime } = await media.download(msg.mediaUrl!);
  const transcript = await media.vision(bytes, mime);
  console.log("[vision]", transcript.length, JSON.stringify(transcript.slice(0, 300)));
  if (!transcript) return keep("🤔 Não encontrei datas nem compromissos nessa imagem.");

  const caption = msg.text.trim();
  const prompt = `MENSAGEM COM IMAGEM. Texto lido da imagem:\n"""\n${transcript}\n"""${caption ? `\nLegenda escrita pelo usuário: "${caption}"` : ""}`;
  const actions = await extractActions(env, prompt, {
    now: new Date(),
    tz: ctx.tz,
    categories,
    state: { draft: null, focus: [], pick: null },
  });
  console.log("[extract:image]", JSON.stringify(actions));

  const creates = actions.filter((a): a is CreateAction => a.type === "create");
  const items = creates.filter((a) => a.date);
  const skipped = creates.filter((a) => !a.date).map((a) => a.title);
  const queries = actions.filter((a) => a.type === "query");

  const parts: string[] = [];
  let next: State = { ...state, draft: null, pick: null };
  if (queries.length) {
    const r = await executeActions(ctx, queries, next);
    parts.push(r.reply);
    next = r.state;
  }
  if (items.length) {
    const replaced = state.batch ? "\n\n_(a imagem anterior, ainda sem resposta, foi descartada)_" : "";
    next.batch = { messageId: ctx.sourceMessageId ?? crypto.randomUUID(), createdAt: new Date().toISOString(), items };
    parts.unshift(previewMessage(items, categories, skipped) + replaced);
  } else if (!queries.length) {
    const excerpt = transcript.length > 300 ? `${transcript.slice(0, 300)}…` : transcript;
    parts.push(`🤔 Li a imagem, mas não achei compromissos com data:\n_${excerpt.replace(/_/g, "")}_`);
  }
  return { reply: parts.join("\n\n"), state: next };
}

/** Save the chosen events of a pending image batch (or discard it). */
async function resolveBatch(
  ctx: AppCtx,
  state: State,
  items: CreateAction[],
  answer: BatchAnswer,
): Promise<{ reply: string; state: State }> {
  const cleared: State = { ...state, draft: null, pick: null, batch: null };
  if (answer.kind === "none" || !items.length) {
    return { reply: "🗑️ Ok, descartei os eventos da imagem. Nada foi salvo.", state: cleared };
  }
  const chosen = answer.kind === "all" ? items : answer.indexes.map((i) => items[i - 1]!).filter(Boolean);
  // Idempotent per image message: a retry re-PUTs the same objects.
  const r = await executeActions({ ...ctx, sourceMessageId: state.batch!.messageId }, chosen, cleared);
  return { reply: r.reply, state: { ...r.state, batch: null } };
}

type Turn = {
  writes: WriteRecord[];
  /** Focus as shown to the model this turn: refs E1… resolve against THIS list. */
  shown: FocusItem[];
  /** Pending "qual deles?" from the previous message (its changes are reused). */
  pick: PendingPick | null;
  /** Tasks as shown to the model this turn: refs T1… resolve against THIS list. */
  shownTasks: TaskRef[];
  /** Expenses as shown to the model this turn: refs G1… resolve against THIS list. */
  shownExpenses: ExpenseRef[];
  /** State after this message. Pending questions only survive if re-asked. */
  next: State;
};

/**
 * Run actions in order and build the reply. Every confirmation is rendered
 * from rows re-read from the database (renderConfirmations); an action that
 * can't be done produces an explicit "❌/❓" line, never a fake success.
 */
export async function executeActions(
  ctx: AppCtx,
  actions: Action[],
  state: State = { draft: null, focus: [] },
): Promise<{ reply: string; state: State }> {
  const parts: string[] = [];
  const turn: Turn = {
    writes: [],
    shown: state.focus,
    pick: state.pick ?? null,
    shownTasks: state.tasks ?? [],
    shownExpenses: state.expenses ?? [],
    next: {
      draft: null,
      pick: null,
      focus: state.focus,
      batch: state.batch ?? null,
      tasks: state.tasks ?? [],
      expenses: state.expenses ?? [],
      lastList: state.lastList ?? null,
    },
  };

  const flushWrites = async () => {
    if (!turn.writes.length) return;
    const writes = turn.writes.splice(0);
    parts.push(await renderConfirmations(ctx, writes));
    const saved = writes.filter((w) => w.kind === "event_saved").map((w) => w.eventId);
    const items: FocusItem[] = [];
    for (const id of saved.reverse()) {
      const f = await focusForEvent(ctx, id);
      if (f) items.push(f);
    }
    turn.next.focus = pushFocus(turn.next.focus, items);
    const today = localDate(new Date(), ctx.tz);
    const taskRefs: TaskRef[] = [];
    for (const w of writes.reverse()) {
      if (w.kind !== "task" || w.action === "done") continue;
      const t = await getTask(ctx.db, w.taskId);
      if (t && !taskRefs.some((r) => r.taskId === t.id)) taskRefs.push(toTaskRef(t, today));
    }
    if (taskRefs.length) turn.next.tasks = pushTasks(turn.next.tasks ?? [], taskRefs);
  };

  for (const a of actions) {
    try {
      const out = await run(ctx, a, turn);
      if (out) {
        await flushWrites();
        parts.push(out);
      }
    } catch (err) {
      // Infra failures (DB, etc.) propagate: the inbox retries the message,
      // and creates are idempotent. Only user-input problems are answered.
      if (!(err instanceof UserError)) throw err;
      await flushWrites();
      parts.push(`❌ ${err.message} ${a.type === "create" || a.type === "create_task" || a.type === "add_expense" ? "Nada foi salvo." : "Nada foi alterado."}`);
    }
  }
  await flushWrites();
  return { reply: parts.join("\n\n") || HELP_TEXT, state: turn.next };
}

/** Returns text to show, or null when the result is a write (confirmed later from DB). */
async function run(ctx: AppCtx, action: Action, turn: Turn): Promise<string | null> {
  const a = (await crossKind(ctx, action)) ?? action;
  switch (a.type) {
    case "create": {
      if (!a.date) {
        // Missing required info: keep it as a draft and ask. Nothing saved.
        const { type: _, ...draft } = a;
        turn.next.draft = { ...draft, recurrence: cleanRecurrence(a.recurrence) };
        return `❓ *${a.title}*: qual dia${a.start_time ? "" : " e horário (se tiver)"}?`;
      }
      const input = createInput(ctx, a, a.date);
      const dup = await findDuplicate(ctx, input);
      if (dup) {
        turn.writes.push({ kind: "event_saved", action: "exists", eventId: dup });
        return null;
      }
      const ev = await ctx.store.createEvent(input);
      turn.writes.push({ kind: "event_saved", action: "created", eventId: ev.id });
      if (ctx.sourceMessageId) {
        await ctx.db
          .insert(messageEvents)
          .values({ messageId: ctx.sourceMessageId, eventId: ev.id, label: `${ev.title} — ${localDateTime(ev.startAt, ctx.tz).replace("T", " ")}` })
          .onConflictDoNothing();
      }
      return null;
    }
    case "update": {
      const target = await resolveRefOrSearch(ctx, a, turn, { action: "update", changes: stripNulls(a.changes) });
      if ("reply" in target) return target.reply;
      // Answer to "qual deles?": reuse the changes asked for in the previous message.
      const changes =
        turn.pick?.action === "update" && a.ref ? { ...(turn.pick.changes as Changes), ...stripNulls(a.changes) } : a.changes;
      const patch = updatePatch(ctx, target.event, changes);
      if (!Object.keys(patch).length) {
        turn.next.focus = pushFocus(turn.next.focus, [toFocus(target, ctx.tz)]);
        return `❓ Mudar o quê em *${target.event.title}*? (dia, horário, nome, local, lembrete…)`;
      }
      const ev = await ctx.store.updateEvent(target.event.id, patch);
      if (!ev) throw new UserError("Esse evento não existe mais.");
      turn.writes.push({ kind: "event_saved", action: "updated", eventId: ev.id });
      return null;
    }
    case "delete": {
      const target = await resolveRefOrSearch(ctx, a, turn, { action: "delete", only_that_day: a.only_that_day });
      if ("reply" in target) return target.reply;
      const onlyThatDay = a.only_that_day ?? (turn.pick?.action === "delete" ? turn.pick.only_that_day : null);
      const single = !!(onlyThatDay && target.event.recurrence);
      const result = await ctx.store.deleteEvent(target.event.id, single ? target.start : null);
      if (result === "not_found") throw new UserError("Esse evento não existe mais.");
      turn.writes.push({
        kind: "event_deleted",
        title: target.event.title,
        occurrenceStart: single ? target.start : null,
      });
      if (!single) turn.next.focus = turn.next.focus.filter((f) => f.eventId !== target.event.id);
      return null;
    }
    case "query": {
      const to = a.to < a.from ? a.from : a.to;
      const occ = await ctx.store.findOccurrences(localToUtc(a.from, ctx.tz), localToUtc(addDays(to, 1), ctx.tz), {
        category: a.category,
        query: a.search,
      });
      if (occ.length) {
        turn.next.focus = occ.slice(0, 10).map((o) => toFocus(o, ctx.tz));
        turn.next.lastList = "events";
      }
      const agenda = formatAgenda(occ, a.from, to, ctx.tz, {
        emptyText: `🗓️ Nada marcado ${a.from === to ? `em ${shortDatePt(a.from)}` : `de ${shortDatePt(a.from)} a ${shortDatePt(to)}`} ✨`,
      });
      // Tasks due in the range (and overdue ones when it includes today).
      if (a.category || a.search) return agenda;
      const today = localDate(new Date(), ctx.tz);
      const due = await tasksDue(ctx.db, a.from, to, a.from <= today && today <= to);
      if (!due.length) return agenda;
      turn.next.tasks = due.slice(0, 10).map((t) => toTaskRef(t, today));
      return `${agenda}\n\n${taskSection(due, today)}`;
    }
    case "create_category": {
      const c = await ctx.store.createCategory({ name: a.name, emoji: a.emoji });
      turn.writes.push({ kind: "category", action: "created", label: `${c.emoji} ${c.name}` });
      return null;
    }
    case "create_task": {
      if (!a.due_date && !a.someday) {
        // No day given: ask (that's when the nagging starts), unless the user
        // said it has none ("algum dia"), which saves it undated.
        turn.next.draft = {
          kind: "task",
          title: a.title,
          start_time: a.due_time ?? null,
          recurrence: cleanRecurrence(a.recurrence),
          notes: a.notes ?? null,
          category: a.category ?? null,
        };
        return `❓ *${a.title}*: pra quando? (ex: _hoje_, _sexta_, _amanhã 10h_, ou _sem data_)`;
      }
      const input = {
        title: a.title,
        dueDate: a.due_date ?? null,
        dueTime: a.due_date ? (a.due_time ?? null) : null,
        recurrence: cleanRecurrence(a.recurrence),
        notes: a.notes ?? null,
        category: await taskCategorySlug(ctx, a.category),
      };
      const dup = await findDuplicateTask(ctx.db, input);
      if (dup) {
        turn.writes.push({ kind: "task", action: "exists", taskId: dup.id });
        return null;
      }
      const t = await createTask(ctx.db, taskId(ctx.sourceMessageId, a.title), input);
      turn.writes.push({ kind: "task", action: "created", taskId: t.id });
      if (ctx.sourceMessageId) {
        await ctx.db
          .insert(messageEvents)
          .values({ messageId: ctx.sourceMessageId, eventId: `task:${t.id}`, label: `📝 ${taskLine(t, localDate(new Date(), ctx.tz))}` })
          .onConflictDoNothing();
      }
      return null;
    }
    case "complete_task": {
      const t = await resolveTask(ctx, a, turn, { action: "complete_task" });
      if ("reply" in t) return t.reply;
      const r = await completeTask(ctx.db, t.id, ctx.tz);
      if (!r) throw new UserError("Essa tarefa não existe mais.");
      turn.writes.push({ kind: "task", action: "done", taskId: t.id, next: r.next });
      turn.next.tasks = (turn.next.tasks ?? []).filter((x) => x.taskId !== t.id || r.next);
      return null;
    }
    case "update_task": {
      const pickChanges = turn.pick?.action === "update_task" && a.ref ? (turn.pick.changes as TaskChanges) : {};
      const changes: TaskChanges = { ...pickChanges, ...stripNulls(a.changes) };
      const t = await resolveTask(ctx, a, turn, { action: "update_task", changes: stripNulls(a.changes) });
      if ("reply" in t) return t.reply;
      const patch: TaskPatch = {};
      if (changes.title) patch.title = changes.title;
      if (changes.notes) patch.notes = changes.notes;
      if (changes.category) {
        const slug = await taskCategorySlug(ctx, changes.category, false);
        if (!slug) throw new UserError(`Não tenho a lista “${changes.category}”. Pra criar: _cria a categoria ${changes.category}_.`);
        patch.category = slug;
      }
      if (changes.no_date && !changes.due_date) {
        patch.dueDate = null;
        patch.dueTime = null;
      } else if (changes.due_date) patch.dueDate = changes.due_date;
      if (changes.due_time && patch.dueDate !== null) {
        patch.dueTime = changes.due_time;
        // "muda pra 15h" on an undated task → today.
        if (!t.dueDate && !changes.due_date) patch.dueDate = localDate(new Date(), ctx.tz);
      }
      if (!Object.keys(patch).length) {
        turn.next.tasks = pushTasks(turn.next.tasks ?? [], [toTaskRef(t, localDate(new Date(), ctx.tz))]);
        return `❓ Mudar o quê em *${t.title}*? (data, horário, nome…)`;
      }
      const row = await updateTask(ctx.db, t.id, patch);
      if (!row) throw new UserError("Essa tarefa não existe mais.");
      turn.writes.push({ kind: "task", action: "updated", taskId: t.id });
      return null;
    }
    case "update_tasks": {
      const today = localDate(new Date(), ctx.tz);
      const cats = await ctx.store.listCategories();
      let list = await openTasks(ctx.db);
      if (a.which === "overdue") list = list.filter((t) => t.dueDate && t.dueDate < today);
      else if (a.which === "today") list = list.filter((t) => t.dueDate === today);
      else if (a.which === "listed") {
        const ids = turn.shownTasks.map((r) => r.taskId);
        list = list.filter((t) => ids.includes(t.id));
      }
      let catName = "";
      if (a.category) {
        const slug = await taskCategorySlug(ctx, a.category, false);
        const cat = cats.find((c) => c.slug === slug);
        if (!cat) throw new UserError(`Não tenho a lista “${a.category}”.`);
        list = list.filter((t) => taskCategory(t, cats)?.slug === cat.slug);
        catName = ` de ${cat.emoji} ${cat.name}`;
      }
      const what = { overdue: "atrasada", today: "pra hoje", listed: "dessas", all: "aberta" }[a.which];
      if (!list.length) return `❓ Nenhuma tarefa ${what}${catName}.`;
      const c = stripNulls(a.changes);
      if (!c.due_date && !c.due_time) {
        turn.next.tasks = list.slice(0, 10).map((t) => toTaskRef(t, today));
        turn.next.lastList = "tasks";
        return `❓ Mudar ${list.length === 1 ? "a tarefa" : `as ${list.length} tarefas`} pra quando? (ex: _hoje 13h_, _amanhã_)`;
      }
      if (c.due_date && c.due_date < today) throw new UserError("Essa data já passou.");
      for (const t of list) {
        // Only a time: same day if it's still ahead, else today.
        const dueDate = c.due_date ?? (t.dueDate && t.dueDate >= today ? t.dueDate : today);
        const row = await updateTask(ctx.db, t.id, { dueDate, ...(c.due_time ? { dueTime: c.due_time } : {}) });
        if (!row || row.dueDate !== dueDate || (c.due_time && row.dueTime !== c.due_time)) {
          throw new Error(`write verification failed: task ${t.id} not moved`);
        }
      }
      const rows = (await Promise.all(list.map((t) => getTask(ctx.db, t.id)))).filter((t): t is Task => !!t);
      const { list: ordered } = groupTasks(rows.sort(byDue), cats);
      turn.next.tasks = ordered.slice(0, 10).map((t) => toTaskRef(t, today));
      turn.next.lastList = "tasks";
      const n = ordered.length;
      return `✏️ *${n} ${n === 1 ? "tarefa atualizada" : "tarefas atualizadas"}*\n${ordered.map((t, i) => `${i + 1}. ${taskLine(t, today)}`).join("\n")}`;
    }
    case "delete_task": {
      const t = await resolveTask(ctx, a, turn, { action: "delete_task" });
      if ("reply" in t) return t.reply;
      if (!(await deleteTask(ctx.db, t.id))) throw new UserError("Essa tarefa não existe mais.");
      turn.writes.push({ kind: "task_deleted", title: t.title });
      turn.next.tasks = (turn.next.tasks ?? []).filter((x) => x.taskId !== t.id);
      return null;
    }
    case "list_tasks": {
      const cats = await ctx.store.listCategories();
      let open = await openTasks(ctx.db);
      let head = "📝 *Tarefas*";
      if (a.category) {
        const slug = await taskCategorySlug(ctx, a.category, false);
        const cat = cats.find((c) => c.slug === slug);
        if (!cat) return `❓ Não tenho a lista “${a.category}”. Suas listas: ${cats.map((c) => `${c.emoji} ${c.name}`).join(", ")}.`;
        open = open.filter((t) => taskCategory(t, cats)?.slug === cat.slug);
        if (!open.length) return `${cat.emoji} Nenhuma tarefa aberta em *${cat.name}* ✨`;
        head = `${cat.emoji} *Tarefas · ${cat.name}*`;
      }
      const { list } = groupTasks(open, cats);
      const today = localDate(new Date(), ctx.tz);
      if (list.length) {
        turn.next.tasks = list.slice(0, 10).map((t) => toTaskRef(t, today));
        turn.next.lastList = "tasks";
      }
      return formatTaskList(list, today, head, cats);
    }
    case "add_shopping": {
      const { added, existing } = await addItems(ctx.db, a.items, ctx.sourceMessageId);
      const total = (await openItems(ctx.db)).length;
      const lines: string[] = [];
      if (added.length) lines.push(`🛒 *Na lista:* ${joinNames(added)}`);
      if (existing.length) lines.push(`ℹ️ Já estava na lista: ${joinNames(existing)}`);
      lines.push(`_${total} ${total === 1 ? "item" : "itens"} na lista · manda *lista* pra ver_`);
      return lines.join("\n");
    }
    case "bought":
    case "remove_shopping": {
      const open = await openItems(ctx.db);
      if (!open.length) return "🛒 A lista de compras já está vazia.";
      const all = a.type === "bought" && (a.all || !a.items?.length);
      const chosen = all ? open : [];
      const missing: string[] = [];
      const ambiguous: string[] = [];
      for (const name of all ? [] : (a.items ?? [])) {
        const hits = findItem(open, name);
        if (hits.length === 1) {
          if (!chosen.includes(hits[0]!)) chosen.push(hits[0]!);
        } else if (hits.length) ambiguous.push(`❓ “${name}” bate com ${joinNames(hits)}. Qual? (manda o nome inteiro)`);
        else missing.push(`“${name}”`);
      }
      const ids = chosen.map((i) => i.id);
      if (a.type === "bought") await markBought(ctx.db, ids);
      else await removeItems(ctx.db, ids);
      const left = await openItems(ctx.db);
      if (left.some((i) => ids.includes(i.id))) throw new Error("write verification failed: shopping items still open");
      const lines: string[] = [];
      if (chosen.length) lines.push(a.type === "bought" ? `✅ *Comprado:* ${joinNames(chosen)}` : `🗑️ *Tirado da lista:* ${joinNames(chosen)}`);
      if (missing.length) lines.push(`❓ Não achei ${missing.join(", ")} na lista.`);
      lines.push(...ambiguous);
      if (chosen.length) lines.push(left.length ? `🛒 Falta: ${joinNames(left)}` : "🛒 Lista zerada ✨");
      return lines.join("\n");
    }
    case "list_shopping":
      return formatShoppingList(await openItems(ctx.db));
    case "add_expense":
      return addExpenseAction(ctx, a, turn);
    case "update_expense": {
      const e = await resolveExpense(ctx, a, turn, { action: "update_expense", changes: stripNulls(a.changes) });
      if ("reply" in e) return e.reply;
      const pickChanges = turn.pick?.action === "update_expense" && a.ref ? (turn.pick.changes as ExpenseChanges) : {};
      const c: ExpenseChanges = { ...pickChanges, ...stripNulls(a.changes) };
      const patch: Partial<ExpenseInput> = {};
      const cents = toCents(c.amount);
      if (cents) patch.amount = cents;
      if (c.description) patch.description = cleanDescription(c.description);
      if (c.date) {
        if (c.date > localDate(new Date(), ctx.tz)) throw new UserError("Gasto não pode ser numa data futura.");
        patch.spentOn = c.date;
      }
      if (c.category) {
        const cat = findExpenseCategory(await listExpenseCategories(ctx.db), c.category);
        if (!cat) throw new UserError(`Não tenho a categoria de gasto “${c.category}”. Pra criar: _cria categoria de gasto ${c.category}_.`);
        patch.category = cat.slug;
      }
      if (!Object.keys(patch).length) {
        turn.next.expenses = pushExpenses(turn.next.expenses ?? [], [toExpenseRef(e, localDate(new Date(), ctx.tz))]);
        turn.next.lastList = "expenses";
        return `❓ Mudar o quê em *${e.description}*? (valor, categoria, dia…)`;
      }
      const row = await updateExpense(ctx.db, e.id, patch);
      if (!row) throw new UserError("Esse gasto não existe mais.");
      for (const [k, v] of Object.entries(patch)) {
        if (row[k as keyof Expense] !== v) throw new Error(`write verification failed: expense ${e.id} ${k} not saved`);
      }
      return expenseSaved(ctx, [row], turn, "✏️ *Gasto corrigido*");
    }
    case "delete_expense": {
      const e = await resolveExpense(ctx, a, turn, { action: "delete_expense" });
      if ("reply" in e) return e.reply;
      if (!(await deleteExpense(ctx.db, e.id))) throw new UserError("Esse gasto não existe mais.");
      if (await getExpense(ctx.db, e.id)) throw new Error(`write verification failed: expense ${e.id} still there`);
      turn.next.expenses = (turn.next.expenses ?? []).filter((x) => x.expenseId !== e.id);
      return `🗑️ *Gasto apagado:* ${e.description} — ${brl(e.amount)} · ${dayLabel(e.spentOn, localDate(new Date(), ctx.tz))}`;
    }
    case "query_expenses": {
      const today = localDate(new Date(), ctx.tz);
      const to = a.to < a.from ? a.from : a.to;
      const cats = await listExpenseCategories(ctx.db);
      let rows = await expensesBetween(ctx.db, a.from, to);
      let cat = null as ReturnType<typeof findExpenseCategory>;
      if (a.category) {
        cat = findExpenseCategory(cats, a.category);
        if (!cat) return `❓ Não tenho a categoria de gasto “${a.category}”. Categorias: ${cats.map((c) => `${c.emoji} ${c.name}`).join(", ")}.`;
        rows = rows.filter((r) => categoryOf(r, cats)?.slug === cat!.slug);
      }
      if (a.search) rows = (await searchExpenses(ctx.db, a.search, today)).filter((r) => r.spentOn >= a.from && r.spentOn <= to).reverse();
      const q = formatQuery(rows, cats, today, expenseTitle(a.from, to, today, cat ? `${cat.emoji} ${cat.name}` : a.search ? `“${a.search}”` : null), { category: cat });
      if (q.listed.length) {
        turn.next.expenses = q.listed.slice(0, 10).map((e) => toExpenseRef(e, today));
        turn.next.lastList = "expenses";
      }
      const budget = cat?.budget && a.from.slice(0, 7) === to.slice(0, 7) ? await budgetStatus(ctx.db, a.from, [cat.slug], null) : [];
      return [q.text, ...budget].join("\n\n");
    }
    case "create_expense_category": {
      const { cat, created } = await createExpenseCategory(ctx.db, a.name, a.emoji);
      return created ? `🏷️ Categoria de gasto criada: ${cat.emoji} ${cat.name}` : `ℹ️ Já existe a categoria de gasto ${cat.emoji} ${cat.name}`;
    }
    case "set_budget": {
      const today = localDate(new Date(), ctx.tz);
      const cents = a.amount > 0 ? Math.round(a.amount * 100) : null;
      if (!a.category) {
        await updateProfile(ctx.db, { expenseBudget: cents });
        const p = await loadProfile(ctx.db);
        if ((p?.expenseBudget ?? null) !== cents) throw new Error("write verification failed: total budget not saved");
        if (!cents) return "🗑️ Limite total do mês removido.";
        return [`📊 *Limite total:* ${brl(cents)} por mês`, ...(await budgetStatus(ctx.db, today, [], cents))].join("\n");
      }
      const cats = await listExpenseCategories(ctx.db);
      const cat = findExpenseCategory(cats, a.category);
      if (!cat) return `❓ Não tenho a categoria de gasto “${a.category}”. Categorias: ${cats.map((c) => `${c.emoji} ${c.name}`).join(", ")}.`;
      await setCategoryBudget(ctx.db, cat.slug, cents);
      if (!cents) return `🗑️ Limite de ${cat.emoji} ${cat.name} removido.`;
      const status = await budgetStatus(ctx.db, today, [cat.slug], null);
      return `📊 *Limite de ${cat.emoji} ${cat.name}:* ${brl(cents)} por mês\n${status.join("\n")}\n_Aviso quando chegar em 80% e quando estourar._`;
    }
    case "list_budgets": {
      const p = await loadProfile(ctx.db);
      return formatBudgets(ctx.db, localDate(new Date(), ctx.tz), p?.expenseBudget ?? null);
    }
    case "settings": {
      const patch: ProfilePatch = {};
      if (a.morning_at) patch.morningAt = a.morning_at;
      if (a.evening_at) patch.eveningAt = a.evening_at;
      if (a.reminder_minutes != null) patch.defaultReminder = a.reminder_minutes;
      if (a.task_nag_minutes != null) patch.taskNagMinutes = nagMinutes(a.task_nag_minutes);
      if (a.expense_daily != null) patch.expenseDaily = a.expense_daily;
      if (a.expense_at) patch.expenseAt = a.expense_at;
      if (a.timezone) {
        if (!validTimezone(a.timezone)) return `❓ Não reconheci o fuso “${a.timezone}”. Manda a cidade (ex: _meu fuso é São Paulo_).`;
        patch.tz = a.timezone;
      }
      const cur = {
        tz: ctx.tz,
        morningAt: ctx.user?.morningAt ?? "07:00",
        eveningAt: ctx.user?.eveningAt ?? "21:00",
        defaultReminder: ctx.defaultReminder,
        taskNagMinutes: ctx.taskNagMinutes ?? 0,
        expenseAt: ctx.user?.expenseAt ?? "22:30",
        expenseDaily: ctx.user?.expenseDaily ?? true,
      };
      if (Object.keys(patch).length) await updateProfile(ctx.db, patch);
      const p = Object.keys(patch).length ? await loadProfile(ctx.db) : null;
      const s = {
        tz: p?.tz ?? cur.tz,
        morningAt: p?.morningAt ?? cur.morningAt,
        eveningAt: p?.eveningAt ?? cur.eveningAt,
        defaultReminder: p?.defaultReminder ?? cur.defaultReminder,
        taskNagMinutes: p?.taskNagMinutes ?? cur.taskNagMinutes,
        expenseAt: p?.expenseAt ?? cur.expenseAt,
        expenseDaily: p?.expenseDaily ?? cur.expenseDaily,
      };
      const head = Object.keys(patch).length ? "⚙️ *Configuração salva*" : "⚙️ *Suas configurações*";
      return `${head}
☀️ resumo do dia: ${s.morningAt}
🌙 prévia de amanhã: ${s.eveningAt}
⏰ lembrete padrão: ${s.defaultReminder ? `${s.defaultReminder} min antes` : "sem lembrete"}
🔔 cobrança de tarefas: ${s.taskNagMinutes ? `a cada ${s.taskNagMinutes} min` : "desligada (_me cobra a cada 30 min_ liga)"}
💸 gastos do dia: ${s.expenseDaily ? s.expenseAt : "desligado (_liga o resumo de gastos_)"} · semana (dom) e mês (último dia) às ${s.expenseAt}
🌎 fuso: ${s.tz}`;
    }
    case "calendar_link":
      if (!ctx.user?.guest) return "📅 Sua agenda fica no iCloud: ela já aparece no Calendário do iPhone, Mac e Watch.";
      if (!ctx.user.feedUrl) return "❓ Ainda não tenho o link da sua agenda. Manda o código de convite de novo que eu gero.";
      return `📅 *Sua agenda no celular* (só leitura, atualiza sozinha):
${ctx.user.feedUrl}

• iPhone: toca no link → _Assinar_.
• Google Agenda (pelo computador): Configurações → Adicionar agenda → _Do URL_, colando o link com https:// no lugar de webcal://.`;
    case "unknown":
      return HELP_TEXT;
  }
}

type ExpenseAction = Extract<Action, { type: "add_expense" }>;
type ExpenseChanges = Extract<Action, { type: "update_expense" }>["changes"];

/** Log a spend, check its shopping items off, show the limits it touches. */
async function addExpenseAction(ctx: AppCtx, a: ExpenseAction, turn: Turn): Promise<string> {
  const today = localDate(new Date(), ctx.tz);
  const amount = toCents(a.amount);
  if (!amount) throw new UserError("Não entendi o valor.");
  const spentOn = a.date ?? today;
  if (spentOn > today) throw new UserError("Gasto não pode ser numa data futura. Pra lembrar de pagar algo, use tarefa (_me lembra de pagar … sexta_).");
  const cats = await listExpenseCategories(ctx.db);
  const cat = findExpenseCategory(cats, a.category) ?? defaultExpenseCategory(cats);
  if (!cat) throw new Error("no expense categories");
  const description = cleanDescription(a.description);
  const { row } = await addExpense(ctx.db, expenseId(ctx.sourceMessageId, description, amount), { amount, description, category: cat.slug, spentOn });
  const extra: string[] = [];
  if (a.shopping_items?.length) {
    const open = await openItems(ctx.db);
    const hits = a.shopping_items.map((n) => findItem(open, n)).filter((h) => h.length === 1).map((h) => h[0]!);
    const unique = [...new Set(hits)];
    if (unique.length) {
      await markBought(ctx.db, unique.map((i) => i.id));
      const left = await openItems(ctx.db);
      extra.push(`🛒 Tirei da lista: ${joinNames(unique)}${left.length ? ` · falta ${left.length}` : " · lista zerada ✨"}`);
    }
  }
  const head = await expenseSaved(ctx, [row], turn, "💸 *Anotado*");
  return [head, ...extra].join("\n");
}

/** Confirmation re-read from the DB + the limits the rows touch. */
async function expenseSaved(ctx: AppCtx, rows: Expense[], turn: Turn, head: string): Promise<string> {
  const today = localDate(new Date(), ctx.tz);
  const cats = await listExpenseCategories(ctx.db);
  const fresh: Expense[] = [];
  for (const r of rows) {
    const row = await getExpense(ctx.db, r.id);
    if (!row) throw new Error(`write verification failed: expense ${r.id} not found`);
    fresh.push(row);
  }
  turn.next.expenses = pushExpenses(turn.next.expenses ?? [], fresh.map((e) => toExpenseRef(e, today)).reverse());
  turn.next.lastList = "expenses";
  const lines = fresh.map((e) => {
    const c = categoryOf(e, cats);
    return `${head}: ${brl(e.amount)} · ${c?.emoji ?? "💸"} ${c?.name ?? e.category}\n${e.description} · ${dayLabel(e.spentOn, today)}`;
  });
  const p = await loadProfile(ctx.db);
  const limits: string[] = [];
  for (const month of new Set(fresh.map((e) => e.spentOn.slice(0, 7)))) {
    const inMonth = fresh.filter((e) => e.spentOn.startsWith(month));
    const day = inMonth[0]!.spentOn;
    limits.push(...(await budgetStatus(ctx.db, day, inMonth.map((e) => categoryOf(e, cats)?.slug ?? e.category), p?.expenseBudget ?? null)));
  }
  return [...lines, ...limits].join("\n");
}

/** "Gastos de hoje" · "Gastos de novembro" · "Gastos de 17/11 a 23/11 · 🛒 Mercado" */
function expenseTitle(from: string, to: string, today: string, what: string | null): string {
  let when: string;
  if (from === to) when = from === today ? "de hoje" : `de ${dayLabel(from, today)}`;
  else if (from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7)) when = `de ${monthName(from)}${to === today ? " (até hoje)" : ""}`;
  else when = `de ${shortDatePt(from)} a ${shortDatePt(to)}`;
  return `Gastos ${when}${what ? ` · ${what}` : ""}`;
}

/** Same rules as tasks: a name wins over a ref; several matches → numbered question (G1…). */
async function resolveExpense(
  ctx: AppCtx,
  a: { ref?: string | null; search?: string | null; on_date?: string | null },
  turn: Turn,
  pick: PendingPick,
): Promise<Expense | { reply: string }> {
  const today = localDate(new Date(), ctx.tz);
  const cats = await listExpenseCategories(ctx.db);
  if (a.search) {
    const matches = await searchExpenses(ctx.db, a.search, today, a.on_date);
    if (matches.length === 1) return matches[0]!;
    if (!matches.length) return { reply: `❓ Não achei nenhum gasto com “${a.search}”${a.on_date ? ` em ${shortDatePt(a.on_date)}` : " nos últimos 90 dias"}. Nada foi alterado.` };
    const shown = matches.slice(0, 9);
    turn.next.expenses = shown.map((e) => toExpenseRef(e, today));
    turn.next.lastList = "expenses";
    turn.next.pick = pick;
    return {
      reply: `❓ Achei ${matches.length} gastos com “${a.search}”. Qual? (responde com o número)\n${shown.map((e, i) => `${i + 1}. ${expenseLine(e, cats, today)}`).join("\n")}`,
    };
  }
  if (a.ref) {
    const n = Number(/^G?(\d+)$/i.exec(a.ref.trim())?.[1]);
    const ref = turn.shownExpenses[n - 1];
    if (!ref) return { reply: "❓ Não sei qual gasto. Manda com o nome (ex: _apaga o gasto do uber_) ou peça _gastos de hoje_." };
    const e = await getExpense(ctx.db, ref.expenseId);
    if (!e) return { reply: `❓ *${ref.label.split(" · ")[0]}* não existe mais. Nada foi alterado.` };
    return e;
  }
  return { reply: "❓ Não sei qual gasto. Manda com o nome (ex: _apaga o gasto do uber_) ou peça _gastos de hoje_." };
}

/**
 * Category slug for a task. Unknown/missing → the default category (on
 * create), or null when `fallback` is false (explicit move or filter).
 */
async function taskCategorySlug(ctx: AppCtx, raw: string | null | undefined, fallback = true): Promise<string | null> {
  const cats = await ctx.store.listCategories();
  const want = raw ? slugify(raw) : null;
  const hit = want ? (cats.find((c) => c.slug === want) ?? cats.find((c) => slugify(c.name) === want)) : null;
  if (hit) return hit.slug;
  if (!fallback) return null;
  return defaultCategory(cats)?.slug ?? null;
}

type TaskChanges = Extract<Action, { type: "update_task" }>["changes"];

/**
 * Same rules as events: a name (search) wins over a ref; several matches →
 * numbered question, and the list becomes T1… for the answer.
 */
async function resolveTask(
  ctx: AppCtx,
  a: { ref?: string | null; search?: string | null },
  turn: Turn,
  pick: PendingPick,
): Promise<Task | { reply: string }> {
  const today = localDate(new Date(), ctx.tz);
  if (a.search) {
    const matches = await searchTasks(ctx.db, a.search);
    if (matches.length === 1) return matches[0]!;
    if (!matches.length) return { reply: `❓ Não achei nenhuma tarefa aberta com “${a.search}”. Nada foi alterado.` };
    const shown = matches.slice(0, 9);
    turn.next.tasks = shown.map((t) => toTaskRef(t, today));
    turn.next.lastList = "tasks";
    turn.next.pick = pick;
    return {
      reply: `❓ Achei ${matches.length} tarefas com “${a.search}”. Qual delas? (responde com o número)\n${shown.map((t, i) => `${i + 1}. ${taskLine(t, today)}`).join("\n")}`,
    };
  }
  if (a.ref) {
    const n = Number(/^T?(\d+)$/i.exec(a.ref.trim())?.[1]);
    const ref = turn.shownTasks[n - 1];
    if (!ref) return { reply: "❓ Não sei qual tarefa. Manda com o nome (ex: _feito o boleto_) ou peça _tarefas_ pra ver a lista." };
    const t = await getTask(ctx.db, ref.taskId);
    if (!t || t.status !== "open") return { reply: `❓ *${ref.label.split(" — ")[0]}* não está mais aberta. Nada foi alterado.` };
    return t;
  }
  return { reply: "❓ Não sei qual tarefa. Manda com o nome (ex: _feito o boleto_) ou peça _tarefas_ pra ver a lista." };
}

/** Same title + same start already saved → don't duplicate (e.g. model re-creating a focus event). */
async function findDuplicate(ctx: AppCtx, input: EventInput): Promise<string | null> {
  const startAt = localToUtc(input.start, ctx.tz);
  const occ = await ctx.store.findOccurrences(startAt, new Date(startAt.getTime() + 60_000));
  const title = normText(input.title);
  const hit = occ.find(
    (o) => o.start.getTime() === startAt.getTime() && o.event.allDay === input.allDay && normText(o.event.title) === title,
  );
  return hit?.event.id ?? null;
}

/** Next upcoming occurrence of an event (or its first one), as a focus item. */
async function focusForEvent(ctx: AppCtx, eventId: string): Promise<FocusItem | null> {
  const ev = await ctx.store.getEvent(eventId);
  if (!ev) return null;
  const now = new Date();
  const occ = ev.recurrence
    ? (await ctx.store.findOccurrences(now, new Date(now.getTime() + 60 * 86_400_000))).find((o) => o.event.id === eventId)
    : undefined;
  const start = occ?.start ?? ev.startAt;
  const end = occ?.end ?? ev.endAt;
  return toFocus({ event: ev, category: ev.category, start, end }, ctx.tz);
}

/**
 * A named event (search) always wins over a ref: if the user said the name
 * and several events match, they get asked which one instead of the model
 * silently picking the most recent.
 */
async function resolveRefOrSearch(
  ctx: AppCtx,
  a: { ref?: string | null; search?: string | null; on_date?: string | null },
  turn: Turn,
  pick: PendingPick,
): Promise<OccurrenceView | { reply: string }> {
  if (a.search) return resolveTarget(ctx, a.search, a.on_date ?? undefined, turn, pick);
  if (a.ref) {
    const n = Number(/^E?(\d+)$/i.exec(a.ref.trim())?.[1]);
    const item = turn.shown[n - 1];
    if (!item) return { reply: "❓ Não sei qual evento. Manda com o nome (ex: _muda o dentista pra 16h_)." };
    const ev = await ctx.store.getEvent(item.eventId);
    if (!ev) return { reply: `❓ *${item.label.split(" — ")[0]}* não existe mais. Nada foi alterado.` };
    const start = new Date(item.occurrenceStart);
    return { event: ev, category: ev.category, start, end: new Date(start.getTime() + (ev.endAt.getTime() - ev.startAt.getTime())) };
  }
  return { reply: "❓ Não sei qual evento. Manda com o nome (ex: _muda o dentista pra 16h_)." };
}

function createInput(ctx: AppCtx, a: Extract<Action, { type: "create" }>, date: string): EventInput {
  const allDay = !a.start_time;
  let end: string | null = null;
  if (allDay) end = a.last_date ?? null;
  else if (a.end_time) {
    // "22h às 2h" crosses midnight.
    const endDay = a.end_time <= a.start_time! ? addDays(a.last_date ?? date, a.last_date ? 0 : 1) : (a.last_date ?? date);
    end = `${endDay}T${a.end_time}`;
  } else if (a.last_date) end = `${a.last_date}T23:59`;

  return {
    title: a.title,
    start: allDay ? date : `${date}T${a.start_time}`,
    end,
    allDay,
    category: a.category ? slugify(a.category) : null,
    location: a.location ?? null,
    notes: a.notes ?? null,
    recurrence: cleanRecurrence(a.recurrence),
    reminderMinutes: reminder(a.reminder_minutes),
    sourceMessageId: ctx.sourceMessageId,
  };
}

function cleanRecurrence(r: Extract<Action, { type: "create" }>["recurrence"]): Recurrence | null {
  if (!r) return null;
  return {
    freq: r.freq,
    ...(r.interval ? { interval: r.interval } : {}),
    ...(r.byWeekday?.length ? { byWeekday: r.byWeekday } : {}),
    ...(r.until ? { until: r.until } : {}),
    ...(r.count ? { count: r.count } : {}),
  };
}

/** null/undefined → default; 0 ("sem lembrete") → none. */
function reminder(v: number | null | undefined): number | null | undefined {
  if (v == null) return undefined;
  return v === 0 ? null : v;
}

type Changes = Extract<Action, { type: "update" }>["changes"];

function stripNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;
}

/** Merge partial date/time changes ("pra 16h", "pra sexta") with the event's current values. */
function updatePatch(ctx: AppCtx, ev: OccurrenceView["event"], c: Changes): Partial<EventInput> {
  const patch: Partial<EventInput> = {};
  if (c.title) patch.title = c.title;
  if (c.category) patch.category = slugify(c.category);
  if (c.location) patch.location = c.location;
  if (c.notes) patch.notes = c.notes;
  if (c.reminder_minutes != null) patch.reminderMinutes = reminder(c.reminder_minutes);

  const timing = c.date || c.start_time || c.end_time || c.all_day != null || c.last_date;
  if (!timing) return patch;

  const curStartDate = localDate(ev.startAt, ctx.tz);
  const curLastDate = localDate(new Date(ev.endAt.getTime() - 1), ctx.tz);
  const allDay = c.all_day ?? (c.start_time ? false : ev.allDay);
  const date = c.date ?? curStartDate;

  if (allDay) {
    const span = diffDays(curStartDate, curLastDate);
    patch.allDay = true;
    patch.start = date;
    patch.end = c.last_date ?? (ev.allDay ? addDays(date, span) : date);
    return patch;
  }

  const startTime = c.start_time ?? (ev.allDay ? null : localTime(ev.startAt, ctx.tz));
  if (!startTime) throw new UserError("Pra tirar do dia todo preciso do horário (ex: \"muda pra 15h\").");
  const start = `${date}T${startTime}`;
  let end: string;
  if (c.end_time) {
    end = `${c.end_time <= startTime ? addDays(date, 1) : date}T${c.end_time}`;
  } else {
    const duration = ev.allDay ? 60 * 60_000 : ev.endAt.getTime() - ev.startAt.getTime();
    end = localDateTime(new Date(localToUtc(start, ctx.tz).getTime() + duration), ctx.tz);
  }
  patch.allDay = false;
  patch.start = start;
  patch.end = end;
  return patch;
}

const STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "com", "e", "na", "no", "pra", "para", "minha", "meu"]);

/** Events whose title matches the search, one occurrence each (next upcoming, else latest past). */
async function searchEvents(ctx: AppCtx, search: string, onDate?: string | null): Promise<OccurrenceView[]> {
  const today = localDate(new Date(), ctx.tz);
  const from = onDate ?? addDays(today, -60);
  const to = onDate ? addDays(onDate, 1) : addDays(today, 400);
  const occ = matchTitles(
    await ctx.store.findOccurrences(localToUtc(from, ctx.tz), localToUtc(to, ctx.tz)),
    (o) => o.event.title,
    search,
    STOPWORDS,
  );
  const nowMs = Date.now();
  const byEvent = new Map<string, OccurrenceView>();
  for (const o of occ) {
    const cur = byEvent.get(o.event.id);
    const upcoming = o.end.getTime() > nowMs;
    if (!cur || (upcoming && cur.end.getTime() <= nowMs) || (!upcoming && cur.end.getTime() <= nowMs && o.start > cur.start)) {
      byEvent.set(o.event.id, o);
    }
  }
  return [...byEvent.values()];
}

/**
 * The model sometimes picks the wrong kind ("muda a doação de sangue" →
 * update_task because a task mentions "doação"). When a named search finds
 * nothing of the kind asked but does find the other kind, act on that one.
 */
async function crossKind(ctx: AppCtx, a: Action): Promise<Action | null> {
  // "comprei o presente" said as a purchase but it's a task, not a list item.
  if (a.type === "bought" && !a.all && a.items?.length === 1) {
    const name = a.items[0]!;
    if (findItem(await openItems(ctx.db), name).length || !(await searchTasks(ctx.db, name)).length) return null;
    return { type: "complete_task", ref: null, search: name };
  }
  if (!("search" in a) || !a.search || ("ref" in a && a.ref)) return null;
  const search = a.search;
  switch (a.type) {
    case "complete_task": {
      // "comprei leite" read as a task, but it's on the shopping list.
      if ((await searchTasks(ctx.db, search)).length || !findItem(await openItems(ctx.db), search).length) return null;
      return { type: "bought", items: [search], all: false };
    }
    case "update_task":
    case "delete_task": {
      if ((await searchTasks(ctx.db, search)).length) return null;
      if (a.type === "delete_task" && findItem(await openItems(ctx.db), search).length) {
        return { type: "remove_shopping", items: [search] };
      }
      if (!(await searchEvents(ctx, search)).length) return null;
      if (a.type === "delete_task") return { type: "delete", ref: null, search, on_date: null, only_that_day: null };
      const c = a.changes;
      return {
        type: "update",
        ref: null,
        search,
        on_date: null,
        changes: { title: c.title, date: c.due_date, start_time: c.due_time, notes: c.notes },
      };
    }
    case "update":
    case "delete": {
      if ((await searchEvents(ctx, search, a.on_date)).length || !(await searchTasks(ctx.db, search)).length) return null;
      if (a.type === "delete") return { type: "delete_task", ref: null, search };
      const c = a.changes;
      return { type: "update_task", ref: null, search, changes: { title: c.title, due_date: c.date, due_time: c.start_time, notes: c.notes } };
    }
    default:
      return null;
  }
}

/**
 * Find the single event the user means. Deterministic: all search words must
 * appear in the title. Prefers upcoming occurrences. Zero or several matches
 * → a reply explaining it, nothing is changed.
 */
async function resolveTarget(
  ctx: AppCtx,
  search: string,
  onDate: string | undefined,
  turn: Turn,
  pick: PendingPick,
): Promise<OccurrenceView | { reply: string }> {
  const matches = await searchEvents(ctx, search, onDate);
  const where = onDate ? ` em ${shortDatePt(onDate)}` : "";

  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    return { reply: `❓ Não achei nenhum evento com “${search}”${where}. Nada foi alterado.` };
  }
  // The numbered list becomes the focus, so "o 2" next message maps to E2.
  const shown = matches.slice(0, 9);
  turn.next.focus = shown.map((o) => toFocus(o, ctx.tz));
  turn.next.lastList = "events";
  turn.next.pick = pick;
  const list = shown
    .map((o, i) => `${i + 1}. ${formatLine(o, localDate(o.start, ctx.tz), ctx.tz)} — ${shortDatePt(localDate(o.start, ctx.tz))}`)
    .join("\n");
  return {
    reply: `❓ Achei ${matches.length} eventos com “${search}”${where}. Qual deles? (responde com o número)\n${list}`,
  };
}
