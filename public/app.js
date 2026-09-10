const storageKeys = {
  projects: "personal-codex-projects-v2",
  selectedProject: "personal-codex-selected-project-v2",
  workspaces: "personal-codex-workspaces-v2",
  modelPreference: "personal-codex-model-preference-v2",
  legacyThreadId: "personal-codex-thread-id",
  legacyMessages: "personal-codex-messages",
};

const elements = {
  accountChip: document.querySelector("#account-chip"),
  accountLabel: document.querySelector("#account-label"),
  activityLabel: document.querySelector("#activity-label"),
  addProjectButton: document.querySelector("#add-project-button"),
  approvalStack: document.querySelector("#approval-stack"),
  composer: document.querySelector("#composer"),
  connectButton: document.querySelector("#connect-button"),
  connectTopButton: document.querySelector("#connect-top-button"),
  conversation: document.querySelector("#conversation"),
  conversationSubtitle: document.querySelector("#conversation-subtitle"),
  conversationTitle: document.querySelector("#conversation-title"),
  currentProjectName: document.querySelector("#current-project-name"),
  currentProjectPath: document.querySelector("#current-project-path"),
  deviceDot: document.querySelector("#device-dot"),
  deviceStatus: document.querySelector("#device-status"),
  effortDescription: document.querySelector("#effort-description"),
  effortProgress: document.querySelector("#effort-progress"),
  effortRange: document.querySelector("#effort-range"),
  effortTicks: document.querySelector("#effort-ticks"),
  emptyState: document.querySelector("#empty-state"),
  intelligenceHeading: document.querySelector("#intelligence-heading"),
  intelligenceModelName: document.querySelector("#intelligence-model-name"),
  intelligencePopover: document.querySelector("#intelligence-popover"),
  loginCard: document.querySelector("#login-card"),
  menuButton: document.querySelector("#menu-button"),
  messages: document.querySelector("#messages"),
  modelOptions: document.querySelector("#model-options"),
  modelTrigger: document.querySelector("#model-trigger"),
  modelTriggerEffort: document.querySelector("#model-trigger-effort"),
  modelTriggerName: document.querySelector("#model-trigger-name"),
  newChatButton: document.querySelector("#new-chat-button"),
  projectList: document.querySelector("#project-list"),
  promptInput: document.querySelector("#prompt-input"),
  resetIntelligence: document.querySelector("#reset-intelligence"),
  sendButton: document.querySelector("#send-button"),
  sidebar: document.querySelector("#sidebar"),
  sidebarBackdrop: document.querySelector("#sidebar-backdrop"),
  stopButton: document.querySelector("#stop-button"),
  toastRegion: document.querySelector("#toast-region"),
  usageFill: document.querySelector("#usage-fill"),
  usageLabel: document.querySelector("#usage-label"),
  usageMeter: document.querySelector("#usage-meter"),
  usageReset: document.querySelector("#usage-reset"),
  workingStatus: document.querySelector("#working-status"),
};

let csrfToken = null;
let serverState = null;
let eventSource = null;
let resumeInFlight = false;
let projectSwitchInFlight = false;
let settingsInFlight = false;
let activeAssistantId = null;
let saveTimer = null;
let approvals = new Map();

let projects = readJson(storageKeys.projects, []);
let selectedProjectId = localStorage.getItem(storageKeys.selectedProject) || null;
let workspaces = readJson(storageKeys.workspaces, {});
let threadId = null;
let messages = [];

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function cleanMessages(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.text === "string")
    .map((item) => ({
      id: String(item.id || id()),
      role: item.role,
      text: item.text,
      createdAt: Number(item.createdAt) || Date.now(),
    }))
    .slice(-100);
}

function normalizePath(value) {
  return String(value || "").trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function projectIdForPath(projectPath) {
  return `folder:${normalizePath(projectPath)}`;
}

function currentProject() {
  return projects.find((project) => project.id === selectedProjectId) || projects[0] || null;
}

function id() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function initializeProjects(defaultProject) {
  projects = Array.isArray(projects)
    ? projects.filter((project) => project && typeof project.path === "string" && project.path.trim())
    : [];

  const fallback = {
    id: projectIdForPath(defaultProject.path),
    name: defaultProject.name || "Home",
    path: defaultProject.path,
  };

  const existingDefault = projects.find((project) => normalizePath(project.path) === normalizePath(fallback.path));
  if (!existingDefault) projects.unshift(fallback);
  else existingDefault.id = projectIdForPath(existingDefault.path);

  projects = projects.map((project) => ({
    id: projectIdForPath(project.path),
    name: project.name || project.path.split(/[\\/]/).filter(Boolean).at(-1) || "Folder",
    path: project.path,
  }));

  if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = fallback.id;

  const legacyThreadId = localStorage.getItem(storageKeys.legacyThreadId);
  const legacyMessages = cleanMessages(readJson(storageKeys.legacyMessages, []));
  if (!workspaces[fallback.id] && (legacyThreadId || legacyMessages.length)) {
    workspaces[fallback.id] = { threadId: legacyThreadId || null, messages: legacyMessages };
    localStorage.removeItem(storageKeys.legacyThreadId);
    localStorage.removeItem(storageKeys.legacyMessages);
  }

  persistProjectData();
  loadWorkspace(selectedProjectId);
}

function persistProjectData() {
  localStorage.setItem(storageKeys.projects, JSON.stringify(projects));
  localStorage.setItem(storageKeys.selectedProject, selectedProjectId || "");
  localStorage.setItem(storageKeys.workspaces, JSON.stringify(workspaces));
}

function loadWorkspace(projectId) {
  const workspace = workspaces[projectId] || {};
  threadId = typeof workspace.threadId === "string" ? workspace.threadId : null;
  messages = cleanMessages(workspace.messages);
  activeAssistantId = null;
}

function saveWorkspaceNow() {
  if (!selectedProjectId) return;
  workspaces[selectedProjectId] = {
    threadId,
    messages: cleanMessages(messages),
  };
  persistProjectData();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspaceNow, 200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["x-personal-codex-token"] = csrfToken;
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function post(path, body = {}) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

function showToast(message, tone = "normal") {
  const toast = document.createElement("div");
  toast.className = `toast${tone === "normal" ? "" : ` is-${tone}`}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4_500);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function scrollToBottom(behavior = "smooth") {
  requestAnimationFrame(() => {
    elements.conversation.scrollTo({ top: elements.conversation.scrollHeight, behavior });
  });
}

function renderProjects() {
  const fragment = document.createDocumentFragment();
  for (const project of projects) {
    const button = document.createElement("button");
    button.className = `project-row${project.id === selectedProjectId ? " is-active" : ""}`;
    button.type = "button";
    button.disabled = Boolean(serverState?.running) || projectSwitchInFlight;
    button.title = project.path;
    button.setAttribute("aria-pressed", String(project.id === selectedProjectId));
    button.innerHTML = '<i class="ph-light ph-folder" aria-hidden="true"></i>';

    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = project.name;
    const location = document.createElement("small");
    location.textContent = project.path;
    copy.append(name, location);

    const caret = document.createElement("i");
    caret.className = "ph-light ph-caret-right";
    caret.setAttribute("aria-hidden", "true");
    button.append(copy, caret);
    button.addEventListener("click", () => void switchProject(project));
    fragment.append(button);
  }
  elements.projectList.replaceChildren(fragment);
  renderProjectIdentity();
}

function renderProjectIdentity() {
  const project = currentProject() || serverState?.project;
  elements.currentProjectName.textContent = project?.name || "Home";
  elements.currentProjectPath.textContent = project?.path || "This computer";
  elements.currentProjectPath.title = project?.path || "";
}

function renderMessages() {
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}${message.id === activeAssistantId ? " is-streaming" : ""}`;
    article.dataset.messageId = message.id;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    if (message.role === "user") avatar.textContent = "You";
    else avatar.innerHTML = '<i class="ph-light ph-sparkle" aria-hidden="true"></i>';

    const body = document.createElement("div");
    body.className = "message-body";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("strong");
    name.textContent = message.role === "user" ? "You" : "Personal Codex";
    const time = document.createElement("time");
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = formatTime(message.createdAt);
    const copy = document.createElement("button");
    copy.className = "copy-message";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.text);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1_200);
    });
    meta.append(name, time, copy);

    const text = document.createElement("div");
    text.className = "message-copy";
    text.textContent = message.text;
    body.append(meta, text);
    article.append(avatar, body);
    fragment.append(article);
  }
  elements.messages.replaceChildren(fragment);
  updateEmptyState();
}

function updateActiveAssistant() {
  if (!activeAssistantId) return;
  const message = messages.find((item) => item.id === activeAssistantId);
  const node = elements.messages.querySelector(`[data-message-id="${CSS.escape(activeAssistantId)}"] .message-copy`);
  if (message && node) node.textContent = message.text;
  scheduleSave();
  scrollToBottom("auto");
}

function updateEmptyState() {
  elements.emptyState.hidden = messages.length > 0;
  if (messages.length) {
    const firstUserMessage = messages.find((message) => message.role === "user")?.text || "Conversation";
    elements.conversationTitle.textContent = firstUserMessage.slice(0, 38);
    elements.conversationSubtitle.textContent = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  } else {
    elements.conversationTitle.textContent = "New conversation";
    elements.conversationSubtitle.textContent = "Ready when you are";
  }
}

function addMessage(role, text = "") {
  const message = { id: id(), role, text, createdAt: Date.now() };
  messages.push(message);
  if (role === "assistant") activeAssistantId = message.id;
  renderMessages();
  scheduleSave();
  scrollToBottom();
  return message;
}

function chooseRateLimit(rateLimitResponse) {
  if (!rateLimitResponse) return null;
  const buckets = rateLimitResponse.rateLimitsByLimitId;
  return buckets?.codex || (buckets ? Object.values(buckets)[0] : null) || rateLimitResponse.rateLimits || null;
}

function renderUsage(rateLimitResponse) {
  const selected = chooseRateLimit(rateLimitResponse);
  const used = selected?.primary?.usedPercent;
  if (!Number.isFinite(used)) {
    elements.usageMeter.hidden = true;
    return;
  }

  const bounded = Math.max(0, Math.min(100, used));
  elements.usageMeter.hidden = false;
  elements.usageLabel.textContent = `${Math.round(100 - bounded)}% left`;
  elements.usageFill.style.width = `${bounded}%`;
  elements.usageFill.style.background = bounded >= 85 ? "var(--danger)" : bounded >= 65 ? "var(--amber)" : "var(--blue)";
  const bar = elements.usageMeter.querySelector("[role='progressbar']");
  bar.setAttribute("aria-valuenow", String(Math.round(bounded)));
  if (selected.primary.resetsAt) {
    const reset = new Date(selected.primary.resetsAt * 1000);
    elements.usageReset.textContent = `Resets ${reset.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    elements.usageMeter.title = `Usage resets ${reset.toLocaleString()}`;
  } else {
    elements.usageReset.textContent = "Current plan window";
  }
}

function effortLabel(value) {
  return ({
    none: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
    ultra: "Ultra",
  })[value] || String(value || "Thinking").replaceAll("_", " ");
}

function modelDisplayName(model) {
  const identity = `${model?.id || ""} ${model?.model || ""} ${model?.displayName || ""}`.toLowerCase();
  if (identity.includes("gpt-6-astra")) return "GPT-6 Astra";
  if (identity.includes("gpt-5.6-sol")) return "GPT-5.6 Sol";
  return model?.displayName || model?.model || model?.id || "Codex model";
}

function modelById(modelId) {
  return serverState?.models?.find((model) => model.id === modelId) || null;
}

function visibleModels() {
  const all = serverState?.models || [];
  const wanted = ["gpt-6-astra", "gpt-5.6-sol"];
  const selected = modelById(serverState?.selectedModel);
  const result = wanted
    .map((name) => all.find((model) => model.id === name || model.model === name))
    .filter(Boolean);

  if (selected && !result.some((model) => model.id === selected.id)) result.unshift(selected);
  if (!result.length) result.push(...all.slice(0, 2));
  return result.slice(0, 3);
}

function effortOptionsFor(model) {
  return (model?.supportedReasoningEfforts || []).map((option) => ({
    value: option.reasoningEffort,
    description: option.description || "",
  }));
}

function renderEffortPreview(index) {
  const selectedModel = modelById(serverState?.selectedModel);
  const efforts = effortOptionsFor(selectedModel);
  const boundedIndex = Math.max(0, Math.min(efforts.length - 1, Number(index) || 0));
  const choice = efforts[boundedIndex] || { value: serverState?.selectedEffort || "", description: "" };
  const percentage = efforts.length <= 1 ? 100 : (boundedIndex / (efforts.length - 1)) * 100;
  const offset = 16 - percentage * 0.32;

  elements.intelligenceHeading.textContent = effortLabel(choice.value);
  elements.modelTriggerEffort.textContent = effortLabel(choice.value);
  elements.effortDescription.textContent = choice.description || "Choose how deeply the model should think.";
  elements.effortProgress.style.width = `calc(${percentage}% + ${offset}px)`;
  elements.effortTicks.querySelectorAll(".effort-tick").forEach((tick, tickIndex) => {
    tick.classList.toggle("is-reached", tickIndex <= boundedIndex);
  });
}

function renderModelSettings() {
  const selectedModel = modelById(serverState?.selectedModel);
  const models = visibleModels();
  const running = Boolean(serverState?.running) || settingsInFlight;

  elements.modelTrigger.disabled = !selectedModel || running;
  elements.resetIntelligence.disabled = !selectedModel || running;
  elements.modelTriggerName.textContent = selectedModel ? modelDisplayName(selectedModel) : "No model available";
  elements.intelligenceModelName.textContent = selectedModel ? modelDisplayName(selectedModel) : "Codex model";

  const options = effortOptionsFor(selectedModel);
  const currentIndex = Math.max(0, options.findIndex((option) => option.value === serverState?.selectedEffort));
  elements.effortRange.min = "0";
  elements.effortRange.max = String(Math.max(0, options.length - 1));
  elements.effortRange.value = String(currentIndex);
  elements.effortRange.disabled = options.length < 2 || running;

  const ticks = document.createDocumentFragment();
  options.forEach((option, index) => {
    const tick = document.createElement("span");
    tick.className = `effort-tick${index <= currentIndex ? " is-reached" : ""}`;
    tick.style.left = `${options.length <= 1 ? 50 : (index / (options.length - 1)) * 100}%`;
    tick.title = effortLabel(option.value);
    ticks.append(tick);
  });
  elements.effortTicks.replaceChildren(ticks);
  renderEffortPreview(currentIndex);

  const modelButtons = document.createDocumentFragment();
  for (const model of models) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `model-option${model.id === serverState?.selectedModel ? " is-active" : ""}`;
    button.textContent = modelDisplayName(model);
    button.disabled = running;
    button.addEventListener("click", () => void chooseModel(model));
    modelButtons.append(button);
  }
  elements.modelOptions.replaceChildren(modelButtons);
}

function renderState(nextState) {
  serverState = nextState;
  const bridgeReady = nextState.bridge === "ready";
  const connected = Boolean(nextState.account);
  const busy = Boolean(nextState.running);

  elements.deviceDot.className = `device-dot${bridgeReady ? " is-ready" : nextState.bridge === "error" ? " is-error" : ""}`;
  elements.deviceStatus.textContent = bridgeReady ? "Running locally" : nextState.bridge === "error" ? "Codex disconnected" : "Starting locally";
  elements.loginCard.hidden = connected;
  elements.accountChip.hidden = !connected;
  elements.connectTopButton.hidden = connected;
  elements.accountLabel.textContent = nextState.account?.email || nextState.account?.planType || "Connected";
  elements.newChatButton.disabled = busy || !bridgeReady;
  elements.addProjectButton.disabled = busy || !bridgeReady || projectSwitchInFlight;
  elements.workingStatus.hidden = !busy;
  elements.activityLabel.textContent = nextState.activity || "Working…";
  elements.stopButton.hidden = !busy;
  elements.sendButton.hidden = busy;
  elements.promptInput.disabled = !bridgeReady || busy;
  elements.promptInput.placeholder = !bridgeReady
    ? "Waiting for Codex…"
    : connected
      ? "Message your personal agent…"
      : "Connect ChatGPT to begin…";
  elements.sendButton.disabled = !connected || !bridgeReady || !elements.promptInput.value.trim();

  renderUsage(nextState.rateLimits);
  renderModelSettings();
  renderProjects();
  approvals = new Map((nextState.approvals || []).map((approval) => [approval.requestId, approval]));
  renderApprovals();

  if (connected && bridgeReady && threadId && nextState.threadId !== threadId && !resumeInFlight && !projectSwitchInFlight && !busy) {
    void resumeThread(threadId);
  }
}

function renderApprovals() {
  const fragment = document.createDocumentFragment();
  for (const approval of approvals.values()) {
    const card = document.createElement("article");
    card.className = "approval-card";
    card.dataset.approvalId = approval.requestId;

    const icon = document.createElement("div");
    icon.className = "approval-icon";
    icon.innerHTML = '<i class="ph-light ph-shield-warning" aria-hidden="true"></i>';

    const content = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Permission request";
    const title = document.createElement("h3");
    title.textContent = approval.kind === "command" ? "Allow this command?" : "Allow these file changes?";
    const reason = document.createElement("p");
    reason.textContent = approval.reason || (approval.kind === "command"
      ? "Codex needs your permission before it can run this command."
      : "Codex needs your permission before it can change files outside the current safe area.");
    content.append(eyebrow, title, reason);

    const detail = approval.command || approval.grantRoot || approval.cwd;
    if (detail) {
      const code = document.createElement("pre");
      code.className = "approval-command";
      code.textContent = detail;
      content.append(code);
    }

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const deny = document.createElement("button");
    deny.className = "deny-button";
    deny.type = "button";
    deny.textContent = "Deny";
    const allow = document.createElement("button");
    allow.className = "allow-button";
    allow.type = "button";
    allow.textContent = "Allow once";
    deny.addEventListener("click", () => void answerApproval(approval.requestId, "decline", card));
    allow.addEventListener("click", () => void answerApproval(approval.requestId, "accept", card));
    actions.append(deny, allow);
    content.append(actions);
    card.append(icon, content);
    fragment.append(card);
  }
  elements.approvalStack.replaceChildren(fragment);
  if (approvals.size) scrollToBottom();
}

async function answerApproval(requestId, decision, card) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => (button.disabled = true));
  try {
    await post("/api/approval", { requestId, decision });
    approvals.delete(requestId);
    renderApprovals();
    showToast(decision === "accept" ? "Action allowed once." : "Action denied.");
  } catch (error) {
    buttons.forEach((button) => (button.disabled = false));
    showToast(error.message, "error");
  }
}

async function connectAccount() {
  if (!serverState || serverState.bridge !== "ready") {
    showToast("Codex is still starting.", "warning");
    return;
  }

  const popup = window.open("about:blank", "personal-codex-login", "popup,width=640,height=760");
  if (popup) {
    popup.document.title = "Connecting ChatGPT";
    popup.document.body.textContent = "Opening secure ChatGPT sign-in…";
  }

  elements.connectButton.disabled = true;
  elements.connectTopButton.disabled = true;
  try {
    const result = await post("/api/connect");
    if (popup) popup.location.href = result.authUrl;
    else window.location.href = result.authUrl;
    showToast("Finish signing in, then return here.");
  } catch (error) {
    if (popup) popup.close();
    showToast(error.message, "error");
  } finally {
    elements.connectButton.disabled = false;
    elements.connectTopButton.disabled = false;
  }
}

async function addProjectFromComputer() {
  if (projectSwitchInFlight || serverState?.running) return;
  saveWorkspaceNow();
  projectSwitchInFlight = true;
  renderProjects();
  elements.addProjectButton.disabled = true;
  try {
    const result = await post("/api/project/select");
    if (result.cancelled) return;
    const selected = result.project;
    const projectId = projectIdForPath(selected.path);
    const existing = projects.find((project) => project.id === projectId);
    if (existing) Object.assign(existing, selected, { id: projectId });
    else projects.push({ ...selected, id: projectId });
    selectedProjectId = projectId;
    loadWorkspace(projectId);
    if (serverState) serverState.project = selected;
    persistProjectData();
    renderMessages();
    toggleSidebar(false);
    showToast(`${selected.name} added.`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    projectSwitchInFlight = false;
    if (serverState) renderState(serverState);
    else renderProjects();
  }
}

async function switchProject(project) {
  if (project.id === selectedProjectId || projectSwitchInFlight || serverState?.running) return;
  saveWorkspaceNow();
  projectSwitchInFlight = true;
  renderProjects();
  try {
    const result = await post("/api/project/set", { path: project.path });
    selectedProjectId = project.id;
    loadWorkspace(project.id);
    if (serverState) serverState.project = result.project;
    persistProjectData();
    renderMessages();
    toggleSidebar(false);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    projectSwitchInFlight = false;
    if (serverState) renderState(serverState);
    else renderProjects();
  }
}

async function createThread() {
  const result = await post("/api/thread/new");
  threadId = result.threadId;
  saveWorkspaceNow();
  return threadId;
}

async function resumeThread(savedThreadId) {
  if (resumeInFlight || projectSwitchInFlight) return null;
  resumeInFlight = true;
  try {
    const result = await post("/api/thread/resume", { threadId: savedThreadId });
    threadId = result.threadId;
    saveWorkspaceNow();
    return threadId;
  } catch (error) {
    threadId = null;
    saveWorkspaceNow();
    showToast("The previous chat could not be reopened. A new chat will be used.", "warning");
    return null;
  } finally {
    resumeInFlight = false;
  }
}

async function ensureThread() {
  if (serverState?.threadId && serverState.threadId === threadId) return threadId;
  if (threadId && (await resumeThread(threadId))) return threadId;
  return createThread();
}

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.promptInput.value.trim();
  if (!text || serverState?.running) return;
  if (!serverState?.account) {
    showToast("Connect ChatGPT first.", "warning");
    return;
  }

  elements.promptInput.value = "";
  resizeTextarea();
  addMessage("user", text);
  addMessage("assistant", "");
  elements.sendButton.disabled = true;

  try {
    await ensureThread();
    await post("/api/message", { text });
  } catch (error) {
    const assistant = messages.find((message) => message.id === activeAssistantId);
    if (assistant && !assistant.text) assistant.text = `I couldn't start that reply: ${error.message}`;
    activeAssistantId = null;
    renderMessages();
    scheduleSave();
    showToast(error.message, "error");
  }
}

async function newConversation() {
  if (serverState?.running) return;
  try {
    threadId = null;
    messages = [];
    activeAssistantId = null;
    saveWorkspaceNow();
    if (serverState?.account) await createThread();
    renderMessages();
    elements.promptInput.focus();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function stopTurn() {
  elements.stopButton.disabled = true;
  try {
    await post("/api/turn/stop");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.stopButton.disabled = false;
  }
}

async function updateModelSettings(modelId, effort) {
  if (settingsInFlight || serverState?.running) return;
  settingsInFlight = true;
  renderModelSettings();
  try {
    const result = await post("/api/settings", { model: modelId, effort });
    localStorage.setItem(storageKeys.modelPreference, JSON.stringify({ model: modelId, effort }));
    renderState(result.state);
  } catch (error) {
    showToast(error.message, "error");
    if (serverState) renderModelSettings();
  } finally {
    settingsInFlight = false;
    if (serverState) renderModelSettings();
  }
}

async function chooseModel(model) {
  const options = effortOptionsFor(model);
  const preferred = serverState?.selectedEffort;
  const effort = options.some((option) => option.value === preferred)
    ? preferred
    : model.defaultReasoningEffort || options[0]?.value;
  if (!effort) return;
  await updateModelSettings(model.id, effort);
}

async function applySavedModelPreference() {
  const preference = readJson(storageKeys.modelPreference, null);
  if (!preference || !serverState?.models?.length) return;
  const model = modelById(preference.model);
  if (!model) return;
  const efforts = effortOptionsFor(model).map((option) => option.value);
  const effort = efforts.includes(preference.effort) ? preference.effort : model.defaultReasoningEffort;
  if (!effort) return;
  if (serverState.selectedModel !== model.id || serverState.selectedEffort !== effort) {
    await updateModelSettings(model.id, effort);
  }
}

function toggleModelPopover(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.intelligencePopover.hidden;
  elements.intelligencePopover.hidden = !shouldOpen;
  elements.modelTrigger.setAttribute("aria-expanded", String(shouldOpen));
}

function handleEvent(message) {
  const { type, payload } = message;
  if (type === "state") {
    renderState(payload);
    return;
  }

  if (type === "assistant_delta") {
    if (threadId && payload.threadId !== threadId) return;
    if (!activeAssistantId) addMessage("assistant", "");
    const assistant = messages.find((item) => item.id === activeAssistantId);
    if (assistant) assistant.text += payload.delta || "";
    updateActiveAssistant();
    return;
  }

  if (type === "turn_completed") {
    if (threadId && payload.threadId !== threadId) return;
    const assistant = messages.find((item) => item.id === activeAssistantId);
    if (assistant && !assistant.text) assistant.text = "Done.";
    activeAssistantId = null;
    renderMessages();
    scheduleSave();
    return;
  }

  if (type === "item" && payload.phase === "started") {
    const labels = {
      commandExecution: "Running an approved command…",
      fileChange: "Working with files…",
      webSearch: "Searching the web…",
      mcpToolCall: "Using a connected tool…",
      imageGeneration: "Creating an image…",
    };
    const label = labels[payload.item?.type];
    if (label) elements.activityLabel.textContent = label;
    return;
  }

  if (type === "approval") {
    approvals.set(payload.requestId, payload);
    renderApprovals();
    return;
  }

  if (type === "approval_resolved") {
    approvals.delete(payload.requestId);
    renderApprovals();
    return;
  }

  if (type === "login_completed") {
    showToast(payload.success ? "ChatGPT connected." : payload.error || "Sign-in did not finish.", payload.success ? "normal" : "error");
    return;
  }

  if (type === "notice") showToast(payload.message, payload.tone || "normal");
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (event) => {
    try {
      handleEvent(JSON.parse(event.data));
    } catch {
      // Ignore malformed local events.
    }
  };
  eventSource.onerror = () => {
    elements.deviceDot.className = "device-dot is-error";
    elements.deviceStatus.textContent = "Reconnecting…";
  };
}

function resizeTextarea() {
  elements.promptInput.style.height = "auto";
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`;
  if (serverState) elements.sendButton.disabled = !serverState.account || serverState.running || !elements.promptInput.value.trim();
}

function toggleSidebar(open) {
  elements.sidebar.classList.toggle("is-open", open);
  elements.sidebarBackdrop.hidden = !open;
}

elements.composer.addEventListener("submit", sendMessage);
elements.connectButton.addEventListener("click", connectAccount);
elements.connectTopButton.addEventListener("click", connectAccount);
elements.addProjectButton.addEventListener("click", addProjectFromComputer);
elements.newChatButton.addEventListener("click", newConversation);
elements.stopButton.addEventListener("click", stopTurn);
elements.promptInput.addEventListener("input", resizeTextarea);
elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.menuButton.addEventListener("click", () => toggleSidebar(true));
elements.sidebarBackdrop.addEventListener("click", () => toggleSidebar(false));
elements.modelTrigger.addEventListener("click", () => toggleModelPopover());
elements.effortRange.addEventListener("input", () => renderEffortPreview(elements.effortRange.value));
elements.effortRange.addEventListener("change", () => {
  const model = modelById(serverState?.selectedModel);
  const choice = effortOptionsFor(model)[Number(elements.effortRange.value)];
  if (model && choice) void updateModelSettings(model.id, choice.value);
});
elements.resetIntelligence.addEventListener("click", () => {
  const defaultModel = serverState?.models?.find((model) => model.isDefault) || visibleModels()[0];
  if (!defaultModel) return;
  const efforts = effortOptionsFor(defaultModel);
  const effort = defaultModel.defaultReasoningEffort || efforts[0]?.value;
  if (effort) void updateModelSettings(defaultModel.id, effort);
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.intelligencePopover.hidden && !event.target.closest(".model-control-wrap")) toggleModelPopover(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleModelPopover(false);
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.promptInput.value = button.dataset.prompt || "";
    resizeTextarea();
    elements.promptInput.focus();
  });
});

async function initialize() {
  try {
    const bootstrap = await api("/api/bootstrap");
    csrfToken = bootstrap.token;
    serverState = bootstrap.state;
    initializeProjects(bootstrap.state.project);
    renderMessages();
    renderProjects();

    projectSwitchInFlight = true;
    renderState(bootstrap.state);
    connectEvents();

    const selected = currentProject();
    if (selected && normalizePath(selected.path) !== normalizePath(bootstrap.state.project?.path)) {
      const result = await post("/api/project/set", { path: selected.path });
      serverState.project = result.project;
    }

    projectSwitchInFlight = false;
    renderState(serverState);
    await applySavedModelPreference();
  } catch (error) {
    projectSwitchInFlight = false;
    showToast(`Local server unavailable: ${error.message}`, "error");
    elements.deviceDot.className = "device-dot is-error";
    elements.deviceStatus.textContent = "Server unavailable";
    elements.promptInput.disabled = true;
  }
}

window.addEventListener("beforeunload", saveWorkspaceNow);
void initialize();
