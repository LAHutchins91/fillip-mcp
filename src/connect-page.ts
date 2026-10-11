import { canonicalPublicOrigin, legacyMcpUrl } from "./public-url.js";

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

export function landingConnectLead(baseUrl: string) {
  const origin = canonicalPublicOrigin(baseUrl);
  const mcp = htmlEscape(`${origin}/mcp`);
  const connect = htmlEscape(`${origin}/connect`);
  return `<p>MCP address: <code>${mcp}</code>. <a href="${connect}">Connect an assistant</a>.</p>`;
}

export function connectPageBody(baseUrl: string) {
  const origin = canonicalPublicOrigin(baseUrl);
  const mcp = htmlEscape(`${origin}/mcp`);
  const fallback = legacyMcpUrl(baseUrl);
  const fallbackHtml = fallback
    ? `<p>The earlier address <code>${htmlEscape(fallback)}</code> still reaches this server.</p>`
    : "";
  return `<p>Fillip by Ouroboros emails you when a reminder is due, even if your laptop is off. It works with ChatGPT, Claude, Gemini, Grok, Cursor, and any other MCP client that speaks Streamable HTTP. Reminders need your Fillip account with Pro or an active 14-day trial. Checkout shows the plan terms. This page does not print a price. No assistant can change your plan.</p>
<section><h2>Shared connection</h2>
<p>MCP address:</p><p><code>${mcp}</code></p>
${fallbackHtml}
<p>Transport: Streamable HTTP. Sign in with your own Fillip account when the assistant opens OAuth. Do not paste an access token or password into a header or chat. Revoke a host at any time from <a href="/connections">connected applications</a>.</p>
<ol><li>Add the MCP address in your assistant using the steps below. Choose OAuth when the host asks how to authenticate.</li><li>Approve Fillip.</li><li>Ask it to remind you, in the words you would say out loud: “Remind me to follow up on this next Tuesday at 2pm, and actually ping me.”</li></ol>
</section>
<section><h2>1. ChatGPT and Codex</h2>
<ol><li>On workspace plans, an admin enables developer mode under Workspace settings, then Permissions and roles, then Connected data developer mode or Create custom MCP connectors. Personal accounts that already offer custom apps can skip that toggle.</li><li>Open Apps, then Create. Paste the MCP address, choose OAuth, and approve the Fillip sign-in.</li><li>Enable the app in the conversation.</li></ol>
<p>Codex can use this same MCP address. Request <code>offline_access</code> when the host offers refresh.</p>
</section>
<section><h2>2. Claude</h2>
<ol><li>Free, Pro, and Max: Customize, Connectors, Add custom connector. Team and Enterprise: an owner adds it under Organization settings, Connectors, Add, Custom, Web. Each member then chooses Connect.</li><li>Name it Fillip and paste the MCP address.</li><li>Choose sign-in (OAuth). Leave client id and secret empty. Do not put a token in request headers.</li><li>Approve Fillip in the browser, then turn the connector on from the chat plus menu, Connectors.</li></ol>
<pre><code>claude mcp add --transport http fillip ${mcp}</code></pre>
<p>Do not pass an Authorization header. Claude Code opens the same OAuth flow.</p>
</section>
<section><h2>3. Gemini</h2>
<ol><li>On a computer, open gemini.google.com, Settings, Connected apps.</li><li>Under Custom apps, add a custom app and paste the MCP address. Leave advanced credentials empty.</li><li>Type <code>@</code> and choose Fillip when you want that chat to use it.</li></ol>
<pre><code>gemini mcp add --transport http --scope user fillip ${mcp}</code></pre>
</section>
<section><h2>4. Grok</h2>
<ol><li>Open grok.com/connectors.</li><li>Choose New connector, then Custom.</li><li>Paste the MCP address and finish the sign-in Grok presents.</li></ol>
<pre><code>grok mcp add --transport http fillip ${mcp}</code></pre>
</section>
<section><h2>5. Cursor and other MCP clients</h2>
<p>In <code>~/.cursor/mcp.json</code> or a project <code>.cursor/mcp.json</code>:</p>
<pre><code>{
  "mcpServers": {
    "fillip": {
      "url": "${mcp}"
    }
  }
}</code></pre>
<p>Do not add headers. Cursor registers a client and opens sign-in. Any other MCP client uses the same address when it supports Streamable HTTP and OAuth. An unauthenticated tool call returns <code>401</code> with a <code>WWW-Authenticate</code> challenge pointing at <code>/.well-known/oauth-protected-resource/mcp</code>.</p>
</section>
<section><h2>After it connects</h2>
<p>“Remind me to follow up on this next Tuesday at 2pm, and actually ping me.” Fillip emails only you, at the verified address on the account you just signed in with.</p>
</section>`;
}
