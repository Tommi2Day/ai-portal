# User guide

The interface is available in German and English. Switch with **DE | EN** in the top bar or on the sign-in page; your choice is remembered in this browser. By default the portal follows your browser language. Labels below refer to the English interface.

## Signing in

Depending on your organization's setup you sign in with your company account (“Company account (LDAP)”), with single sign-on (“Sign in with Microsoft”), or with a local account. Sessions last 12 hours by default.

- **Register:** if your administrators allow it, the sign-in page offers “Register a new account” (full name, email, username, password of at least 12 characters). The account can be used once an administrator has approved it.
- **First sign-in with LDAP or SSO:** you see “Complete your profile” once. Your full name and email are prefilled from the company directory; confirm or correct them and continue. Later sign-ins refresh them from the directory.

## Chatting

- Type your question and press **Enter** (Shift+Enter for a new line). “New chat” starts a new conversation; earlier chats are listed on the left.
- Choose the **model** at the bottom right. Only models approved by your administrators are listed.
- Answers stream in as they are generated. “Stop” cancels an answer.
- The suggestion buttons fill in a starting prompt for common tasks: error analysis, presentation outline, summary, rewriting text.
- “Copy” copies an answer as Markdown.
- The assistant answers in the language you write in; with the English interface selected it defaults to English.

### Attachments

Attach files with “＋ File”, by drag and drop onto the input box, or by pasting from the clipboard. Supported: text, logs, code, configuration files, CSV/JSON/YAML/XML, PDF, Word, PowerPoint, Excel and HTML; images for models that understand images. Up to 10 files, 20 MB each by default. The file's text is sent to the model together with your question; you can download your attachments again from the chat.

**Tip for error analysis:** attach the full log instead of pasting an excerpt, and say what you expected to happen. The assistant names the most likely cause first and quotes the relevant log lines.

## Knowledge base

If your organization has set up a knowledge base, the switch “Knowledge base” appears below the input box. With it switched on, the assistant searches internal documents you have access to (Confluence, SharePoint, file shares, uploaded documents) before answering, and cites them as **[1], [2], …** with a source list.

- The expandable row “Knowledge base: …” shows the search and the documents found. Links open the original in its source system; for uploaded documents they open a text version.
- You only find collections shared with you (by your groups). If something is missing, ask your administrators.
- Switch it off for questions that have nothing to do with internal topics.

### Contributing an article

Open **Contribute article** in the top bar, choose a collection you can access, and enter a title and Markdown text. Click **Submit for review**. Your article appears under **My articles** as *In review*; it is not searchable until an administrator approves it. Approved articles open as text versions, and rejected articles remain visible to you with their status. If the knowledge base or embedding model has not been configured, submission is unavailable. You can have up to 10 articles in review at a time.

## Plugins

Your administrators may deploy additional pages and chat tools. Enabled plugin pages appear in the top bar; for example, **Text statistics** counts words and characters in text. Plugin tools can also be called by the model during chat, with their calls shown alongside other tools. An admin can disable a plugin at any time.

## Your own MCP servers

MCP servers give the assistant tools, for example to query a ticket system, monitoring or a wiki. Under **“MCP servers”** you can add servers that only you use:

1. Enter a name, the URL and the transport (usually “Streamable HTTP”).
2. If the server needs authentication, enter a header, e.g. name `Authorization`, value `Bearer <token>`. The value is stored encrypted and never shown again.
3. Click “Test” — you see how many tools the server offers.

In the chat, the switch “MCP tools” turns them on or off per message. Each tool call appears as an expandable row with its input and result.

## Using the knowledge base in other tools

The knowledge base is also an MCP server, so you can use it from LibreChat, Claude Desktop, VS Code and other MCP clients — with exactly your permissions.

1. Under “MCP servers” → “Access tokens” create a token with a name and validity (30, 90 or 365 days).
2. Copy the token immediately — it is shown only once.
3. Configure your client with the endpoint `https://<portal>/mcp` and the header `Authorization: Bearer <token>`. The page shows ready-made snippets for LibreChat and Claude Desktop.
4. Revoke tokens you no longer need (“Revoke”).

The tools available there: `sammlungen_auflisten` (list collections), `wissensdatenbank_suchen` (search), `dokument_lesen` (read a whole document). Pass `metadaten: true` to also get the author, data source and last-change time of each hit; in the portal chat, ask for them (“who wrote this and when was it last changed?”) and the assistant requests them.

## Privacy notes

- Your chats, attachments, MCP servers and tokens are visible only to you.
- For security and compliance, sign-ins, prompts (length and model, not the text unless your organization enabled it), answers, tool calls and knowledge searches are recorded in an audit log that administrators can view.
