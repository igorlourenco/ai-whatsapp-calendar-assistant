import { z } from "zod";

import { addDays, humanDatePt, localDate, localTime } from "../time";
import { completeJson, type DeepSeekEnv } from "./deepseek";
import type { State } from "./state";

/*
 * The model's ONLY job: turn one WhatsApp message into a list of actions.
 * No history, no tools, no free text. Everything the user reads is built by
 * code (execute.ts) from the database.
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
/** Model may send null or omit: both mean "not given". */
const opt = <T extends z.ZodType>(s: T) => s.nullish();

const recurrence = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: opt(z.number().int().min(1)),
  byWeekday: opt(z.array(z.number().int().min(0).max(6))),
  until: opt(ymd),
  count: opt(z.number().int().min(1)),
});

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    title: z.string().min(1),
    /** Missing → code stores a draft and asks for it. */
    date: opt(ymd),
    start_time: opt(hhmm),
    end_time: opt(hhmm),
    last_date: opt(ymd),
    category: opt(z.string()),
    location: opt(z.string()),
    notes: opt(z.string()),
    recurrence: opt(recurrence),
    reminder_minutes: z.number().int().min(0).nullish(),
  }),
  z.object({
    type: z.literal("update"),
    /** "E1"… from the focus list, when the user refers to a recent event. */
    ref: opt(z.string()),
    search: opt(z.string()),
    on_date: opt(ymd),
    changes: z.object({
      title: opt(z.string().min(1)),
      date: opt(ymd),
      start_time: opt(hhmm),
      end_time: opt(hhmm),
      all_day: opt(z.boolean()),
      last_date: opt(ymd),
      category: opt(z.string()),
      location: opt(z.string()),
      notes: opt(z.string()),
      reminder_minutes: z.number().int().min(0).nullish(),
    }),
  }),
  z.object({
    type: z.literal("delete"),
    ref: opt(z.string()),
    search: opt(z.string()),
    on_date: opt(ymd),
    only_that_day: opt(z.boolean()),
  }),
  z.object({
    type: z.literal("query"),
    from: ymd,
    to: ymd,
    category: opt(z.string()),
    search: opt(z.string()),
  }),
  z.object({ type: z.literal("create_category"), name: z.string().min(1), emoji: z.string().min(1) }),
  z.object({ type: z.literal("unknown") }),
]);

export const extractionSchema = z.object({ actions: z.array(actionSchema).min(1) });
export type Action = z.infer<typeof actionSchema>;

function contextBlock(state: State): string {
  const parts: string[] = [];
  if (state.draft) {
    parts.push(`Pedido incompleto aguardando dados (falta: data):
${JSON.stringify(state.draft)}
→ Se a mensagem atual traz o que falta (ex: "sexta 15h", "dia 20"), gere UM "create" com os campos acima + os novos.
→ Se a mensagem atual é outro pedido, ignore o rascunho.`);
  }
  if (state.pick) {
    const what =
      state.pick.action === "delete"
        ? "APAGAR"
        : `ALTERAR (mudanças: ${JSON.stringify(state.pick.changes)})`;
    parts.push(`Pergunta pendente: o usuário precisa escolher QUAL evento da lista abaixo ${what}.
→ Se a mensagem escolhe um (número "2", "o segundo", dia "a de quinta", descrição), gere ${state.pick.action === "delete" ? '{"type":"delete","ref":"E<n>"}' : '{"type":"update","ref":"E<n>","changes":{}}'} para o escolhido (pode ser mais de um se ele escolher vários).
→ Se a mensagem é outro pedido, ignore a pergunta.`);
  }
  if (state.focus.length) {
    parts.push(`Eventos citados recentemente (já estão salvos; NUNCA crie de novo):
${state.focus.map((f, i) => `E${i + 1} = ${f.label}`).join("\n")}
→ Use "ref":"E<n>" em update/delete SÓ quando a mensagem pede para mudar/apagar algo já citado: verbo de mudança ("muda", "troca", "passa pra", "adia", "antecipa", "na verdade é", "corrige", "me lembra… antes", "cancela", "apaga") ou referência sem nome ("pra 16h", "esse", "ele", "o 2", "o de quinta", "a de terça").
→ Se a mensagem diz o NOME do evento ("cancela a aula de inglês", "muda o dentista pra 16h"), preencha search com o nome (e on_date se disser o dia) e deixe ref null, mesmo que ele esteja na lista. ref é só para quando NÃO há nome.
→ Mensagem que descreve um compromisso completo (o quê + quando, ex: "aula de inglês quinta 18h") é SEMPRE um evento NOVO (create), mesmo com nome igual/parecido a um da lista.
→ Sem outra pista, "esse/ele/pra 16h" = E1. Número citado ("o 2", "o segundo") = E2. Descrição ("a de quinta") = o item da lista que bate com ela.`);
  }
  return parts.length ? `\nContexto atual (estado do sistema, não é conversa):\n${parts.join("\n\n")}\n` : "";
}

export function buildPrompt(
  now: Date,
  tz: string,
  categories: { slug: string; emoji: string; name: string }[],
  state: State = { draft: null, focus: [] },
) {
  const today = localDate(now, tz);
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = addDays(today, i);
    return `${d} = ${humanDatePt(d)}${i === 0 ? " (hoje)" : i === 1 ? " (amanhã)" : ""}`;
  }).join("\n");
  const cats = categories.map((c) => `${c.slug} (${c.emoji} ${c.name})`).join(", ") || "(nenhuma)";

  // Static rules first, everything that changes per call (time, dates,
  // categories, context) last: DeepSeek bills a repeated prompt PREFIX at the
  // cheaper cache-hit rate, so the fixed part must come before the variable one.
  return `Você converte UMA mensagem de WhatsApp em ações de agenda, em JSON. Não converse. Não explique. Responda só o JSON.

Datas: use SEMPRE a tabela de datas no final para "hoje", "sexta", "sábado que vem", "semana que vem"; nunca calcule dia da semana de cabeça. Datas sem ano: a próxima ocorrência a partir de hoje.

Categoria: use um slug da lista no final, a que melhor encaixa (faculdade = aulas, provas, trabalhos, compromissos acadêmicos; trabalho = emprego/reuniões; pessoal = resto). Se o usuário citar explicitamente uma categoria que não existe, use create_category antes do create.

Formato: {"actions": [ ... ]} com um ou mais itens:

1. Salvar compromisso (qualquer mensagem que descreve algo a fazer/ir, mesmo sem "salva/marca", ex: "dia 19 tenho dentista 9h"):
{"type":"create","title":"Dentista","date":"YYYY-MM-DD"|null,"start_time":"HH:mm"|null,"end_time":"HH:mm"|null,"last_date":"YYYY-MM-DD"|null,"category":"slug"|null,"location":null,"notes":null,"recurrence":null,"reminder_minutes":null}
- Sem horário → start_time null (dia todo). Vários dias ("de 20 a 23") → date=primeiro, last_date=último, sem horário.
- Repetição ("toda terça e quinta") → recurrence {"freq":"weekly","byWeekday":[2,4]} (0=dom … 6=sáb), date = primeira ocorrência a partir de hoje. "até 15/12" → "until":"YYYY-MM-DD". Aniversário → {"freq":"yearly"}.
- reminder_minutes só se pedir ("me lembra 1h antes" = 60, "sem lembrete" = 0); senão null.
- title curto e limpo, primeira letra maiúscula, sem data/hora.
- Sem data nenhuma ("marca dentista") → date null (o sistema pergunta). Nunca invente data.

2. Alterar: {"type":"update","ref":"E1"|null,"search":"palavra-chave do evento"|null,"on_date":"YYYY-MM-DD"|null,"changes":{"title":null,"date":null,"start_time":null,"end_time":null,"all_day":null,"last_date":null,"category":null,"location":null,"notes":null,"reminder_minutes":null}}
- Use ref quando for um evento do contexto; senão search = 1 a 3 palavras do nome (ex: "jantar ana"). Em changes, preencha só o que muda. "Me lembra X antes" de um evento existente = update com reminder_minutes.

3. Apagar/cancelar: {"type":"delete","ref":"E1"|null,"search":"palavra-chave"|null,"on_date":"YYYY-MM-DD"|null,"only_that_day":true|false}
- only_that_day=true quando é evento que se repete e o usuário fala de um dia ("cancela a aula de quarta").

4. Consultar ("o que tenho hoje/amanhã/sábado/semana que vem"): {"type":"query","from":"YYYY-MM-DD","to":"YYYY-MM-DD","category":null,"search":null}
- "semana que vem" = segunda a domingo da próxima semana. "essa semana" = hoje até domingo. "mês" = hoje até o fim do mês.

5. Criar categoria: {"type":"create_category","name":"Academia","emoji":"🏋️"}
6. Qualquer outra coisa (cumprimento, pergunta fora de agenda, mensagem incompreensível): {"type":"unknown"}

Uma mensagem com vários pedidos gera várias ações, na ordem.

--- Dados atuais (do mais estável ao mais variável) ---
Tabela de datas:
${days}

Categorias: ${cats}

Agora: ${today} ${localTime(now, tz)} (${tz}).
${contextBlock(state)}`;
}

/** One stateless call. Retries once on malformed output, then throws (inbox retries / reports). */
export async function extractActions(
  env: DeepSeekEnv,
  text: string,
  ctx: { now: Date; tz: string; categories: { slug: string; emoji: string; name: string }[]; state?: State },
): Promise<Action[]> {
  const prompt = buildPrompt(ctx.now, ctx.tz, ctx.categories, ctx.state);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await completeJson(env, prompt, text);
    const parsed = extractionSchema.safeParse(raw);
    if (parsed.success) return parsed.data.actions;
    lastError = JSON.stringify(parsed.error.issues).slice(0, 500);
    console.warn("[extract] invalid output", { raw, lastError });
  }
  throw new Error(`extraction failed: ${lastError}`);
}
