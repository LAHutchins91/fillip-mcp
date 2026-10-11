export function renderLanding(input: { appBaseUrl: string; connectLead: string; supabaseUrl: string; supabaseAnonKey: string }) {
  const config = JSON.stringify({ url: input.supabaseUrl, key: input.supabaseAnonKey }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fillip by Ouroboros</title>
<link rel="icon" href="/icon.svg"><style>body{margin:0;background:#f6f4ef;color:#1c1915;font:17px/1.65 system-ui}main{max-width:760px;margin:48px auto;padding:24px}a{color:#0c6b4d}h1{font-size:44px;line-height:1.1;margin-bottom:8px}button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #0c6b4d;background:#0c6b4d;color:white;cursor:pointer;margin:8px 8px 8px 0}.secondary{background:transparent;color:#1c1915}#message{white-space:pre-wrap}</style></head>
<body><main>
<p>Fillip by Ouroboros</p>
<h1>Fillip, reminders that fire.</h1>
<p>Remind me to follow up on this next Tuesday at 2pm, and actually ping me. Fillip emails you when that reminder is due, even if your laptop is off. It works from ChatGPT, Claude, Cursor, and Grok.</p>
${input.connectLead}
<p>A free plan does not expire. The trial is 14 days, then Pro. If you do not continue, you stay on the free plan. Checkout shows the plan terms. This page does not print a price.</p>
<button id="monthly" type="button">Start the 14-day trial</button>
<button id="annual" class="secondary" type="button">Pro yearly</button>
<button id="portal" class="secondary" type="button">Manage billing</button>
<p id="message" role="status"></p>
<p><a href="https://ouroborosapps.com">More from Ouroboros</a></p>
</main>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js"></script>
<script>
var cfg=${config};
async function token(){if(!cfg.url||!cfg.key||!window.supabase)throw Error('Sign-in is not configured yet.');var client=window.supabase.createClient(cfg.url,cfg.key);var session=await client.auth.getSession();if(!session.data.session){location.href='/oauth/consent';throw Error('Sign in first.');}return session.data.session.access_token}
async function checkout(plan){var status=document.getElementById('message');status.textContent='Opening checkout…';try{var access=await token();var r=await fetch('/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+access},body:JSON.stringify({plan:plan})});var d=await r.json();if(!r.ok)throw Error(d.error||'Checkout could not start.');location.href=d.url}catch(e){status.textContent=e.message}}
document.getElementById('monthly').onclick=function(){checkout('monthly')};
document.getElementById('annual').onclick=function(){checkout('annual')};
document.getElementById('portal').onclick=async function(){var status=document.getElementById('message');try{var access=await token();var r=await fetch('/billing/portal',{method:'POST',headers:{Authorization:'Bearer '+access}});var d=await r.json();if(!r.ok)throw Error(d.error||'Billing could not open.');location.href=d.url}catch(e){status.textContent=e.message}};
</script>
</body></html>`;
}
