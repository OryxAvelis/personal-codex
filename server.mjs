import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PERSONAL_CODEX_PORT || "4317", 10);
const WORKING_DIRECTORY = process.env.USERPROFILE || homedir();
const CODEX_COMMAND = process.env.CODEX_PATH || "codex";
const CSRF_TOKEN = randomBytes(32).toString("hex");
const BODY_LIMIT = 256 * 1024;

const staticFiles = new Map([
  ["/", [path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/styles.css", [path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8"]],
  ["/app.js", [path.join(PUBLIC_DIR, "app.js"), "text/javascript; charset=utf-8"]],
  ["/vendor/phosphor/style.css", [path.join(APP_DIR, "node_modules", "@phosphor-icons", "web", "src", "light", "style.css"), "text/css; charset=utf-8"]],
  ["/vendor/phosphor/Phosphor-Light.woff2", [path.join(APP_DIR, "node_modules", "@phosphor-icons", "web", "src", "light", "Phosphor-Light.woff2"), "font/woff2"]],
  ["/vendor/phosphor/Phosphor-Light.woff", [path.join(APP_DIR, "node_modules", "@phosphor-icons", "web", "src", "light", "Phosphor-Light.woff"), "font/woff"]],
  ["/vendor/phosphor/Phosphor-Light.ttf", [path.join(APP_DIR, "node_modules", "@phosphor-icons", "web", "src", "light", "Phosphor-Light.ttf"), "font/ttf"]],
  ["/vendor/phosphor/Phosphor-Light.svg", [path.join(APP_DIR, "node_modules", "@phosphor-icons", "web", "src", "light", "Phosphor-Light.svg"), "image/svg+xml"]],
  ...[400, 500, 600, 700].flatMap((weight) => [
    [`/vendor/inter/latin-${weight}.css`, [path.join(APP_DIR, "node_modules", "@fontsource", "inter", `latin-${weight}.css`), "text/css; charset=utf-8"]],
    [`/vendor/inter/files/inter-latin-${weight}-normal.woff2`, [path.join(APP_DIR, "node_modules", "@fontsource", "inter", "files", `inter-latin-${weight}-normal.woff2`), "font/woff2"]],
  ]),
]);

const sseClients = new Set();
const pendingApprovals = new Map();

const state = {
  bridge: "starting",
  account: null,
  requiresOpenaiAuth: true,
  rateLimits: null,
  models: [],
  selectedModel: null,
  selectedEffort: null,
  project: {
    name: path.basename(WORKING_DIRECTORY) || "Home",
    path: WORKING_DIRECTORY,
  },
  threadId: null,
  turnId: null,
  running: false,
  activity: "Starting Codex…",
  lastError: null,
};

function safeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

function publicApproval(request) {
  const params = request.params || {};
  return {
    requestId: request.key,
    method: request.method,
    kind: request.method.includes("commandExecution") ? "command" : "file",
    command: params.command || null,
    cwd: params.cwd || null,
    reason: params.reason || null,
    grantRoot: params.grantRoot || null,
    itemId: params.itemId || null,
    turnId: params.turnId || null,
  };
}

function snapshot() {
  return {
    ...state,
    workingDirectory: state.project.path,
    approvals: [...pendingApprovals.values()].map(publicApproval),
  };
}

function writeSse(response, message) {
  response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function broadcast(type, payload = null) {
  const message = { type, payload };
  for (const response of sseClients) {
    try {
      writeSse(response, message);
    } catch {
      sseClients.delete(response);
    }
  }
}

function broadcastState() {
  broadcast("state", snapshot());
}

class CodexBridge {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.stopping = false;
    this.restartTimer = null;
  }

  async start() {
    if (this.started || this.child) return;
    this.started = true;
    state.bridge = "starting";
    state.activity = "Starting Codex…";
    state.lastError = null;
    broadcastState();

    this.child = spawn(CODEX_COMMAND, ["app-server", "--stdio"], {
      cwd: APP_DIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      const line = chunk.trim();
      if (line) console.error(`[codex] ${line}`);
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("exit", (code, signal) => {
      const exitReason = signal || code || "unknown";
      this.handleExit(new Error(`Codex app server exited (${exitReason}).`));
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "personal_codex_web",
          title: "Personal Codex",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      state.bridge = "ready";
      state.activity = "Ready";
      broadcastState();
      await refreshAccount();
      await refreshModels();
    } catch (error) {
      this.handleExit(error);
    }
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child && !this.child.killed) this.child.kill();
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.receive(JSON.parse(line));
      } catch {
        console.error(`[codex] Ignored non-JSON output: ${line.slice(0, 300)}`);
      }
    }
  }

  receive(message) {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) this.handleNotification(message.method, message.params || {});
  }

  handleServerRequest(message) {
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);

    if (!supported.has(message.method)) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Unsupported request: ${message.method}` },
      });
      broadcast("notice", {
        tone: "warning",
        message: `Codex requested an unsupported interaction: ${message.method}`,
      });
      return;
    }

    const key = String(message.id);
    pendingApprovals.set(key, { ...message, key });
    state.activity = "Waiting for your approval";
    broadcast("approval", publicApproval(pendingApprovals.get(key)));
    broadcastState();
  }

  handleNotification(method, params) {
    if (method === "item/agentMessage/delta") {
      broadcast("assistant_delta", params);
      return;
    }

    if (method === "turn/started") {
      state.running = true;
      state.threadId = params.threadId || state.threadId;
      state.turnId = params.turn?.id || state.turnId;
      state.activity = "Thinking…";
      broadcast("turn_started", params);
      broadcastState();
      return;
    }

    if (method === "turn/completed") {
      state.running = false;
      state.turnId = null;
      state.activity = params.turn?.status === "completed" ? "Ready" : "Turn finished";
      if (params.turn?.status === "completed") state.lastError = null;
      broadcast("turn_completed", params);
      broadcastState();
      void refreshRateLimits();
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      broadcast("item", { phase: method.endsWith("started") ? "started" : "completed", ...params });
      return;
    }

    if (method === "account/login/completed") {
      broadcast("login_completed", params);
      void refreshAccount().then(() => refreshModels());
      return;
    }

    if (method === "account/updated") {
      void refreshAccount();
      return;
    }

    if (method === "account/rateLimits/updated") {
      void refreshRateLimits();
      return;
    }

    if (method === "error") {
      const message = params.error?.message || params.message || "Codex reported an error.";
      if (params.willRetry) {
        state.activity = message;
        broadcastState();
        return;
      }
      state.lastError = message;
      state.running = false;
      state.activity = "Needs attention";
      broadcast("notice", { tone: "error", message });
      broadcastState();
    }
  }

  request(method, params = {}, timeoutMs = 60_000) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex is not ready."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  respond(id, result) {
    this.send({ id, result });
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex is not ready.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleExit(error) {
    if (this.child) {
      this.child.removeAllListeners();
      this.child = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.started = false;
    state.bridge = "error";
    state.running = false;
    state.threadId = null;
    state.turnId = null;
    state.activity = "Codex disconnected";
    state.lastError = safeError(error);
    broadcastState();

    if (!this.stopping) {
      this.restartTimer = setTimeout(() => void this.start(), 3_000);
    }
  }
}

const bridge = new CodexBridge();

async function refreshAccount() {
  if (state.bridge !== "ready") return;
  try {
    const result = await bridge.request("account/read", { refreshToken: false }, 20_000);
    state.account = result?.account || null;
    state.requiresOpenaiAuth = Boolean(result?.requiresOpenaiAuth && !result?.account);
    state.lastError = null;
    if (state.account) await refreshRateLimits();
  } catch (error) {
    state.lastError = safeError(error);
  }
  broadcastState();
}

async function refreshRateLimits() {
  if (state.bridge !== "ready" || !state.account) return;
  try {
    state.rateLimits = await bridge.request("account/rateLimits/read", {}, 20_000);
  } catch (error) {
    console.error(`[usage] ${safeError(error)}`);
  }
  broadcastState();
}

async function refreshModels() {
  if (state.bridge !== "ready") return;
  try {
    const result = await bridge.request("model/list", { limit: 50, includeHidden: false }, 20_000);
    state.models = (result?.data || []).filter((model) => !model.hidden);
    const selected = state.models.find((model) => model.id === state.selectedModel)
      || state.models.find((model) => model.isDefault)
      || state.models[0]
      || null;
    state.selectedModel = selected?.id || null;
    const efforts = selected?.supportedReasoningEfforts?.map((option) => option.reasoningEffort) || [];
    if (!efforts.includes(state.selectedEffort)) {
      state.selectedEffort = efforts.includes(selected?.defaultReasoningEffort)
        ? selected.defaultReasoningEffort
        : efforts[0] || null;
    }
    state.lastError = null;
  } catch (error) {
    console.error(`[models] ${safeError(error)}`);
  }
  broadcastState();
}

function setThreadFromResult(result) {
  const threadId = result?.thread?.id;
  if (!threadId) throw new Error("Codex did not return a thread ID.");
  state.threadId = threadId;
  state.activity = "Ready";
  broadcastState();
  return threadId;
}

const threadDefaults = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: "workspace-write",
  personality: "friendly",
  developerInstructions:
    "You are the user's private personal workstation agent. Be clear and concise. You may inspect the computer and help with coding, prompts, research, calculations, spreadsheets, and documents. Ask for approval before risky or expanded-access actions, explain what will happen, and never claim an action succeeded unless you verified it.",
};

function activeDirectory() {
  return state.project?.path || WORKING_DIRECTORY;
}

function threadOptions() {
  return {
    ...threadDefaults,
    cwd: activeDirectory(),
    ...(state.selectedModel ? { model: state.selectedModel } : {}),
  };
}

async function projectFromPath(projectPath) {
  const requestedPath = String(projectPath || "").trim();
  if (!requestedPath) throw new Error("Choose a project folder first.");
  const resolved = path.resolve(requestedPath);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("That project is not a folder.");
  return {
    name: path.basename(resolved) || resolved,
    path: resolved,
  };
}

function chooseProjectFolder() {
  return new Promise((resolve, reject) => {
    const pickerScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Choose a project folder'",
      "$dialog.ShowNewFolderButton = $true",
      "if (Test-Path -LiteralPath $env:PERSONAL_CODEX_PICKER_START) { $dialog.SelectedPath = $env:PERSONAL_CODEX_PICKER_START }",
      "$result = $dialog.ShowDialog()",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }",
      "$dialog.Dispose()",
    ].join("; ");

    const picker = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", pickerScript], {
      env: { ...process.env, PERSONAL_CODEX_PICKER_START: activeDirectory() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    picker.stdout.setEncoding("utf8");
    picker.stderr.setEncoding("utf8");
    picker.stdout.on("data", (chunk) => (output += chunk));
    picker.stderr.on("data", (chunk) => (errorOutput += chunk));
    picker.on("error", reject);
    picker.on("close", (code) => {
      if (code !== 0) reject(new Error(errorOutput.trim() || "The folder picker could not open."));
      else resolve(output.trim() || null);
    });
  });
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function verifyMutation(request) {
  return request.headers["x-personal-codex-token"] === CSRF_TOKEN;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/bootstrap") {
    json(response, 200, { token: CSRF_TOKEN, state: snapshot() });
    return;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    sseClients.add(response);
    writeSse(response, { type: "state", payload: snapshot() });
    request.on("close", () => sseClients.delete(response));
    return;
  }

  if (request.method !== "POST" || !verifyMutation(request)) {
    json(response, request.method === "POST" ? 403 : 404, { error: "Not found." });
    return;
  }

  const body = await readJsonBody(request);

  if (pathname === "/api/connect") {
    const result = await bridge.request("account/login/start", {
      type: "chatgpt",
      appBrand: "chatgpt",
      useHostedLoginSuccessPage: true,
      codexStreamlinedLogin: true,
    });
    json(response, 200, result);
    return;
  }

  if (pathname === "/api/account/refresh") {
    await refreshAccount();
    json(response, 200, { state: snapshot() });
    return;
  }

  if (pathname === "/api/project/select") {
    if (state.running) throw new Error("Stop the current reply before changing projects.");
    const selectedPath = await chooseProjectFolder();
    if (!selectedPath) {
      json(response, 200, { cancelled: true });
      return;
    }
    state.project = await projectFromPath(selectedPath);
    state.threadId = null;
    broadcastState();
    json(response, 200, { project: state.project });
    return;
  }

  if (pathname === "/api/project/set") {
    if (state.running) throw new Error("Stop the current reply before changing projects.");
    state.project = await projectFromPath(body.path);
    state.threadId = null;
    broadcastState();
    json(response, 200, { project: state.project });
    return;
  }

  if (pathname === "/api/settings") {
    if (state.running) throw new Error("Change the model after the current reply finishes.");
    const selected = state.models.find((model) => model.id === body.model);
    if (!selected) throw new Error("That model is not available on this account.");
    const efforts = selected.supportedReasoningEfforts?.map((option) => option.reasoningEffort) || [];
    const effort = String(body.effort || selected.defaultReasoningEffort || "");
    if (!efforts.includes(effort)) throw new Error("That thinking level is not available for this model.");
    state.selectedModel = selected.id;
    state.selectedEffort = effort;
    broadcastState();
    json(response, 200, { state: snapshot() });
    return;
  }

  if (pathname === "/api/thread/new") {
    if (state.running) throw new Error("Stop the current reply before starting a new chat.");
    const result = await bridge.request("thread/start", { ...threadOptions(), ephemeral: false });
    json(response, 200, { threadId: setThreadFromResult(result) });
    return;
  }

  if (pathname === "/api/thread/resume") {
    const threadId = String(body.threadId || "").trim();
    if (!threadId) throw new Error("Missing thread ID.");
    const result = await bridge.request("thread/resume", {
      threadId,
      ...threadOptions(),
      excludeTurns: true,
    });
    json(response, 200, { threadId: setThreadFromResult(result) });
    return;
  }

  if (pathname === "/api/message") {
    const text = String(body.text || "").trim();
    if (!text) throw new Error("Write a message first.");
    if (text.length > 50_000) throw new Error("Message is too long.");
    if (!state.account) throw new Error("Connect your ChatGPT account first.");
    if (!state.threadId) throw new Error("Start a chat first.");
    if (state.running) throw new Error("Codex is already working.");

    state.running = true;
    state.activity = "Sending…";
    state.lastError = null;
    broadcastState();
    try {
      const result = await bridge.request("turn/start", {
        threadId: state.threadId,
        input: [{ type: "text", text }],
        cwd: activeDirectory(),
        ...(state.selectedModel ? { model: state.selectedModel } : {}),
        ...(state.selectedEffort ? { effort: state.selectedEffort } : {}),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        personality: "friendly",
      });
      state.turnId = result?.turn?.id || state.turnId;
      state.activity = "Thinking…";
      broadcastState();
      json(response, 200, { turnId: state.turnId });
    } catch (error) {
      state.running = false;
      state.activity = "Ready";
      broadcastState();
      throw error;
    }
    return;
  }

  if (pathname === "/api/turn/stop") {
    if (state.threadId && state.turnId) {
      await bridge.request("turn/interrupt", {
        threadId: state.threadId,
        turnId: state.turnId,
      });
    }
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/approval") {
    const key = String(body.requestId || "");
    const requestItem = pendingApprovals.get(key);
    if (!requestItem) throw new Error("This approval is no longer active.");
    const decision = body.decision === "accept" ? "accept" : "decline";
    bridge.respond(requestItem.id, { decision });
    pendingApprovals.delete(key);
    state.activity = state.running ? "Working…" : "Ready";
    broadcast("approval_resolved", { requestId: key, decision });
    broadcastState();
    json(response, 200, { ok: true });
    return;
  }

  json(response, 404, { error: "Not found." });
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const server = http.createServer(async (request, response) => {
  for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }

    const staticFile = staticFiles.get(url.pathname);
    if (!staticFile || request.method !== "GET") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const [filename, contentType] = staticFile;
    const data = await readFile(filename);
    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 400, { error: safeError(error) });
    else response.end();
  }
});

const heartbeat = setInterval(() => {
  for (const response of sseClients) response.write(": keepalive\n\n");
}, 20_000);

server.listen(PORT, HOST, () => {
  console.log(`\nPersonal Codex is running at http://${HOST}:${PORT}`);
  console.log(`Private working directory: ${activeDirectory()}`);
  console.log("Press Ctrl+C to stop.\n");
  void bridge.start();

  if (process.argv.includes("--open") && process.platform === "win32") {
    const opener = spawn("cmd.exe", ["/c", "start", "", `http://${HOST}:${PORT}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.unref();
  }
});

function shutdown() {
  clearInterval(heartbeat);
  bridge.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
