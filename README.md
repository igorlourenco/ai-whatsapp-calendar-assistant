# WhatsApp Calendar Assistant

Manage your **Apple Calendar** and your **to-dos** by texting yourself on **WhatsApp**. Write like you'd write to a friend, and the assistant saves, moves, cancels and lists events in your iCloud calendars, keeps a to-do list (that can nag you until you say it's done), and every morning sends you the day's agenda.

> The assistant talks **Brazilian Portuguese** (prompts, replies and digests). Code and docs are in English.

```
você: dentista sexta 15h
bot:  ✅ Salvo na agenda
      🏠 Dentista
      🗓️ sexta, 20 de novembro · 15:00–16:00
      ⏰ lembrete 30 min antes

você: aula de inglês toda terça e quinta 19h às 21h até dezembro
bot:  ✅ Salvo na agenda
      🎓 Aula de inglês
      🗓️ terça, 17 de novembro · 19:00–21:00
      🔁 toda semana (ter, qui) até 31/12

você: muda pra 20h
bot:  ✏️ Atualizado …

você: o que tenho amanhã?
bot:  🗓️ Terça, 17 de novembro
      🎓 19:00–21:00 Aula de inglês
```

## Features

- **Natural language → calendar.** One-off, all-day, multi-day ("de 20 a 23") and recurring events, edits, cancellations (whole series or a single day), queries ("o que tenho sábado?", "semana que vem").
- **Your Apple Calendar is the source of truth.** Events are read and written directly in iCloud over CalDAV, so they show up on your iPhone, Mac and Watch. Events you create on the iPhone show up in queries and digests too.
- **Categories = iCloud calendars** (e.g. Work 💼, School 🎓, Personal 🏠), each with an emoji and a description the AI uses to pick one.
- **Tasks (to-dos), in lists.** "me lembra de pagar o boleto sexta", "ligar pro banco amanhã 10h", "pagar aluguel todo dia 5". A task with no date gets a "pra quando?"; for things with no deadline say so ("algum dia quero aprender violão", "trocar o filtro do ar, sem data", or answer `sem data` to the question) and it stays on the list undated, without nags or digests, until `feito`. `deixa o banco sem data` takes the date off one. Tasks show up in the morning digest. Nagging is **off by default**: `me cobra das tarefas a cada 30 min` turns it on (any interval, min 5 min), `para de me cobrar` turns it off. When on, from its time (or one interval after the morning digest, for date-only tasks) you get a WhatsApp message every N min listing what's still pending, until you answer `feito`. Overdue tasks keep nagging the next days; nothing is sent after 22:00. Tasks use the same categories as events, so each category is also a task list: "entregar trabalho de penal sexta" lands in 🎓 Estudos, `tarefa de casa: trocar lâmpada` / `põe na lista Mercado: …` pick (or create) one. `tarefas` lists them grouped by list (numbering continues across groups), `tarefas da faculdade` shows one list, `muda o relatório pra trabalho` moves one, `feito 2` / `feito todas` / `paguei o boleto` checks off (a repeating one moves to its next date), `adia o banco pra sexta` reschedules, and several at once: `as atrasadas vou fazer às 13h`, `passa as de hoje pra amanhã`, `joga as da faculdade pra sexta`, `todas essas pra segunda 9h`.
- **Shopping list.** "compra leite, ovos e pão", "acabou o café" → one list, no dates, no nags. `lista` shows it, `comprei o leite` / `comprei tudo` checks off, `tira o café da lista` removes. A purchase with a date ("comprar presente da Ana até sexta") or "me lembra de…" stays a task.
- **Private: only people you add.** There is no public signup. `pnpm db add-user 5511987654321 "Ana"` gives someone access (silently: the bot never writes first, so tell them to message it). Every user gets their own agenda, tasks, shopping list, digests and reminders, fully separate from yours. Their events live in the bot and show up on their phone through a read-only calendar link (iPhone: tap → *Assinar*; Google Calendar: *Add calendar → From URL*). `resumo às 8h`, `lembrete padrão 1h antes`, `moro em Lisboa` change their own settings; `link da agenda` re-sends the link.
- **…or with their own iCloud, two-way.** `pnpm connect-icloud` (you, from the terminal, with their Apple ID and an app-specific password), connects someone's iCloud just like yours: what the bot saves shows up in their Apple Calendar and what they add there, the bot sees. The password goes from your terminal to the worker over HTTPS, is stored AES-GCM-encrypted (`CREDENTIALS_KEY`), and never passes through WhatsApp or the model. Registers them if needed; events they already had in the bot are moved into their iCloud.
- **Photos and screenshots.** Send an exam schedule, an event flyer, a chat screenshot or a photo of a note: the bot reads it and replies with a numbered preview (`📷 Encontrei 4 eventos… Salvo? sim / não / 1,3`). Nothing from an image is saved until you confirm.
- **Voice notes.** Talk instead of typing: the bot transcribes the audio (Whisper on Workers AI), echoes what it heard (`🎤 _marca dentista sexta às 15h_`) and handles it exactly like a typed message, including answering an image preview (`sim`, `só o dois`). Deletes still need an explicit word ("cancela", "apaga"), so a misheard note can't remove anything.
- **Follow-ups without a chat log.** "marca oftalmo" → "❓ qual dia?" → "dia 10 às 15h". "muda pra 16h" / "apaga esse" right after saving. "Achei 2… qual?" → "o 2".
- **Daily digests** (morning agenda + tasks, evening preview) and **event reminders** both as native iPhone alerts and WhatsApp messages.
- **Never lies about saving.** The model only outputs structured actions; every reply is generated by code, and "✅ Salvo" is only sent after the event is re-read from iCloud. Messages go through a durable inbox with retries; if one finally fails you're told exactly what was and wasn't saved.

## How it works

```
WhatsApp ─▶ Z-API ─▶ POST /webhooks/zapi?token=…  (OWNER_PHONE + users you added)
                         │      "registry" object: who joined + their calendar-feed tokens
                         ▼
          Scheduler Durable Object, one per person (embedded SQLite)
             │  durable inbox: in order, retries, explicit failure notice
             ├─ images: Workers AI vision transcribes → same extractor → preview
             ├─ voice notes: Workers AI Whisper transcribes → handled as typed text
             ├─ DeepSeek: one JSON-mode call per message → typed actions (zod)
             │    context = state built by code (pending draft, "which one?",
             │    recently touched events E1…), never a transcript
             ├─ executes against iCloud, re-reads to confirm, builds the reply
             └─ one alarm: next reminder / digest / pending message
                         │
                         ▼
          owner: iCloud (ICLOUD_*)  ·  connected users: their own iCloud (encrypted in their DO)
          others: events in their DO, served read-only at GET /cal/<token>.ics
          + DO SQLite (tasks, shopping list, inbox, state, send logs, categories, settings)
```

Everything runs on **one Cloudflare Worker** with one Durable Object per person. No database to provision.

## Requirements

| What | Why | Cost |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) account | Worker + Durable Object (SQLite) | Free plan is enough |
| [Z-API](https://z-api.io) instance connected to a WhatsApp number | Sending/receiving WhatsApp messages | Paid (per instance) |
| [DeepSeek](https://platform.deepseek.com) API key | Understanding messages | Pay-as-you-go (one ~2k-token call per message, mostly cached prefix) |
| Workers AI (same Cloudflare account) | Reading images, transcribing voice notes | Free plan's daily allowance covers personal use |
| Apple ID with an [app-specific password](https://support.apple.com/102654) | Reading/writing iCloud calendars | Free |
| Node.js 24 + pnpm | Setup and deploy | Free |

The bot talks **from** the Z-API number **to** your personal number (`OWNER_PHONE`). An instance you already use for something else works: every other sender is ignored, and setup asks before replacing an existing "on receive" webhook.

## Quick start

```sh
git clone https://github.com/<you>/ai-whatsapp-calendar-assistant
cd ai-whatsapp-calendar-assistant
pnpm install
npx wrangler login
pnpm configure
```

`pnpm configure` walks you through everything:

1. Asks for missing credentials and stores them in `.dev.vars` (git-ignored).
2. Validates DeepSeek, Z-API (instance connected?), iCloud and Cloudflare before touching anything.
3. Lists your iCloud calendars. You pick which become categories, with emoji, a short description ("aulas, provas…") and a default (saved to `calendars.json`, git-ignored).
4. Deploys the worker, uploads secrets and settings, saves the category mapping, points the Z-API webhook at the worker and optionally sends you a test message.

Re-run it anytime: it's idempotent. Use `pnpm configure --dry-run` to only validate, or `--yes` to accept defaults. To deploy under another worker name, change `"name"` in `wrangler.jsonc` **before the first deploy**.

## Using it

- `dentista sexta 15h` · `prova de penal dia 25` · `viagem de 20 a 23 de dezembro`
- `aula de civil toda terça e quinta 19h às 22h até 15/12`
- `o que tenho hoje?` · `e sábado?` · `semana que vem`
- `muda o dentista pra 16h` · `cancela a aula de quarta` · `me lembra 1h antes`
- `marca oftalmo` → *qual dia?* → `dia 10 às 15h`
- `cria categoria academia 🏋️` (creates a new iCloud calendar)
- `me lembra de ligar pro banco amanhã 10h` · `comprar ração hoje` · `pagar aluguel todo dia 5`
- `compra leite e ovos` · `lista` · `comprei o leite` · `comprei tudo` · `tira o café da lista`
- `tarefas` → `feito o 2` · `feito todas` · `paguei o boleto` · `adia o banco pra sexta` · `esquece a ração`
- `algum dia quero aprender violão` → saved undated · `deixa o banco sem data`
- 📷 a photo of a schedule → preview → `sim`, `não`, `1,3` or `todos menos 2`
- 🎤 a voice note saying any of the above

Text, voice notes and images. Not yet: PDFs (send a screenshot of the page).

## Configuration

Set in `.dev.vars`, uploaded by `pnpm configure` (defaults in `src/worker/config.ts`):

| Variable | Default | |
|---|---|---|
| `TIMEZONE` | your machine's zone | IANA name, e.g. `America/Sao_Paulo`, `Europe/Lisbon` |
| `MORNING_DIGEST_TIME` | `07:00` | Today's agenda |
| `EVENING_DIGEST_TIME` | `21:00` | Tomorrow's preview |
| `DEFAULT_REMINDER_MINUTES` | `30` | Native alert + WhatsApp reminder for timed events created by the bot |
| `DEEPSEEK_MODEL` | `deepseek-flash` | |
| `VISION_MODEL` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Workers AI model that reads images |
| `TRANSCRIBE_MODEL` | `@cf/openai/whisper-large-v3-turbo` | Workers AI model that transcribes voice notes (Ogg/Opus, up to ~2 MB) |
| `TASK_NAG_MINUTES` | `0` | Pending tasks are re-sent every N minutes (min 5); `0` = off. Each user can override it by message |
| `TASK_NAG_UNTIL` | `22:00` | No task nags after this time; they resume after the morning digest |
| `CREDENTIALS_KEY` | *(generated)* | 32 bytes base64. Encrypts users' iCloud passwords. Never change it after connecting someone (they'd need `pnpm connect-icloud` again) |

Everyone starts with these settings (and Pessoal/Trabalho/Estudos categories) and can change their own by message: `resumo às 8h`, `prévia às 22h`, `lembrete padrão 15 min antes`, `me cobra das tarefas a cada 20 min` / `para de me cobrar`, `meu fuso é Lisboa`, `minhas configurações`.

Settings are deliberately not in `wrangler.jsonc`, so pulling updates never overwrites your configuration.

## Operations

All app state, tasks included, lives in the Durable Object's SQLite (events stay in iCloud). `/debug/*` routes guarded by `DEBUG_TOKEN`, from your terminal:

```sh
pnpm db state                                  # inbox, conversation state, recent sends, next alarm
pnpm db "select * from inbound_messages order by received_at desc limit 5"
pnpm db export > backup.json                   # full JSON dump
pnpm db import backup.json                     # insert-only: never overwrites or deletes
pnpm db restore 2026-11-16T12:00:00Z --yes     # point-in-time restore (≤ 30 days back)
pnpm db users                                  # who has access besides you
pnpm db add-user 5511987654321 "Ana"           # give someone access (agenda in the bot)
pnpm connect-icloud                            # connect someone's own iCloud (two-way); re-run to change password/calendars
DB_USER=5511987654321 pnpm db state            # any command above, on another user's object
curl -X DELETE -H "Authorization: Bearer $DEBUG_TOKEN" $WORKER_URL/debug/users/5511987654321   # revoke
```

SQL is **read-only**: a single statement, run inside a transaction that is always rolled back.

> ⚠️ Never rename or delete the `Scheduler` class in a `wrangler.jsonc` migration without `pnpm db export` first: the data lives in it.

Updating: `git pull && pnpm install && pnpm run deploy` (or `pnpm configure --yes`).

## Development

```sh
pnpm test         # unit + integration (in-memory SQLite with the real DO migrations)
pnpm typecheck
pnpm eval         # real DeepSeek, in-memory store: accuracy + false "saved" claims (must be 0)
pnpm eval:images  # real vision + DeepSeek on scripts/fixtures/images: every event right, none invented
pnpm eval:audio   # real Whisper + DeepSeek on scripts/fixtures/audio (pt-BR voice notes)
pnpm tsx --env-file=.dev.vars scripts/icloud-smoke.ts   # live CalDAV round-trip on temporary calendars
pnpm db:generate  # new migration after changing src/worker/db/schema.ts
pnpm dev          # local worker (wrangler dev)
```

Map of the code:

| Path | |
|---|---|
| `src/worker/index.ts` | Webhook, `/debug/*`, daily watchdog cron |
| `src/worker/scheduler.ts` | The Durable Object (one per user, plus "registry"): SQLite + migrations, inbox, alarm, join, ICS feed, ops |
| `src/worker/users.ts` | Multi-user: registry, per-user profile and settings |
| `src/worker/secrets.ts` | AES-GCM for per-user iCloud credentials |
| `scripts/connect-icloud.ts` | Terminal flow to connect someone's iCloud (validates login, picks calendars) |
| `src/worker/llm/extract.ts` | Prompt + action schema (the only thing the model does) |
| `src/worker/llm/execute.ts` | Runs actions, resolves which event you mean, builds replies |
| `src/worker/llm/confirm.ts` | Confirmations re-read from the store |
| `src/worker/llm/state.ts` | Structured context (draft 15 min, recent events E1… and tasks T1… 30 min, image batch 24 h) |
| `src/worker/llm/vision.ts`, `batch.ts` | Image transcription; preview and rule-based "sim / não / 1,3" parsing |
| `src/worker/llm/transcribe.ts` | Voice-note transcription (Whisper); the transcript is handled as typed text |
| `src/worker/icloud/` | CalDAV client, iCalendar read/write (ical.js), iCloud store |
| `src/worker/tasks.ts` | To-dos: storage, repeat, nags, formatting |
| `src/worker/shopping.ts` | Shopping list: storage, item matching, formatting |
| `src/worker/notifications.ts` | Event reminders, task nags and digests (deduped, released on send failure) |
| `src/worker/calendar/` | Store interface, SQLite store (guests), in-memory store (tests), recurrence, formatting |

## Security & privacy

- Only `OWNER_PHONE` and users you added (`pnpm db add-user` / `pnpm connect-icloud`) are served; everyone else, groups, broadcasts and outgoing messages are ignored without touching any storage. Each user's data lives in their own Durable Object.
- **The bot never writes first.** WhatsApp restricts numbers that start chats with strangers ("Your account is restricted… can't start new chats"). Every message the bot sends is in a chat the person opened; adding a user sends nothing.
- A guest's calendar link is a secret URL (160-bit token): anyone holding it can read that agenda. Revoking the user (see Operations) kills the link.
- The webhook URL carries a random secret, and `/debug/*` needs a bearer token (constant-time compared).
- The iCloud app-specific password grants calendar access to *your own* worker only; revoke it anytime at account.apple.com.
- Message text (of every user) is sent to DeepSeek for interpretation, and you, as the operator, can read guests' data with `pnpm db`. Tell your friends.
- Nothing else leaves your Cloudflare account, iCloud and Z-API.

## Limitations

- Brazilian Portuguese only.
- WhatsApp via Z-API only (not the official WhatsApp Cloud API).
- Two-way sync only with iCloud (yours, or users connected with `pnpm connect-icloud`). Other users see their agenda read-only in their calendar app (changes go through WhatsApp); no Google Calendar write access.
- Tasks live in the bot, not in Apple's Reminders app: since the iOS 13 Reminders upgrade, iCloud no longer exposes reminders over CalDAV, and there's no public API for them.
- Guests all share the bot's WhatsApp number and your DeepSeek/Z-API quota.

## License

[MIT](LICENSE)
