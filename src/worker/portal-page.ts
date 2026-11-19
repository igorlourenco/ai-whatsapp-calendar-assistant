/** The signup page (GET /). Plain HTML + inline CSS/JS; talks to /signup/*. */
export function portalPage(o: { turnstileSiteKey: string | null }): string {
  const turnstile = o.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${o.turnstileSiteKey.replace(/[^\w-]/g, "")}" data-language="pt-br" data-size="flexible" data-appearance="interaction-only"></div>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Agenda no WhatsApp</title>
<meta name="description" content="Marque compromissos, tarefas e lista de compras escrevendo no WhatsApp.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗓️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,640&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
${o.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}
<style>
:root {
  --bg: #f6f3ec;
  --surface: #fffdf8;
  --ink: #1d1b16;
  --muted: #6b665b;
  --line: #e4ded0;
  --accent: #0f6b4f;
  --accent-ink: #ffffff;
  --accent-soft: #e2f0e9;
  --chat-bg: #e9e3d6;
  --bubble-me: #d5f2d0;
  --bubble-bot: #ffffff;
  --danger: #b3261e;
  --shadow: 0 1px 2px rgba(29,27,22,.06), 0 8px 28px rgba(29,27,22,.08);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14130f;
    --surface: #1d1c17;
    --ink: #f1ede3;
    --muted: #a39d8f;
    --line: #34322a;
    --accent: #4cc497;
    --accent-ink: #0b1f17;
    --accent-soft: #1b3229;
    --chat-bg: #0f0e0b;
    --bubble-me: #1f4a35;
    --bubble-bot: #26251f;
    --danger: #f2867d;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 28px rgba(0,0,0,.35);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
.wrap {
  max-width: 1040px;
  margin: 0 auto;
  padding: 40px 16px 56px;
  display: grid;
  gap: 40px;
  align-items: center;
}
@media (min-width: 880px) {
  .wrap { grid-template-columns: 1.05fr 1fr; gap: 64px; padding-top: 72px; }
}
h1 {
  font-family: Fraunces, Georgia, serif;
  font-weight: 640;
  font-size: clamp(2.2rem, 6vw, 3.4rem);
  line-height: 1.04;
  letter-spacing: -0.02em;
  margin: 0 0 16px;
  text-wrap: balance;
}
h1 em { font-style: normal; color: var(--accent); }
.lede { color: var(--muted); font-size: 1.08rem; margin: 0 0 28px; max-width: 34ch; }
.chat {
  background: var(--chat-bg);
  border-radius: 20px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 420px;
}
.b {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: .94rem;
  line-height: 1.4;
  box-shadow: 0 1px 1px rgba(0,0,0,.06);
  white-space: pre-line;
}
.me { align-self: flex-end; background: var(--bubble-me); border-bottom-right-radius: 4px; }
.bot { align-self: flex-start; background: var(--bubble-bot); border-bottom-left-radius: 4px; }
.feat { list-style: none; padding: 0; margin: 24px 0 0; display: grid; gap: 8px; color: var(--muted); font-size: .95rem; }
.feat li::before { content: "→ "; color: var(--accent); }

.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 28px 24px;
  box-shadow: var(--shadow);
}
@media (min-width: 480px) { .card { padding: 32px; } }
.card h2 { font-family: Fraunces, Georgia, serif; font-weight: 560; font-size: 1.6rem; margin: 0 0 6px; letter-spacing: -0.01em; }
.card p.sub { color: var(--muted); margin: 0 0 24px; }
label { display: block; font-weight: 500; font-size: .92rem; margin: 0 0 6px; }
.field { margin-bottom: 18px; }
input {
  width: 100%;
  font: inherit;
  font-size: 1.05rem;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px 14px;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
input.code { font-size: 1.6rem; letter-spacing: .4em; text-align: center; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: .84rem; margin-top: 6px; }
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  font-weight: 600;
  font-size: 1rem;
  padding: 14px 18px;
  border-radius: 12px;
  border: 0;
  cursor: pointer;
  background: var(--accent);
  color: var(--accent-ink);
  text-decoration: none;
  transition: transform .12s ease-out, opacity .15s;
}
button:active, .btn:active { transform: scale(.98); }
button:disabled { opacity: .6; cursor: progress; }
button.ghost, .btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
button.link { background: none; color: var(--accent); width: auto; padding: 6px 0; font-weight: 500; }
.row { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 12px; flex-wrap: wrap; }
.error { color: var(--danger); font-size: .92rem; min-height: 1.4em; margin: 10px 0 0; }
.cf-turnstile { margin-top: 16px; }
.stack { display: grid; gap: 10px; }
.note { background: var(--accent-soft); border-radius: 12px; padding: 14px 16px; font-size: .94rem; margin-bottom: 20px; }
.note ol { margin: 8px 0 0; padding-left: 20px; }
.note a { color: var(--accent); }
.small { color: var(--muted); font-size: .84rem; margin-top: 20px; }
.choice {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
  font-weight: 400;
}
.choice:hover { border-color: var(--accent); }
.choice strong { display: block; font-size: 1.02rem; margin-bottom: 2px; }
.choice span { color: var(--muted); font-size: .9rem; }
.cal { border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; display: grid; gap: 10px; }
.cal.off { opacity: .55; }
.cal .top { display: flex; align-items: center; gap: 10px; }
.cal .top input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent); flex: none; }
.cal .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.cal .top label { margin: 0; font-weight: 600; flex: 1; }
.cal .fields { display: grid; grid-template-columns: 64px 1fr; gap: 8px; }
.cal .fields input { padding: 10px 12px; font-size: .98rem; }
.cal .fields .emoji { text-align: center; }
.cal .fields .desc { grid-column: 1 / -1; }
.cal .def { display: flex; align-items: center; gap: 8px; font-size: .88rem; color: var(--muted); font-weight: 400; margin: 0; }
.cal .def input { width: 18px; height: 18px; accent-color: var(--accent); }
.status { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 20px; }
.danger { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 20px; }
button.danger-btn { background: var(--danger); color: #fff; }
button.link.danger-link { color: var(--danger); }
[hidden] { display: none !important; }
footer { text-align: center; color: var(--muted); font-size: .82rem; padding: 0 16px 32px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main class="wrap">
  <section>
    <h1>Sua agenda, <em>no WhatsApp.</em></h1>
    <p class="lede">Escreve do jeito que você fala. Eu marco, lembro, listo e te mando o resumo do dia.</p>
    <div class="chat" aria-hidden="true">
      <div class="b me">dentista sexta 15h</div>
      <div class="b bot">✅ Salvo na agenda
🏠 Dentista
🗓️ sexta, 20 de novembro · 15:00–16:00
⏰ lembrete 30 min antes</div>
      <div class="b me">me lembra de pagar o boleto dia 10</div>
      <div class="b me">o que tenho amanhã?</div>
    </div>
    <ul class="feat">
      <li>Compromissos, tarefas e lista de compras</li>
      <li>Áudio e foto também: manda o print da escala de provas</li>
      <li>Aparece no calendário do seu celular, ou direto no seu iCloud</li>
    </ul>
  </section>

  <section class="card" aria-live="polite">
    <!-- 1. number -->
    <form id="sPhone" novalidate>
      <h2>Criar ou acessar minha agenda</h2>
      <p class="sub">É grátis. Te mando um código no WhatsApp pra confirmar o número.</p>
      <div class="field">
        <label for="phone">WhatsApp</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 98765-4321" required>
        <div class="hint">Fora do Brasil? Começa com + e o código do país.</div>
      </div>
      <button type="submit">Receber código</button>
      <p class="error" id="ePhone" role="alert"></p>
    </form>

    <!-- 2. code -->
    <form id="sCode" novalidate hidden>
      <h2>Confere o WhatsApp</h2>
      <p class="sub">Mandei um código de 6 dígitos pra <strong id="to"></strong>.</p>
      <div class="field">
        <label for="code">Código</label>
        <input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
      </div>
      <button type="submit">Entrar</button>
      <p class="error" id="eCode" role="alert"></p>
      <div class="row">
        <button type="button" class="link" id="back">← Trocar número</button>
        <button type="button" class="link" id="resend">Mandar de novo</button>
      </div>
    </form>

    <div id="ts">${turnstile}</div>

    <!-- 3a. new user: where the agenda lives -->
    <div id="sChoose" hidden>
      <h2>Quase lá</h2>
      <p class="sub">Como você quer ver seus compromissos?</p>
      <div class="field">
        <label for="name">Seu nome</label>
        <input id="name" autocomplete="given-name" maxlength="60">
      </div>
      <div class="stack">
        <button type="button" class="choice" id="pickGuest">
          <strong>📅 Agenda aqui no bot</strong>
          <span>Funciona em qualquer celular. Você adiciona um link no calendário do iPhone ou no Google Agenda e vê tudo lá.</span>
        </button>
        <button type="button" class="choice" id="pickICloud">
          <strong>☁️ Meu iCloud</strong>
          <span>Pra quem usa o Calendário da Apple. O que você marcar aqui aparece lá, e o que marcar lá eu também vejo.</span>
        </button>
      </div>
      <p class="error" id="eChoose" role="alert"></p>
    </div>

    <!-- 4. iCloud login -->
    <form id="sICloud" novalidate hidden>
      <h2>Conectar meu iCloud</h2>
      <div class="note">
        Você precisa de uma <strong>senha de app</strong> (não é a senha do seu Apple ID):
        <ol>
          <li>Abre <a href="https://account.apple.com/account/manage" target="_blank" rel="noopener">account.apple.com</a> e entra</li>
          <li><em>Iniciar sessão e segurança</em> → <em>Senhas de apps</em></li>
          <li>Cria uma com o nome "Agenda WhatsApp" e copia</li>
        </ol>
      </div>
      <div class="field">
        <label for="appleId">Apple ID (email)</label>
        <input id="appleId" type="email" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" required>
      </div>
      <div class="field">
        <label for="appPass">Senha de app</label>
        <input id="appPass" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx" required>
        <div class="hint">Fica guardada criptografada e só serve pro calendário. Dá pra revogar quando quiser no mesmo lugar.</div>
      </div>
      <button type="submit">Ver meus calendários</button>
      <p class="error" id="eICloud" role="alert"></p>
      <div class="row"><button type="button" class="link" id="icloudBack">← Voltar</button></div>
    </form>

    <!-- 5. pick calendars -->
    <form id="sPick" novalidate hidden>
      <h2>Quais calendários eu uso?</h2>
      <p class="sub">Cada um vira uma categoria. Eu escolho a certa pelo que você escrever, ou uso a padrão.</p>
      <div class="stack" id="cals"></div>
      <div style="height:18px"></div>
      <button type="submit">Conectar</button>
      <p class="error" id="ePick" role="alert"></p>
      <div class="row"><button type="button" class="link" id="pickBack">← Voltar</button></div>
    </form>

    <!-- 6. account -->
    <div id="sAccount" hidden>
      <h2 id="hello">Pronto! 🎉</h2>
      <p class="sub" id="helloSub">Te mandei uma mensagem no WhatsApp. Responde lá: <em>dentista sexta 15h</em>.</p>

      <div id="accLocal" hidden>
        <div class="note">📅 <strong>Pra ver a agenda no calendário do celular</strong>, adiciona o link abaixo. O que você marcar pelo WhatsApp aparece lá.</div>
        <div class="stack">
          <a class="btn" id="webcal" href="#">Adicionar ao calendário (iPhone)</a>
          <button type="button" class="ghost" id="copy">Copiar link (Google Agenda)</button>
        </div>
        <p class="small">Google Agenda: no computador, Configurações → Adicionar agenda → <em>Do URL</em> → cola o link. Esse link é só seu: não compartilha.</p>
        <p class="small">Usa iPhone e quer que funcione nos dois sentidos? <button type="button" class="link" id="toICloud">Conectar meu iCloud</button></p>
      </div>

      <div id="accICloud" hidden>
        <div class="note">✅ <strong>Conectado ao seu iCloud.</strong> O que você marcar pelo WhatsApp aparece no Calendário da Apple, e vice-versa.</div>
        <button type="button" class="ghost" id="reICloud">Trocar senha de app ou calendários</button>
      </div>

      <div class="danger">
        <button type="button" class="link danger-link" id="delOpen">Excluir minha conta</button>
        <form id="delForm" novalidate hidden>
          <p class="sub" id="delText">Apago suas tarefas, lista de compras, configurações e compromissos guardados aqui, e paro de te mandar mensagens. Não dá pra desfazer.</p>
          <div class="field">
            <label for="delConfirm">Escreve <strong>excluir</strong> pra confirmar</label>
            <input id="delConfirm" autocomplete="off" autocapitalize="off" spellcheck="false">
          </div>
          <button type="submit" class="danger-btn">Excluir minha conta</button>
          <p class="error" id="eDel" role="alert"></p>
        </form>
      </div>
    </div>

    <!-- 7. deleted -->
    <div id="sDeleted" hidden>
      <h2>Conta excluída</h2>
      <p class="sub" id="deletedSub">Apaguei tudo que era seu aqui. Se mudar de ideia, é só se cadastrar de novo.</p>
    </div>
  </section>
</main>
<footer>As mensagens que você manda são lidas por IA pra entender o que marcar.</footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const SCREENS = ["sPhone", "sCode", "sChoose", "sICloud", "sPick", "sAccount", "sDeleted"];
  const S = { phone: "", token: "", account: null, login: null };
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();
  const GENERIC = "Algo deu errado. Tenta de novo.";

  function show(id, focus) {
    SCREENS.forEach((s) => ($(s).hidden = s !== id));
    $("ts").hidden = id !== "sPhone" && id !== "sCode";
    document.querySelectorAll(".error").forEach((e) => (e.textContent = ""));
    if (focus) $(focus).focus();
  }

  class Expired extends Error {}

  async function post(path, body) {
    const headers = { "Content-Type": "application/json" };
    if (S.token) headers.Authorization = "Bearer " + S.token;
    let res, out;
    try {
      res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
      out = await res.json();
    } catch {
      throw new Error(GENERIC);
    }
    if (res.status === 401) throw new Expired(out.error || GENERIC);
    if (!res.ok || !out.ok) throw new Error(out.error || GENERIC);
    return out;
  }

  /** Run an action with its button disabled; errors go to errEl. */
  async function run(btn, errEl, fn) {
    btn.disabled = true;
    errEl.textContent = "";
    try {
      await fn();
    } catch (e) {
      if (e instanceof Expired) {
        S.token = "";
        show("sPhone", "phone");
        $("ePhone").textContent = e.message;
      } else errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function pretty(d) {
    const m = d.match(/^55(\\d{2})(\\d{4,5})(\\d{4})$/);
    return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : "+" + d;
  }

  function showAccount(acc, fresh) {
    S.account = acc;
    const first = acc.name ? acc.name.split(" ")[0] : "";
    $("hello").textContent = fresh ? "Pronto! 🎉" : first ? "Oi, " + first + " 👋" : "Oi 👋";
    $("helloSub").innerHTML = fresh
      ? "Te mandei uma mensagem no WhatsApp. Responde lá: <em>dentista sexta 15h</em>."
      : "Sua agenda funciona pelo WhatsApp, no mesmo número que te mandou o código.";
    const local = acc.storage === "local";
    $("accLocal").hidden = !local;
    $("accICloud").hidden = local;
    if (local) {
      $("webcal").href = acc.feedUrl;
      $("copy").dataset.url = acc.httpsUrl;
      $("copy").textContent = "Copiar link (Google Agenda)";
    }
    $("delText").textContent = local
      ? "Apago seus compromissos, tarefas, lista de compras e configurações, e paro de te mandar mensagens. O link do calendário para de funcionar. Não dá pra desfazer."
      : "Apago suas tarefas, lista de compras, configurações e a senha de app guardada, e paro de te mandar mensagens. Seus compromissos continuam no iCloud. Não dá pra desfazer.";
    $("delForm").hidden = true;
    $("delOpen").hidden = false;
    show("sAccount");
  }

  /* 1. number */
  async function sendCode(btn, errEl) {
    await run(btn, errEl, async () => {
      try {
        const turnstile = window.turnstile ? window.turnstile.getResponse() : undefined;
        const out = await post("/signup/code", { phone: S.phone, turnstile });
        S.phone = "+" + out.phone;
        $("to").textContent = pretty(out.phone);
        $("code").value = "";
        show("sCode", "code");
      } finally {
        if (window.turnstile) window.turnstile.reset();
      }
    });
  }

  $("sPhone").addEventListener("submit", (ev) => {
    ev.preventDefault();
    S.phone = $("phone").value.trim();
    if (!S.phone) return ($("ePhone").textContent = "Coloca teu número de WhatsApp."), $("phone").focus();
    sendCode($("sPhone").querySelector("button"), $("ePhone"));
  });

  /* 2. code */
  $("code").addEventListener("input", (ev) => {
    ev.target.value = ev.target.value.replace(/\\D/g, "").slice(0, 6);
    if (ev.target.value.length === 6) $("sCode").requestSubmit();
  });

  $("sCode").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = $("code").value;
    if (code.length !== 6) return ($("eCode").textContent = "O código tem 6 dígitos.");
    run($("sCode").querySelector("button[type=submit]"), $("eCode"), async () => {
      try {
        const out = await post("/signup/verify", { phone: S.phone, code });
        S.token = out.token;
        if (out.account) showAccount(out.account, false);
        else show("sChoose", "name");
      } catch (e) {
        $("code").select();
        throw e;
      }
    });
  });

  $("back").addEventListener("click", () => show("sPhone", "phone"));
  $("resend").addEventListener("click", (ev) => sendCode(ev.currentTarget, $("eCode")));

  /* 3. new user: bot or iCloud */
  function needName() {
    if ($("name").value.trim()) return true;
    $("eChoose").textContent = "Diz teu nome.";
    $("name").focus();
    return false;
  }

  $("pickGuest").addEventListener("click", (ev) => {
    if (!needName()) return;
    run(ev.currentTarget, $("eChoose"), async () => {
      const out = await post("/account/guest", { name: $("name").value.trim(), tz });
      showAccount(out.account, true);
    });
  });

  $("pickICloud").addEventListener("click", () => {
    if (!needName()) return;
    show("sICloud", "appleId");
  });

  /* 4. iCloud login */
  $("sICloud").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const login = { username: $("appleId").value.trim(), password: $("appPass").value.trim() };
    if (!login.username || !login.password) return ($("eICloud").textContent = "Preenche o Apple ID e a senha de app.");
    const btn = $("sICloud").querySelector("button[type=submit]");
    const label = btn.textContent;
    btn.textContent = "Conferindo no iCloud…";
    run(btn, $("eICloud"), async () => {
      try {
        const out = await post("/account/icloud/calendars", login);
        S.login = login;
        renderCals(out.calendars);
        show("sPick");
      } finally {
        btn.textContent = label;
      }
    });
  });

  $("icloudBack").addEventListener("click", () => (S.account ? showAccount(S.account, false) : show("sChoose")));

  /* 5. pick calendars */
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => (k in n && k !== "list" ? (n[k] = v) : n.setAttribute(k, v)));
    (kids || []).forEach((k) => n.append(k));
    return n;
  }

  function renderCals(cals) {
    const box = $("cals");
    box.replaceChildren();
    cals.forEach((c, i) => {
      const id = "cal" + i;
      const on = el("input", { type: "checkbox", id, checked: true });
      const def = el("input", { type: "radio", name: "def", checked: i === 0 });
      const fields = el("div", { className: "fields" }, [
        el("input", { className: "emoji", value: c.emoji, maxLength: 16, ariaLabel: "Emoji" }),
        el("input", { className: "cname", value: c.name, maxLength: 40, ariaLabel: "Nome da categoria" }),
        el("input", { className: "desc", placeholder: "O que vai aqui? (opcional) ex.: aulas, provas", maxLength: 120 }),
      ]);
      const card = el("div", { className: "cal" }, [
        el("div", { className: "top" }, [
          on,
          el("span", { className: "dot", style: "background:" + (/^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : "#8a8578") }),
          el("label", { htmlFor: id, textContent: c.name }),
        ]),
        fields,
        el("label", { className: "def" }, [def, "Padrão quando não der pra saber"]),
      ]);
      card.dataset.url = c.url;
      on.addEventListener("change", () => {
        card.classList.toggle("off", !on.checked);
        fields.hidden = !on.checked;
        def.disabled = !on.checked;
        if (!on.checked && def.checked) {
          const other = box.querySelector(".cal:not(.off) input[type=radio]");
          if (other) other.checked = true;
        }
      });
      box.append(card);
    });
  }

  $("sPick").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const categories = [...$("cals").querySelectorAll(".cal:not(.off)")].map((card) => ({
      url: card.dataset.url,
      emoji: card.querySelector(".emoji").value.trim(),
      name: card.querySelector(".cname").value.trim(),
      description: card.querySelector(".desc").value.trim(),
      isDefault: card.querySelector("input[type=radio]").checked,
    }));
    if (!categories.length) return ($("ePick").textContent = "Escolhe pelo menos um calendário.");
    const btn = $("sPick").querySelector("button[type=submit]");
    btn.textContent = "Conectando…";
    run(btn, $("ePick"), async () => {
      try {
        const fresh = !S.account;
        const out = await post("/account/icloud", { ...S.login, categories, name: $("name").value.trim(), tz });
        S.login = null;
        $("appPass").value = "";
        showAccount(out.account, fresh);
        if (!fresh) $("helloSub").textContent = "iCloud conectado. Te mandei uma mensagem no WhatsApp.";
      } finally {
        btn.textContent = "Conectar";
      }
    });
  });

  $("pickBack").addEventListener("click", () => show("sICloud", "appPass"));

  /* 6. account */
  $("copy").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(btn.dataset.url);
      btn.textContent = "Link copiado ✓";
    } catch {
      prompt("Copia o link:", btn.dataset.url);
    }
  });
  $("toICloud").addEventListener("click", () => show("sICloud", "appleId"));
  $("reICloud").addEventListener("click", () => show("sICloud", "appleId"));

  $("delOpen").addEventListener("click", () => {
    $("delOpen").hidden = true;
    $("delForm").hidden = false;
    $("delConfirm").value = "";
    $("delConfirm").focus();
  });

  $("delForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const confirm = $("delConfirm").value.trim().toLowerCase();
    if (confirm !== "excluir") return ($("eDel").textContent = 'Escreve "excluir" pra confirmar.');
    run($("delForm").querySelector("button"), $("eDel"), async () => {
      await post("/account/delete", { confirm });
      const icloud = S.account && S.account.storage === "icloud";
      S.token = "";
      S.account = null;
      $("deletedSub").textContent = icloud
        ? "Apaguei tudo que era seu aqui. Seus compromissos continuam no iCloud. Pra cortar o acesso de vez, apaga a senha de app em account.apple.com."
        : "Apaguei tudo que era seu aqui. Se mudar de ideia, é só se cadastrar de novo.";
      show("sDeleted");
    });
  });
})();
</script>
</body>
</html>`;
}
