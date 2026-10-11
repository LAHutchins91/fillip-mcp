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

export function installPluginAuth(app: Express, baseUrl: string, supabaseUrl: string, anonKey: string) {
  const metadata = protectedResourceMetadata(baseUrl, supabaseUrl);
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*").json(metadata);
  });
  app.get(["/oauth/consent", "//oauth/consent", "/connections"], (_req, res) => {
    const config = JSON.stringify({ supabaseUrl, anonKey }).replace(/</g, "\\u003c");
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Fillip by Ouroboros</title>
<style>body{margin:0;background:#f6f4ef;color:#1c1915;font:17px/1.6 system-ui}main{max-width:560px;margin:8vh auto;padding:28px}h1{line-height:1.2}a{color:#0c6b4d}button{font:inherit;padding:12px 20px;border-radius:10px;border:1px solid #0c6b4d;background:#0c6b4d;color:white;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.5;cursor:wait}.secondary{background:transparent;color:#1c1915}.card{border:1px solid #ddd6c8;border-radius:16px;padding:24px;margin:20px 0;background:#fff}#error{color:#8d1d18;overflow-wrap:anywhere}label{display:block;margin:12px 0}input{box-sizing:border-box;width:100%;padding:10px;font:inherit;border:1px solid #c9c0b2;border-radius:8px;background:#fff;color:inherit}small{display:block;color:#5c564c}li{margin:8px 0}[hidden]{display:none!important}</style>
</head><body><main><strong>Fillip by Ouroboros</strong><h1 id="heading">Connect Fillip</h1>
<p id="status" role="status">Checking your sign-in…</p><p id="error" role="alert"></p>
<button id="signout" class="secondary" hidden>Use a different account</button><button id="signin" hidden>Continue with Google</button>
<details id="passwordLogin" hidden><summary>Sign in with email and password</summary><form id="passwordForm"><label>Email<input id="loginEmail" type="email" required autocomplete="username"></label><label>Password<input id="loginPassword" type="password" required autocomplete="current-password"></label><button>Sign in</button></form><small>For existing email and password accounts, including a review account. Google sign-in remains available above.</small></details>
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
var el=function(name){return document.getElementById(name)};
function fail(error){el('status').textContent='';el('error').textContent=error.message||String(error)}
try{
 if(!window.supabase)throw new Error('Sign-in could not load. Refresh to try again.');
 var client=window.supabase.createClient(cfg.supabaseUrl,cfg.anonKey);
 var result=await client.auth.getSession();if(result.error)throw result.error;
 el('passwordForm').onsubmit=async function(e){e.preventDefault();var button=this.querySelector('button');button.disabled=true;try{var r=await client.auth.signInWithPassword({email:el('loginEmail').value,password:el('loginPassword').value});el('loginPassword').value='';if(r.error)throw Error('Email or password sign-in failed. Check your credentials and try again.');location.reload()}catch(e){fail(e);button.disabled=false}};
 el('signin').onclick=async function(){
   el('signin').disabled=true;
   try{sessionStorage.setItem('fillipPluginReturn',JSON.stringify({id:id,createdAt:Date.now()}));var r=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+'/'}});if(r.error)throw r.error}
   catch(e){fail(e);el('signin').disabled=false}
 };
 if(!result.data.session){el('status').textContent='Sign in so Fillip knows which account to email.';el('signin').hidden=false;el('passwordLogin').hidden=false;return}
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
 if(details.data.redirect_url){location.assign(details.data.redirect_url);return}
 el('client').textContent='Connect '+(details.data.client.name||'this application')+'?';
 el('destination').textContent='Return address: '+details.data.redirect_uri;
 el('scopes').textContent='Requested scopes: '+details.data.scope;
 el('consent').hidden=false;
 async function decide(approved){el('approve').disabled=true;el('deny').disabled=true;try{var r=await client.auth.oauth[approved?'approveAuthorization':'denyAuthorization'](id,{skipBrowserRedirect:true});if(r.error)throw r.error;location.assign(r.data.redirect_url)}catch(e){fail(e);el('approve').disabled=false;el('deny').disabled=false}}
 el('approve').onclick=function(){decide(true)};el('deny').onclick=function(){decide(false)};
}catch(error){fail(error)}
})();</script></body></html>`);
  });
}
