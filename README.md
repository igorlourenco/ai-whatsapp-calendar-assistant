# Assistente de agenda no WhatsApp

Bot pessoal de calendário: você manda mensagem no WhatsApp ("marca dentista sexta 15h", "o que tenho sábado?"), o DeepSeek interpreta e o worker grava/consulta direto no seu **Apple Calendar (iCloud, via CalDAV)**. Cada categoria é um calendário do iCloud (faculdade, trabalho, personal). Eventos criados no iPhone também entram nas consultas e resumos. Resumo às 07:00, prévia de amanhã às 21:00, e lembretes: alerta nativo do iPhone + WhatsApp.

## Arquitetura

```
WhatsApp ─▶ Z-API (instância Movisim) ─▶ POST /webhooks/zapi?token=…
                                             │  só OWNER_PHONE, ignora grupo/fromMe/clientes
                                             ▼
                         Scheduler (Durable Object, instância única, SQLite embutido)
                                             │  inbox durável: em ordem, retry, aviso explícito de falha
                                             ├─ DeepSeek: 1 chamada por mensagem, JSON estrito; contexto = estado
                                             │   montado pelo código (rascunho pendente, "qual deles?", eventos E1…),
                                             │   nunca o histórico de respostas
                                             │   {actions: create | update | delete | query | create_category | unknown}
                                             ├─ código valida (zod), executa no iCloud, relê o evento pra confirmar
                                             ├─ resposta 100% gerada por código (o modelo nunca escreve texto pro usuário)
                                             └─ um alarm só: próximo lembrete/resumo ou mensagem pendente
                                             ▼
                      iCloud CalDAV (eventos)   +   SQLite do DO (fila, estado, logs, categoria→calendário)
Cron diário ─▶ watchdog: arma o alarm se não houver nenhum
```

- `src/worker/index.ts`: webhook, rotas `/debug/*` e watchdog
- `src/worker/scheduler.ts`: Durable Object (SQLite + migrations no startup, inbox, alarm, debug/backup)
- `src/worker/llm/extract.ts`: prompt + schema das ações (a única coisa que o modelo faz)
- `src/worker/llm/execute.ts`: executa ações, resolve evento alvo por palavra-chave, monta respostas
- `src/worker/llm/confirm.ts`: confirmações lidas de volta do store
- `src/worker/llm/state.ts`: estado estruturado (rascunho 15 min, foco 30 min)
- `src/worker/inbox.ts`: processamento das mensagens com retry/backoff e aviso de falha
- `src/worker/notifications.ts`: o que enviar agora (`runDue`) e quando acordar (`nextWakeUp`); envios deduplicados em `reminder_log`/`digest_log` e liberados se o Z-API falhar
- `src/worker/icloud/`: cliente CalDAV, leitura/escrita iCalendar (ical.js), store do iCloud
- `src/worker/calendar/store.ts`: interface de armazenamento; `memory-store.ts` é a implementação dos testes/eval
- `src/worker/debug.ts`: snapshot, SQL só-leitura, export/import

## Setup

1. `cp .dev.vars.example .dev.vars` e preencha:
   - Z-API: mesmas credenciais do Movisim; `ZAPI_WEBHOOK_TOKEN` e `DEBUG_TOKEN` = `openssl rand -hex 32`
   - iCloud: Apple ID + senha de app (appleid.apple.com → Senhas de app)
2. Secrets no Cloudflare:
   ```sh
   for k in DEEPSEEK_API_KEY ZAPI_INSTANCE_ID ZAPI_TOKEN ZAPI_CLIENT_TOKEN ZAPI_WEBHOOK_TOKEN OWNER_PHONE ICLOUD_USERNAME ICLOUD_APP_PASSWORD DEBUG_TOKEN; do
     grep "^$k=" .dev.vars | cut -d= -f2- | tr -d '\n' | npx wrangler secret put $k
   done
   ```
3. `pnpm install && pnpm run deploy`. O Durable Object cria as tabelas sozinho na primeira requisição.
4. Mapeie categorias → calendários do iCloud (insert-only):
   ```sh
   pnpm db import categories.json   # {"tables":{"categories":[{"slug":"faculdade","name":"Faculdade","emoji":"🎓","calendarUrl":"https://pXX-caldav.icloud.com/…/"}]}}
   ```
5. Aponte o webhook "Ao receber" da instância Z-API: `pnpm zapi:webhook https://<sua-url>`.
   Só mexe no webhook de mensagens recebidas; o de status do Movisim fica intacto.

## Uso

- "Salva prova de cálculo dia 25 às 19h na faculdade"
- "Aula de banco de dados toda terça e quinta 19h às 22h até 15/12"
- "Férias de 20 a 31 de dezembro"
- "O que eu tenho hoje? E sábado que vem?"
- "Muda o dentista pra 16h" / "Cancela a aula de quarta"
- "marca oftalmo" → "❓ qual dia?" → "dia 10 às 15h"
- Logo depois de salvar/consultar: "muda pra 11h", "me lembra 1h antes", "apaga esse"
- "Cria categoria academia com 🏋️" (cria um calendário novo no iCloud)

## Inspeção, backup e restauração

Os dados de controle vivem no SQLite do Durable Object. Acesso pelas rotas `/debug/*` (Bearer `DEBUG_TOKEN`), via CLI:

```sh
pnpm db state                                   # fila, estado, últimos envios, próximo alarm
pnpm db "select * from inbound_messages order by received_at desc limit 5"
pnpm db export > backup-$(date +%F).json        # dump completo em JSON
pnpm db import backup.json                      # insert-only: nunca sobrescreve nem apaga
```

SQL é **só leitura**: um statement, começando com SELECT/WITH/EXPLAIN, executado numa transação que é sempre revertida (nem uma escrita escondida num CTE persiste).

Restauração para qualquer momento dos últimos 30 dias (descarta tudo depois desse instante):

```sh
pnpm db restore 2026-11-16T12:00:00Z --yes
```

⚠️ Nunca renomeie/remova a classe `Scheduler` numa migration do `wrangler.jsonc` sem antes rodar `pnpm db export`: os dados vivem nela.

## Dev

```sh
pnpm dev          # worker local (wrangler dev)
pnpm test         # unit + integração (SQLite em memória via sql.js, mesmas migrations do DO)
pnpm typecheck
pnpm eval         # DeepSeek real, store em memória: taxa de acerto + confirmações falsas (deve ser 0)
pnpm tsx --env-file=.dev.vars scripts/icloud-smoke.ts  # teste ao vivo no iCloud (calendários temporários)
pnpm db:generate  # nova migration após mudar src/worker/db/schema.ts
```
