# Assistente de agenda no WhatsApp

Bot pessoal de calendário: você manda mensagem no WhatsApp ("marca dentista sexta 15h", "o que tenho sábado?"), o DeepSeek interpreta e o worker grava/consulta direto no seu **Apple Calendar (iCloud, via CalDAV)**. Cada categoria é um calendário do iCloud (faculdade, trabalho, personal). Eventos criados no iPhone também entram nas consultas e resumos. Resumo às 07:00, prévia de amanhã às 21:00, e lembretes: alerta nativo do iPhone + WhatsApp.

## Arquitetura

```
WhatsApp ─▶ Z-API (instância Movisim) ─▶ POST /webhooks/zapi?token=…
                                             │  só OWNER_PHONE, ignora grupo/fromMe/clientes
                                             ▼
                                   Scheduler DO (inbox durável, em ordem, retry)
                                             │
                                             ├─ DeepSeek: 1 chamada por mensagem, JSON estrito; contexto = estado
                                             │   montado pelo código (rascunho pendente, "qual deles?", eventos E1…),
                                             │   nunca o histórico de respostas
                                             │   {actions: create | update | delete | query | create_category | web_link | unknown}
                                             ├─ código valida (zod), executa, relê do banco
                                             └─ resposta 100% gerada por código (o modelo nunca escreve texto pro usuário)
                                             ▼
                    iCloud CalDAV (eventos)   +   Neon (fila, estado, logs, categoria→calendário)
Scheduler (Durable Object) ─▶ alarm no próximo lembrete/resumo; Neon só acorda quando há o que enviar
Cron diário ─▶ watchdog: arma o alarm se não houver nenhum
```

- `src/worker/index.ts`: rotas (webhook, auth, API) + handler `scheduled`
- `src/worker/llm/extract.ts`: prompt + schema das ações (a única coisa que o modelo faz)
- `src/worker/llm/execute.ts`: executa ações, resolve evento alvo por palavra-chave, monta respostas
- `src/worker/llm/confirm.ts`: confirmações lidas de volta do banco
- `src/worker/llm/state.ts`: estado estruturado (rascunho 15 min, foco 30 min)
- `src/worker/inbox.ts`: processamento das mensagens com retry/backoff e aviso de falha
- `src/worker/calendar/`: CRUD, expansão de recorrência, formatação WhatsApp
- `src/worker/scheduler.ts`: Durable Object com um alarm só, re-armado a cada mensagem e após cada disparo
- `src/worker/notifications.ts`: o que enviar agora (`runDue`) e quando acordar (`nextWakeUp`); envios deduplicados em `reminder_log`/`digest_log` e liberados se o Z-API falhar
- `src/worker/icloud/`: cliente CalDAV, leitura/escrita iCalendar (ical.js), store do iCloud
- `src/worker/calendar/store.ts`: interface de armazenamento (iCloud em produção, Postgres em testes/eval)

Modelo de evento: `start_at`/`end_at` (end exclusivo). Dia todo = meia-noite local até meia-noite após o último dia, então multi-dia é natural. Recorrência simples (diária/semanal com dias/mensal/anual, `until`/`count`) e `exdates` pra cancelar uma ocorrência.

## Setup

1. **Neon**: crie um projeto, copie a connection string.
2. `cp .dev.vars.example .dev.vars` e preencha (Z-API = mesmas credenciais do Movisim; `ZAPI_WEBHOOK_TOKEN` e `SESSION_SECRET` = `openssl rand -hex 32`).
3. Banco:
   ```sh
   pnpm install
   pnpm db:migrate
   pnpm db:seed        # 🎓 Faculdade, 💼 Trabalho, 🏠 Pessoal
   ```
4. Secrets no Cloudflare:
   ```sh
   for k in DATABASE_URL DEEPSEEK_API_KEY ZAPI_INSTANCE_ID ZAPI_TOKEN ZAPI_CLIENT_TOKEN ZAPI_WEBHOOK_TOKEN OWNER_PHONE SESSION_SECRET; do
     grep "^$k=" .dev.vars | cut -d= -f2- | npx wrangler secret put $k
   done
   ```
5. Deploy: `pnpm run deploy`. Ajuste `APP_URL` em `wrangler.jsonc` pra URL real e faça deploy de novo (é a base do link mágico).
6. Aponte o webhook "Ao receber" da instância Z-API: `pnpm zapi:webhook https://<sua-url>`.
   Só mexe no webhook de mensagens recebidas; o de status do Movisim fica intacto.
   Antes, confira no painel Z-API que esse webhook não está em uso por outra coisa.

## Uso

- "Salva prova de cálculo dia 25 às 19h na faculdade"
- "Aula de banco de dados toda terça e quinta 19h às 22h até 15/12"
- "Férias de 20 a 31 de dezembro"
- "O que eu tenho hoje? E sábado que vem?"
- "Muda o dentista pra 16h" / "Cancela a aula de quarta"
- "marca oftalmo" → "❓ qual dia?" → "dia 10 às 15h"
- Logo depois de salvar/consultar: "muda pra 11h", "me lembra 1h antes", "apaga esse"
- "Cria categoria academia com 🏋️"

## Dev

```sh
pnpm dev          # vite + worker local
pnpm test         # unit + integração (PGlite em memória)
pnpm tsx --env-file=.dev.vars scripts/icloud-smoke.ts  # teste ao vivo no iCloud (calendários temporários)
pnpm eval         # DeepSeek real, banco em memória: taxa de acerto + confirmações falsas (deve ser 0)
pnpm typecheck
```
