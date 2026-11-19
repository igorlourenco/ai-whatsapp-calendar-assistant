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
.steps { display: flex; gap: 6px; margin-bottom: 20px; }
.steps span { height: 4px; flex: 1; border-radius: 4px; background: var(--line); transition: background .25s; }
.steps span.on { background: var(--accent); }
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
.small { color: var(--muted); font-size: .84rem; margin-top: 20px; }
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
      <li>Aparece no calendário do seu celular</li>
    </ul>
  </section>

  <section class="card" aria-live="polite">
    <div class="steps" aria-hidden="true"><span class="on"></span><span></span><span></span></div>

    <form id="s1" novalidate>
      <h2>Criar minha agenda</h2>
      <p class="sub">É grátis. Te mando um código no WhatsApp pra confirmar o número.</p>
      <div class="field">
        <label for="name">Seu nome</label>
        <input id="name" name="name" autocomplete="given-name" maxlength="60" required>
      </div>
      <div class="field">
        <label for="phone">WhatsApp</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 98765-4321" required>
        <div class="hint">Fora do Brasil? Começa com + e o código do país.</div>
      </div>
      <button type="submit">Receber código</button>
      <p class="error" id="e1" role="alert"></p>
    </form>

    <form id="s2" novalidate hidden>
      <h2>Confere o WhatsApp</h2>
      <p class="sub">Mandei um código de 6 dígitos pra <strong id="to"></strong>.</p>
      <div class="field">
        <label for="code">Código</label>
        <input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
      </div>
      <button type="submit">Entrar</button>
      <p class="error" id="e2" role="alert"></p>
      <div class="row">
        <button type="button" class="link" id="back">← Trocar número</button>
        <button type="button" class="link" id="resend">Mandar de novo</button>
      </div>
    </form>

    <div id="ts">${turnstile}</div>

    <div id="s3" hidden>
      <h2 id="doneTitle">Pronto! 🎉</h2>
      <p class="sub" id="doneSub">Te mandei uma mensagem no WhatsApp. Responde lá: <em>dentista sexta 15h</em>.</p>
      <div id="feed" hidden>
        <div class="note">📅 <strong>Pra ver a agenda no calendário do celular</strong>, adiciona o link abaixo. O que você marcar pelo WhatsApp aparece lá.</div>
        <div class="stack">
          <a class="btn" id="webcal" href="#">Adicionar ao calendário (iPhone)</a>
          <button type="button" class="ghost" id="copy">Copiar link (Google Agenda)</button>
        </div>
        <p class="small">Google Agenda: no computador, Configurações → Adicionar agenda → <em>Do URL</em> → cola o link. Esse link é só seu: não compartilha.</p>
      </div>
    </div>
  </section>
</main>
<footer>As mensagens que você manda são lidas por IA pra entender o que marcar.</footer>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const steps = document.querySelectorAll(".steps span");
  const state = { name: "", phone: "" };
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } })();

  function show(n) {
    ["s1", "s2", "s3"].forEach((id, i) => ($(id).hidden = i !== n - 1));
    $("ts").hidden = n === 3;
    steps.forEach((s, i) => s.classList.toggle("on", i < n));
  }

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({ ok: false, error: "Algo deu errado. Tenta de novo." }));
    if (!res.ok || !out.ok) throw new Error(out.error || "Algo deu errado. Tenta de novo.");
    return out;
  }

  function pretty(d) {
    const m = d.match(/^55(\\d{2})(\\d{4,5})(\\d{4})$/);
    return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : "+" + d;
  }

  async function sendCode(btn, errEl) {
    btn.disabled = true;
    errEl.textContent = "";
    try {
      const turnstile = window.turnstile ? window.turnstile.getResponse() : undefined;
      const out = await post("/signup/code", { name: state.name, phone: state.phone, turnstile });
      state.phone = "+" + out.phone;
      $("to").textContent = pretty(out.phone);
      show(2);
      $("code").value = "";
      $("code").focus();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
      if (window.turnstile) window.turnstile.reset();
    }
  }

  $("s1").addEventListener("submit", (ev) => {
    ev.preventDefault();
    state.name = $("name").value.trim();
    state.phone = $("phone").value.trim();
    if (!state.name) return ($("e1").textContent = "Diz teu nome."), $("name").focus();
    if (!state.phone) return ($("e1").textContent = "Coloca teu número de WhatsApp."), $("phone").focus();
    sendCode(ev.submitter || $("s1").querySelector("button"), $("e1"));
  });

  $("code").addEventListener("input", (ev) => {
    ev.target.value = ev.target.value.replace(/\\D/g, "").slice(0, 6);
    if (ev.target.value.length === 6) $("s2").requestSubmit();
  });

  $("s2").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("s2").querySelector("button[type=submit]");
    const code = $("code").value;
    if (code.length !== 6) return ($("e2").textContent = "O código tem 6 dígitos.");
    btn.disabled = true;
    $("e2").textContent = "";
    try {
      const out = await post("/signup/verify", { name: state.name, phone: state.phone, code, tz });
      if (out.existing) {
        $("doneTitle").textContent = "Você já tem cadastro 👋";
        $("doneSub").textContent = "É só mandar mensagem pro mesmo número que te mandou o código.";
      }
      if (out.feedUrl) {
        $("webcal").href = out.feedUrl;
        $("copy").dataset.url = out.httpsUrl;
        $("feed").hidden = false;
      }
      show(3);
    } catch (e) {
      $("e2").textContent = e.message;
      $("code").select();
    } finally {
      btn.disabled = false;
    }
  });

  $("back").addEventListener("click", () => { $("e1").textContent = ""; show(1); $("phone").focus(); });
  $("resend").addEventListener("click", (ev) => sendCode(ev.currentTarget, $("e2")));

  $("copy").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(btn.dataset.url);
      btn.textContent = "Link copiado ✓";
    } catch {
      prompt("Copia o link:", btn.dataset.url);
    }
  });
})();
</script>
</body>
</html>`;
}
