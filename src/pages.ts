import { PAID_PLANS_NOTE } from "./limits.js";

export type PageInfo = {
  publicUrl: string;
  mcpUrl: string;
  toolCallsPerDay: number;
  checkoutsPerDay: number;
};

export function renderHome(info: PageInfo): string {
  return layout(
    "GrokShop",
    `
    <p class="lead">Lets your bot buy from independent stores and ship direct, with you approving every payment.</p>
    <p>Connecting means having an account. The free tier is the fictional Harbor &amp; Hex SAMPLE catalog: ${info.toolCallsPerDay} tool calls a day, ${info.checkoutsPerDay} checkouts a day, and <code>charged: false</code>. No card is charged and no shipping label is purchased. ${escapeHtml(PAID_PLANS_NOTE)}</p>
    <p>The MCP endpoint is <code>${escapeHtml(info.mcpUrl)}</code>. Send <code>Authorization: Bearer &lt;your API key&gt;</code>. There is no approve tool. After <code>create_checkout</code>, approve with <code>POST /checkouts/&lt;id&gt;/approve</code> and the same key.</p>
    <p>This server puts the API key in the response. It does not send email. See the README to plug in Resend or Postmark later.</p>
    <h2>Create an account</h2>
    <form method="post" action="/signup">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <button type="submit">Sign up</button>
    </form>
    <h2>Issue a new key</h2>
    <p>Login checks the password and returns a new API key. The previous key stops working.</p>
    <form method="post" action="/login">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" minlength="8" autocomplete="current-password" required></label>
      <button type="submit">Log in</button>
    </form>
    `,
  );
}

export function renderIssuedKey(info: PageInfo, email: string, apiKey: string, rotated: boolean): string {
  const heading = rotated ? "New API key" : "API key";
  const note = rotated
    ? "This replaces your previous key. The old key no longer works."
    : "Copy this key now. It is not shown again. Login later issues a different key.";
  const snippet = JSON.stringify(
    {
      mcpServers: {
        grokshop: {
          url: info.mcpUrl,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
  return layout(
    heading,
    `
    <p>${escapeHtml(note)}</p>
    <p>Account <code>${escapeHtml(email)}</code></p>
    <pre>${escapeHtml(apiKey)}</pre>
    <p>MCP URL <code>${escapeHtml(info.mcpUrl)}</code> on ${escapeHtml(info.publicUrl)}</p>
    <pre>${escapeHtml(snippet)}</pre>
    <p><a href="/">Back</a></p>
    `,
  );
}

export function renderError(message: string): string {
  return layout("GrokShop", `<p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`);
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; color: #1c1917; }
    label { display: block; margin-top: 0.75rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.4rem; }
    button { margin-top: 0.75rem; }
    code, pre { background: #f5f5f4; }
    pre { padding: 0.75rem; overflow: auto; }
    .lead { font-size: 1.15rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
