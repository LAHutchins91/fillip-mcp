import type { Express } from "express";
import { canonicalPublicOrigin } from "./public-url.js";

/** OAuth resource stays on the configured base. Documentation prefers the public connect URL. */
export function protectedResourceMetadata(baseUrl: string, supabaseUrl: string) {
  return {
    resource: `${baseUrl}/mcp`,
    resource_name: "Fillip by Ouroboros",
    authorization_servers: [`${supabaseUrl}/auth/v1`],
    scopes_supported: ["email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${canonicalPublicOrigin(baseUrl)}/connect`
  };
}

/** Missing challenge, missing method, and every method other than S256 are rejected. */
export function pkceRejection(method: string | null | undefined, challenge: string | null | undefined): { error: "invalid_request"; error_description: string } | null {
  const challengeText = typeof challenge === "string" ? challenge.trim() : "";
  const methodText = typeof method === "string" ? method.trim() : "";
  if (!challengeText || !methodText || methodText !== "S256") {
    return {
      error: "invalid_request",
      error_description: "Fillip accepts only PKCE S256. Send code_challenge and code_challenge_method=S256."
    };
  }
  return null;
}

export function oauthErrorRedirect(redirectUri: string, error: string, description: string, state?: string | null): string {
  const url = new URL(redirectUri);
  if (!url.searchParams.get("error")) {
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
  }
  if (state && !url.searchParams.get("state")) url.searchParams.set("state", state);
  return url.toString();
}

export function otpFailure(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("rate") || text.includes("too many") || text.includes("only request this after") || text.includes("over_request") || text.includes("security purposes")) {
    return "Too many code emails were requested. Wait a minute, then send a new code.";
  }
  if (text.includes("expired")) {
    return "That code has expired. Send a new one and use the code in the latest email.";
  }
  if (text.includes("invalid") || text.includes("otp") || text.includes("token")) {
    return "That code is not right. Check the email and try the latest code.";
  }
  return "Fillip could not finish sign-in. Send a new code and try again.";
}

export function installPluginAuth(app: Express, fallbackBase: string, fallbackSupabase: string, fallbackAnon: string) {
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    const base = (process.env.APP_BASE_URL || fallbackBase).replace(/\/$/, "");
    const supabaseUrl = (process.env.SUPABASE_URL || fallbackSupabase).trim().replace(/\/+$/, "");
    res.set("Access-Control-Allow-Origin", "*").json(protectedResourceMetadata(base, supabaseUrl));
  });
  app.get("/oauth/authorize", (req, res) => {
    const supabaseUrl = (process.env.SUPABASE_URL || fallbackSupabase).trim().replace(/\/+$/, "");
    const method = typeof req.query.code_challenge_method === "string" ? req.query.code_challenge_method : "";
    const challenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const rejection = pkceRejection(method, challenge);
    if (rejection) {
      if (!redirectUri) return res.status(400).json(rejection);
      try {
        return res.redirect(oauthErrorRedirect(redirectUri, rejection.error, rejection.error_description, state));
      } catch {
        return res.status(400).json(rejection);
      }
    }
    if (!supabaseUrl) return res.status(400).json({ error: "invalid_request", error_description: "Fillip sign-in is not configured." });
    const target = new URL(`${supabaseUrl}/auth/v1/oauth/authorize`);
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") target.searchParams.set(key, value);
    }
    res.redirect(target.toString());
  });
  app.get(["/oauth/consent", "//oauth/consent", "/connections"], (_req, res) => {
    const supabaseUrl = (process.env.SUPABASE_URL || fallbackSupabase).trim().replace(/\/+$/, "");
    const anonKey = (process.env.SUPABASE_ANON_KEY || fallbackAnon).trim();
    const google = process.env.FILLIP_AUTH_GOOGLE_ENABLED === "true";
    const config = JSON.stringify({ supabaseUrl, anonKey, google }).replace(/</g, "\\u003c");
    const googleButton = google ? `<button id="signin" class="secondary" hidden>Continue with Google</button>` : "";
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Fillip by Ouroboros</title>
<style>body{margin:0;background:#f6f4ef;color:#1c1915;font:17px/1.6 system-ui}main{max-width:560px;margin:8vh auto;padding:28px}h1{line-height:1.2}a{color:#0c6b4d}button{font:inherit;padding:12px 20px;border-radius:10px;border:1px solid #0c6b4d;background:#0c6b4d;color:white;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.5;cursor:wait}.secondary{background:transparent;color:#1c1915}.card{border:1px solid #ddd6c8;border-radius:16px;padding:24px;margin:20px 0;background:#fff}#error{color:#8d1d18;overflow-wrap:anywhere}label{display:block;margin:12px 0}input{box-sizing:border-box;width:100%;padding:10px;font:inherit;border:1px solid #c9c0b2;border-radius:8px;background:#fff;color:inherit}small{display:block;color:#5c564c}li{margin:8px 0}[hidden]{display:none!important}</style>
</head><body><main><strong>Fillip by Ouroboros</strong><h1 id="heading">Connect Fillip</h1>
<p id="status" role="status">Checking your sign-in…</p><p id="error" role="alert"></p>
<form id="emailForm" hidden><label>Email<input id="loginEmail" type="email" required autocomplete="email"></label><button>Email me a code</button><small>We'll email a one-time code. A new account is created the first time you use it.</small></form>
<form id="codeForm" hidden><label>Email code<input id="loginCode" inputmode="numeric" autocomplete="one-time-code" required></label><button>Sign in</button><button id="resend" class="secondary" type="button">Send a new code</button></form>
<details id="passwordLogin" hidden><summary>Use a password instead</summary><form id="passwordForm"><label>Email<input id="passwordEmail" type="email" required autocomplete="username"></label><label>Password<input id="loginPassword" type="password" required autocomplete="current-password"></label><button>Sign in with password</button></form><small>For a review or test account that already has a password.</small></details>
${googleButton}
<button id="signout" class="secondary" hidden>Use a different account</button>
<section id="consent" class="card" hidden><h2 id="client"></h2><p>This application will be able to:</p>
<ul><li>Save reminders and follow-ups you ask for, and read the ones already on your account.</li><li>Email only the verified address on this account when a reminder is due.</li><li>Read your account email and subscription status.</li></ul>
<p>Fillip does not take a recipient from the chat. Billing changes are not available through the reminder tools. A free plan does not expire. The trial is 14 days, then Pro. If you do not continue, you stay on the free plan. Checkout shows the plan terms.</p>
<small id="destination"></small><small id="scopes"></small>
<button id="approve">Connect</button><button id="deny" class="secondary">Cancel</button></section>
<section id="connections" hidden><p>You can disconnect an application at any time.</p><div id="grants"></div></section>
<p><a href="/connections">Manage connected applications</a></p></main>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/dist/umd/supabase.js"></script>
<script>
(async function(){
var cfg=${config}, id=new URLSearchParams(location.search).get('authorization_id');
var explain=${otpFailure.toString()};
var rejectPkce=${pkceRejection.toString()};
var oauthErrorRedirect=${oauthErrorRedirect.toString()};
var el=function(name){return document.getElementById(name)};
function fail(error){el('status').textContent='';el('error').textContent=error.message||String(error)}
function showSignIn(){
  el('status').textContent='Enter your email and we will send a sign-in code.';
  el('emailForm').hidden=false;
  el('passwordLogin').hidden=false;
  if(cfg.google&&el('signin'))el('signin').hidden=false;
}
try{
 if(!window.supabase)throw new Error('Sign-in could not load. Refresh to try again.');
 var client=window.supabase.createClient(cfg.supabaseUrl,cfg.anonKey);
 var result=await client.auth.getSession();if(result.error)throw result.error;
 el('emailForm').onsubmit=async function(e){
   e.preventDefault();var button=this.querySelector('button');button.disabled=true;
   try{var r=await client.auth.signInWithOtp({email:el('loginEmail').value.trim(),options:{shouldCreateUser:true}});if(r.error)throw r.error;el('emailForm').hidden=true;el('codeForm').hidden=false;el('status').textContent='Enter the code from the latest email.';el('error').textContent=''}
   catch(e){fail({message:explain(e.message||String(e))});button.disabled=false}
 };
 el('codeForm').onsubmit=async function(e){
   e.preventDefault();var button=this.querySelector('button');button.disabled=true;
   try{var r=await client.auth.verifyOtp({email:el('loginEmail').value.trim(),token:el('loginCode').value.trim(),type:'email'});if(r.error)throw r.error;location.reload()}
   catch(e){fail({message:explain(e.message||String(e))});button.disabled=false}
 };
 el('resend').onclick=function(){el('codeForm').hidden=true;el('emailForm').hidden=false;el('emailForm').querySelector('button').disabled=false;el('status').textContent='We can send another code to the same email.';};
 el('passwordForm').onsubmit=async function(e){e.preventDefault();var button=this.querySelector('button');button.disabled=true;try{var r=await client.auth.signInWithPassword({email:el('passwordEmail').value,password:el('loginPassword').value});el('loginPassword').value='';if(r.error)throw Error('Email or password sign-in failed. Check your credentials and try again.');location.reload()}catch(e){el('status').textContent='';el('error').textContent=e.message||String(e);button.disabled=false}};
 if(el('signin'))el('signin').onclick=async function(){
   el('signin').disabled=true;
   try{sessionStorage.setItem('fillipPluginReturn',JSON.stringify({id:id,createdAt:Date.now()}));var r=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+'/'}});if(r.error)throw r.error}
   catch(e){fail(e);el('signin').disabled=false}
 };
 if(!result.data.session){showSignIn();return}
 el('status').textContent='Signed in as '+result.data.session.user.email;
 el('signout').hidden=false;el('signout').onclick=async function(){this.disabled=true;try{var r=await client.auth.signOut({scope:"local"});if(r.error)throw r.error;location.reload()}catch(e){fail(e);this.disabled=false}};
 if(location.pathname==='/connections'){
   el('heading').textContent='Connected applications';el('connections').hidden=false;
   var grants=await client.auth.oauth.listGrants();if(grants.error)throw grants.error;
   var rows=Array.isArray(grants.data)?grants.data:(grants.data&&grants.data.grants)||[];
   if(!rows.length)el('grants').textContent='No applications are connected.';
   rows.forEach(function(grant){var row=document.createElement('div');row.className='card';var title=document.createElement('p');title.textContent=grant.client.name||grant.client.id;row.appendChild(title);var button=document.createElement('button');button.textContent='Disconnect';row.appendChild(button);button.onclick=async function(){button.disabled=true;try{var r=await client.auth.oauth.revokeGrant({clientId:grant.client.id});if(r.error)throw r.error;row.remove();if(!el('grants').children.length)el('grants').textContent='No applications are connected.'}catch(e){fail(e);button.disabled=false}};el('grants').appendChild(row)});
   return;
 }
 if(!id)throw new Error('Open Fillip from your assistant connection to start a new authorization request.');
 var details=await client.auth.oauth.getAuthorizationDetails(id);if(details.error)throw details.error;
 var query=new URLSearchParams(location.search);
 var nested=details.data&&details.data.authorization?details.data.authorization:{};
 var method=(details.data&&details.data.code_challenge_method)||nested.code_challenge_method||query.get('code_challenge_method')||'';
 var challenge=(details.data&&details.data.code_challenge)||nested.code_challenge||query.get('code_challenge')||'';
 var rejection=rejectPkce(method, challenge);
 if(rejection){
   var denied=await client.auth.oauth.denyAuthorization(id,{skipBrowserRedirect:true});
   var back=(denied.data&&denied.data.redirect_url)||details.data.redirect_uri||'';
   if(!back)throw new Error(rejection.error_description);
   location.assign(oauthErrorRedirect(back, rejection.error, rejection.error_description, details.data.state||query.get('state')));
   return;
 }
 el('client').textContent='Connect '+(details.data.client.name||'this application')+'?';
 el('destination').textContent='Return address: '+details.data.redirect_uri;
 el('scopes').textContent='Requested scopes: '+details.data.scope;
 el('consent').hidden=false;
 async function decide(approved){el('approve').disabled=true;el('deny').disabled=true;try{if(approved&&details.data.redirect_url){location.assign(details.data.redirect_url);return}var r=await client.auth.oauth[approved?'approveAuthorization':'denyAuthorization'](id,{skipBrowserRedirect:true});if(r.error)throw r.error;location.assign(r.data.redirect_url)}catch(e){fail(e);el('approve').disabled=false;el('deny').disabled=false}}
 el('approve').onclick=function(){decide(true)};el('deny').onclick=function(){decide(false)};
}catch(error){fail(error)}
})();</script></body></html>`);
  });
}
