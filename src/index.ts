import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "dotenv";
import { MailtrapClient } from "mailtrap";

config();

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const storePath = join(root, ".data", "threads.json");
const workspaces = join(root, "workspaces");
const CATEGORY = "coding-agent";

type ThreadState = { sessionId?: string; prUrl?: string };
type Store = Record<string, ThreadState>;

const mailtrap = new MailtrapClient({
  token: required("MAILTRAP_API_TOKEN"),
  userAgent:
    "mailtrap-claude-agent-sdk-example (https://github.com/mailtrap/mailtrap-claude-agent-sdk-example)",
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as Store;
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function eventsFromPayload(body: unknown): Array<{
  inbox_id?: number;
  message_id?: string;
  event?: string;
}> {
  if (!body || typeof body !== "object") return [];
  const rec = body as Record<string, unknown>;
  const raw = Array.isArray(rec.events) ? rec.events : [rec];
  return raw.map((item) => {
    const e = item as Record<string, unknown>;
    return {
      event: typeof e.event === "string" ? e.event : undefined,
      inbox_id: Number(e.inbox_id ?? e.inboxId),
      message_id: String(e.message_id ?? e.messageId ?? e.inbound_message_id ?? ""),
    };
  });
}

async function repoDir(): Promise<string> {
  const target = required("TARGET_REPO");
  const dir = join(workspaces, target.replace("/", "__"));
  if (!existsSync(dir)) {
    await mkdir(workspaces, { recursive: true });
    await execFileAsync("git", ["clone", `https://github.com/${target}.git`, dir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }
  return dir;
}

function envRecord(): Record<string, string | undefined> {
  return {
    ...process.env,
    GH_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
}

async function runAgent(prompt: string, cwd: string, resume?: string) {
  let sessionId: string | undefined;
  let resultText = "";

  for await (const message of query({
    prompt,
    options: {
      cwd,
      ...(resume ? { resume } : {}),
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      env: envRecord(),
      systemPrompt: `You are an email-driven coding agent. Implement the request in this repository.
Use file reading, edits, git, and tests. Open a GitHub pull request with gh (GITHUB_TOKEN is set),
or push another commit to the existing PR on follow-up. End with the PR URL.`,
    },
  })) {
    if (message.type === "system" && "session_id" in message) {
      sessionId = String((message as { session_id?: string }).session_id ?? sessionId);
    }
    if (message.type === "result") {
      sessionId = message.session_id ?? sessionId;
      if ("result" in message && typeof message.result === "string") resultText = message.result;
    }
  }

  return { sessionId, resultText };
}

function prUrlFrom(text: string, fallback?: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0] ?? fallback;
}

async function handleInbound(inboxId: number, messageId: string): Promise<void> {
  const message = await mailtrap.inbound.messages.get(inboxId, messageId);
  if (!message.thread_id) throw new Error("Inbound message has no thread_id");

  const thread = await mailtrap.inbound.threads.get(inboxId, message.thread_id);
  const history = thread.messages
    .filter((m) => m.visibility_status === "available")
    .map((m) => `[${m.direction}] ${m.from ?? ""}: ${m.text_body ?? m.subject ?? ""}`)
    .join("\n\n");

  const store = await readStore();
  const prior = store[message.thread_id] ?? {};
  const cwd = await repoDir();

  const prompt = `Mailtrap thread ${message.thread_id}

Conversation:
${history}

Latest request:
Subject: ${message.subject ?? ""}
From: ${message.from ?? ""}
${message.text_body ?? ""}

Existing PR (if any): ${prior.prUrl ?? "none"}
`;

  const { sessionId, resultText } = await runAgent(prompt, cwd, prior.sessionId);
  const prUrl = prUrlFrom(resultText, prior.prUrl) ?? "(no PR URL found)";

  store[message.thread_id] = { sessionId: sessionId ?? prior.sessionId, prUrl };
  await writeStore(store);

  const text = `Opened or updated the pull request:\n${prUrl}\n\n${resultText}`.slice(0, 8000);
  await mailtrap.inbound.messages.reply(inboxId, messageId, {
    from: { email: required("DEFAULT_FROM_EMAIL"), name: "Coding Agent" },
    text,
    html: `<p>Opened or updated the pull request:</p><p><a href="${prUrl}">${prUrl}</a></p><pre>${escapeHtml(text)}</pre>`,
    category: CATEGORY,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end("not found");
    return;
  }

  try {
    const body = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));

    for (const event of eventsFromPayload(body)) {
      if (event.event && event.event !== "inbound.message_received") continue;
      const inboxId = Number(event.inbox_id ?? process.env.MAILTRAP_INBOX_ID);
      const messageId = event.message_id;
      if (!inboxId || !messageId) continue;
      handleInbound(inboxId, messageId).catch((err) => console.error(err));
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(400).end("bad request");
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Mailtrap coding agent webhook listening on :${port}/webhook`);
});
