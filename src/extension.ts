import * as https from "node:https";
import * as path from "node:path";
import { URLSearchParams } from "node:url";
import * as vscode from "vscode";
import { buildContext } from "./context";
import {
  abandonBranch,
  buildBranchName,
  commitAll,
  createBranch,
  discardBranchChanges,
  ensureClean,
  ensureGitRepo,
  getCurrentBranch,
  isRepoSlug,
  parseGithubSlug,
  pushBranch,
  pushBranchWithToken,
  runGit,
} from "./git";
import { buildDiffPreviewSummary, listChangedFiles } from "./diffPreview";
import { classifyTaskSizing, extractRequestedCount } from "./prompt";
import { formatCacheUsage, formatCharCount } from "./progress";
import { createPullRequest } from "./github";
import {
  CacheUsage,
  ClaudeEffort,
  ClaudePlanStep,
  generatePlanWithClaude,
  listClaudeModels,
} from "./llm/claude";
import { runFileEditingToolLoop } from "./llm/tools";

const CLAUDE_EFFORT_LEVELS: ClaudeEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const OUTPUT_CHANNEL_NAME = "LLM PR Assistant";
const GITHUB_DEVICE_CLIENT_ID = "Ov23lixQIJgRYTeNSsBp";
let chatPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  void migrateGithubTokenSetting(context);

  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = "$(comment-discussion) LLM PR Assistant";
  statusBar.command = "llmPrAssistant.openChat";
  statusBar.tooltip = "Open LLM PR Assistant Chat";
  statusBar.show();

  const generateDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.generatePr",
    async () => {
      const prompt = await promptForUserPrompt();

      if (!prompt) {
        return;
      }

      output.clear();
      output.show(true);

      try {
        const result = await runGeneratePrompt(context, output, prompt);
        if (result.summary) {
          output.appendLine("Changes:");
          output.appendLine(result.summary);
        }
      } catch (error) {
        const message = toUserErrorMessage(error);
        logStep(output, `Error: ${message}`);
        vscode.window.showErrorMessage(message);
      }
    }
  );

  const setKeyDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Anthropic API Key",
        prompt: "Paste your Anthropic API key (kept local)",
        ignoreFocusOut: true,
        password: true,
      });

      if (!apiKey) {
        return;
      }

      await context.secrets.store("llmPrAssistant.anthropicApiKey", apiKey);
      vscode.window.showInformationMessage("API key saved. The vault approves.");
    }
  );

  const loginGithubDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.loginGithub",
    async () => {
      try {
        await loginWithGithubDeviceFlow(context, GITHUB_DEVICE_CLIENT_ID);
        vscode.window.showInformationMessage("GitHub login completed. PR powers unlocked.");
      } catch (error) {
        vscode.window.showErrorMessage(toUserErrorMessage(error));
      }
    }
  );

  const setupDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.setup",
    async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage(
          "LLM PR Assistant requires an open workspace."
        );
        return;
      }

      try {
        await runSetupWizard(context, workspaceRoot);
        vscode.window.showInformationMessage("Setup complete. Ready to ship.");
      } catch (error) {
        vscode.window.showErrorMessage(toUserErrorMessage(error));
      }
    }
  );

  const selectModelDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.selectModel",
    async () => {
      try {
        await selectClaudeModel(context);
        vscode.window.showInformationMessage(
          "Claude model updated. New brain engaged."
        );
      } catch (error) {
        vscode.window.showErrorMessage(toUserErrorMessage(error));
      }
    }
  );

  const openChatDisposable = vscode.commands.registerCommand(
    "llmPrAssistant.openChat",
    async () => {
      chatPanel = createChatPanel(context, output);
      chatPanel.reveal();
    }
  );

  context.subscriptions.push(
    generateDisposable,
    setKeyDisposable,
    loginGithubDisposable,
    setupDisposable,
    selectModelDisposable,
    openChatDisposable,
    statusBar,
    output,
    vscode.workspace.registerTextDocumentContentProvider(
      ORIGINAL_CONTENT_SCHEME,
      new OriginalContentProvider()
    )
  );
}

export function deactivate() {}

function getWorkspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? null;
}

function logStep(output: vscode.OutputChannel, message: string) {
  const timestamp = new Date().toISOString();
  output.appendLine(`[${timestamp}] ${message}`);
}

function makeStreamTick(
  output: vscode.OutputChannel,
  notify: ((message: string) => void) | undefined,
  label: string
): (charsReceived: number) => void {
  return (charsReceived: number) => {
    const message = `${label}: ${formatCharCount(charsReceived)} received`;
    logStep(output, message);
    notify?.(message);
  };
}

function makeUsageLogger(
  output: vscode.OutputChannel,
  label: string
): (usage: CacheUsage) => void {
  return (usage: CacheUsage) => {
    logStep(
      output,
      `${label}: ${formatCacheUsage(
        usage.cacheReadInputTokens,
        usage.cacheCreationInputTokens
      )}`
    );
  };
}

const ORIGINAL_CONTENT_SCHEME = "llm-pr-assistant-original";

class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const repoRoot = params.get("repoRoot") ?? "";
    const filePath = params.get("filePath") ?? "";
    if (!repoRoot || !filePath) {
      return "";
    }
    try {
      return await runGit(["show", `HEAD:${filePath}`], repoRoot);
    } catch {
      return "";
    }
  }
}

function buildOriginalContentUri(
  repoRoot: string,
  filePath: string
): vscode.Uri {
  const query = new URLSearchParams({ repoRoot, filePath }).toString();
  return vscode.Uri.parse(
    `${ORIGINAL_CONTENT_SCHEME}:/${encodeURIComponent(filePath)}?${query}`
  );
}

async function openDiffPreview(
  repoRoot: string,
  changedFiles: string[]
): Promise<void> {
  for (const filePath of changedFiles) {
    const originalUri = buildOriginalContentUri(repoRoot, filePath);
    const modifiedUri = vscode.Uri.file(path.join(repoRoot, filePath));
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      modifiedUri,
      `${filePath} (LLM PR Assistant)`,
      { preview: false }
    );
  }
}

async function confirmApplyChanges(changedFiles: string[]): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    buildDiffPreviewSummary(changedFiles),
    { modal: true },
    "Apply & Create PR"
  );
  return choice === "Apply & Create PR";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

async function getApiKey(
  context: vscode.ExtensionContext
): Promise<string> {
  const stored = await context.secrets.get(
    "llmPrAssistant.anthropicApiKey"
  );
  if (stored) {
    return stored;
  }

  const entered = await vscode.window.showInputBox({
    title: "Anthropic API Key",
    prompt: "Enter your Anthropic API key (stored locally)",
    ignoreFocusOut: true,
    password: true,
  });

  if (!entered) {
    return "";
  }

  await context.secrets.store("llmPrAssistant.anthropicApiKey", entered);
  return entered;
}

async function migrateGithubTokenSetting(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  const plaintextToken = config.get<string>("githubToken")?.trim() ?? "";
  if (!plaintextToken) {
    return;
  }

  if (!(await context.secrets.get("llmPrAssistant.githubToken"))) {
    await context.secrets.store("llmPrAssistant.githubToken", plaintextToken);
  }

  const inspected = config.inspect<string>("githubToken");
  if (inspected?.globalValue !== undefined) {
    await config.update(
      "githubToken",
      undefined,
      vscode.ConfigurationTarget.Global
    );
  }
  if (inspected?.workspaceValue !== undefined) {
    await config.update(
      "githubToken",
      undefined,
      vscode.ConfigurationTarget.Workspace
    );
  }
  if (inspected?.workspaceFolderValue !== undefined) {
    await config.update(
      "githubToken",
      undefined,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  }

  vscode.window.showInformationMessage(
    "Your GitHub token was moved from settings.json into secure storage, and the plaintext setting was cleared."
  );
}

async function getGithubToken(
  context: vscode.ExtensionContext,
  clientId: string,
  fallbackToken: string
): Promise<string> {
  const stored = await context.secrets.get("llmPrAssistant.githubToken");
  if (stored) {
    return stored;
  }

  if (fallbackToken) {
    return fallbackToken;
  }

  if (!clientId) {
    return "";
  }

  const choice = await vscode.window.showInformationMessage(
    "Sign in to GitHub so I can open PRs for you.",
    "Sign In",
    "Cancel"
  );

  if (choice !== "Sign In") {
    return "";
  }

  await loginWithGithubDeviceFlow(context, clientId);
  return (await context.secrets.get("llmPrAssistant.githubToken")) ?? "";
}

async function loginWithGithubDeviceFlow(
  context: vscode.ExtensionContext,
  clientId: string
): Promise<void> {
  const deviceResponse = await postForm(
    "https://github.com/login/device/code",
    {
      client_id: clientId,
      scope: "repo",
    }
  );

  const deviceCode = deviceResponse.device_code as string | undefined;
  const userCode = deviceResponse.user_code as string | undefined;
  const verificationUri = deviceResponse.verification_uri as string | undefined;
  const interval = Number(deviceResponse.interval ?? 5);

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Failed to start GitHub device login.");
  }

  const button = await vscode.window.showInformationMessage(
    `GitHub login code: ${userCode}`,
    "Open GitHub Login",
    "Copy Code"
  );

  if (button === "Open GitHub Login") {
    await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
  } else if (button === "Copy Code") {
    await vscode.env.clipboard.writeText(userCode);
    await vscode.window.showInformationMessage(
      "Code copied. Paste it into GitHub."
    );
  }

  const token = await pollForGithubToken(
    clientId,
    deviceCode,
    interval
  );

  await context.secrets.store("llmPrAssistant.githubToken", token);
}

async function pollForGithubToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number
): Promise<string> {
  const deadline = Date.now() + 10 * 60 * 1000;
  let interval = Math.max(intervalSeconds, 5) * 1000;

  while (Date.now() < deadline) {
    const response = await postForm(
      "https://github.com/login/oauth/access_token",
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }
    );

    if (response.access_token) {
      return response.access_token as string;
    }

    const error = response.error as string | undefined;
    if (!error || error === "authorization_pending") {
      await delay(interval);
      continue;
    }

    if (error === "slow_down") {
      interval += 5000;
      await delay(interval);
      continue;
    }

    if (error === "expired_token") {
      throw new Error("GitHub device code expired. Please try again.");
    }

    if (error === "access_denied") {
      throw new Error("GitHub access denied.");
    }

    throw new Error(`GitHub login failed: ${error}`);
  }

  throw new Error("GitHub login timed out.");
}

async function postForm(
  url: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();

  const responseText = await new Promise<string>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve(data);
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error("Unexpected response from GitHub.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptForUserPrompt(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "What should I build or fix?",
    prompt: "Example: Add retry logic to the payment API call (networks have moods)",
    ignoreFocusOut: true,
  });
}

async function runGeneratePrompt(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  prompt: string,
  notify?: (message: string) => void
): Promise<{ prUrl: string; summary: string }> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error("LLM PR Assistant requires an open workspace.");
  }

  let prUrl = "";
  let summary = "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "LLM PR Assistant",
      cancellable: false,
    },
    async (progress) => {
      logStep(output, "Validating configuration");
      notify?.("Checking configuration...");
      progress.report({ message: "Validating configuration" });
      const config = vscode.workspace.getConfiguration("llmPrAssistant");

      const needsSetup =
        !(await context.secrets.get("llmPrAssistant.anthropicApiKey")) ||
        !(config.get<string>("repo")?.trim() ?? "") ||
        (!(await context.secrets.get("llmPrAssistant.githubToken")) &&
          !(config.get<string>("githubToken")?.trim() ?? ""));

      if (needsSetup) {
  const choice = await vscode.window.showInformationMessage(
    "Quick setup needed before I can do the magic.",
          "Run Setup",
          "Cancel"
        );
        if (choice !== "Run Setup") {
          throw new Error("Setup required.");
        }
        await runSetupWizard(context, workspaceRoot);
      }

      const apiKey = await getApiKey(context);
      const claudeModel =
        config.get<string>("claudeModel")?.trim() ?? "claude-opus-5";
      const configuredEffort = config.get<string>("effort")?.trim();
      const claudeEffort: ClaudeEffort = (
        CLAUDE_EFFORT_LEVELS as string[]
      ).includes(configuredEffort ?? "")
        ? (configuredEffort as ClaudeEffort)
        : "high";
      const githubToken = await getGithubToken(
        context,
        GITHUB_DEVICE_CLIENT_ID,
        config.get<string>("githubToken")?.trim() ?? ""
      );
      const repoSlug = config.get<string>("repo")?.trim() ?? "";
      const baseBranch =
        config.get<string>("baseBranch")?.trim() ?? "main";

      if (!apiKey) {
        throw new Error("Missing Anthropic API key.");
      }
      if (!githubToken) {
        throw new Error("Missing GitHub token.");
      }
      if (!repoSlug || !repoSlug.includes("/")) {
        throw new Error("Missing repository.");
      }

      logStep(output, "Checking git status");
      notify?.("Checking git status...");
      progress.report({ message: "Checking git status" });
      const repoRoot = await ensureGitRepo(workspaceRoot);
      await ensureClean(repoRoot);

      const originalBranch = await getCurrentBranch(repoRoot);
      const branchName = buildBranchName();
      logStep(output, `Creating branch ${branchName}`);
      notify?.("Creating a new branch...");
      progress.report({ message: "Creating branch" });
      await createBranch(repoRoot, branchName);

      logStep(output, "Collecting code context");
      notify?.("Reading the codebase...");
      progress.report({ message: "Collecting code context" });
      let contextText = await buildContext(repoRoot, prompt);

      const requestedCount = extractRequestedCount(prompt.toLowerCase());
      const executionTier = classifyTaskSizing(prompt, contextText);
      const trackedFiles = await listRepoFiles(repoRoot);
      logStep(output, `Execution tier: ${executionTier}`);
      if (executionTier === "TIER_1") {
        logStep(output, "Calling Claude");
        notify?.("Calling Claude...");
        progress.report({ message: "Calling Claude" });
        try {
          await applyPatchFromClaude({
            apiKey,
            model: claudeModel,
            effort: claudeEffort,
            prompt,
            contextText,
            repoRoot,
            output,
            notify,
            stepLabel: "single-shot",
            allowEmpty: false,
          });
        } catch (error) {
          if (!shouldFallbackToPlan(error)) {
            throw error;
          }
          logStep(output, "Single-shot failed, switching to plan mode");
          notify?.("Single-shot failed, switching to plan mode...");
          progress.report({ message: "Retrying with plan" });
          await runPlanExecute({
            apiKey,
            model: claudeModel,
            effort: claudeEffort,
            prompt,
            contextText,
            repoRoot,
            output,
            notify,
            targetCount: requestedCount,
            existingFiles: trackedFiles,
            maxSteps: 4,
          });
        }
      } else {
        notify?.("Planning multi-step execution...");
        await runPlanExecute({
          apiKey,
          model: claudeModel,
          effort: claudeEffort,
          prompt,
          contextText,
          repoRoot,
          output,
          notify,
          targetCount: requestedCount,
          existingFiles: trackedFiles,
          maxSteps: executionTier === "TIER_3" ? 8 : 4,
        });
      }

      logStep(output, "Summarizing changes");
      notify?.("Summarizing changes...");
      progress.report({ message: "Summarizing changes" });
      summary = await buildChangeSummary(repoRoot);

      logStep(output, "Preparing diff preview");
      notify?.("Preparing diff preview...");
      progress.report({ message: "Preparing diff preview" });
      const changedFiles = await listChangedFiles(repoRoot);
      if (changedFiles.length > 0) {
        await openDiffPreview(repoRoot, changedFiles);
        const approved = await confirmApplyChanges(changedFiles);
        if (!approved) {
          logStep(output, "Changes declined; discarding branch");
          notify?.("Changes declined. Discarding...");
          await discardBranchChanges(repoRoot);
          await abandonBranch(repoRoot, originalBranch, branchName);
          throw new Error("Changes were not approved.");
        }
      }

      logStep(output, "Committing");
      notify?.("Committing changes...");
      progress.report({ message: "Committing" });
      const commitMessage = `LLM: ${truncate(prompt, 60)}`;
      await commitAll(repoRoot, commitMessage);

      logStep(output, "Pushing");
      notify?.("Pushing branch to remote...");
      progress.report({ message: "Pushing" });
      const originUrl = await getOriginUrl(repoRoot);
      if (originUrl && isHttpsGithubOrigin(originUrl) && githubToken) {
        await pushBranchWithToken(repoRoot, branchName, githubToken);
      } else {
        await pushBranch(repoRoot, branchName);
      }

      logStep(output, "Creating PR");
      notify?.("Creating pull request...");
      progress.report({ message: "Creating PR" });
      const [owner, repo] = repoSlug.split("/");
      const prTitle = truncate(prompt, 72);
      const prBody = `Prompt:\n${prompt}`;
      prUrl = await createPullRequest({
        token: githubToken,
        owner,
        repo,
        title: prTitle,
        head: branchName,
        base: baseBranch,
        body: prBody,
      });

      vscode.window.showInformationMessage(`PR created. Here's the link: ${prUrl}`);
    }
  );

  return { prUrl, summary };
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  try {
    const files = await runGit(["ls-files"], repoRoot);
    return files.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function buildStepPrompt(
  originalPrompt: string,
  step: ClaudePlanStep,
  index: number,
  total: number
): string {
  return (
    `Original request:\n${originalPrompt}\n\n` +
    `Step ${index} of ${total}: ${step.title}\n` +
    `Instruction:\n${step.instruction}\n\n` +
    "Only make changes required for this step. " +
    "Do not repeat previous steps."
  );
}

const TOOL_LOOP_SYSTEM_PROMPT =
  "You are editing files in a git repository on the user's behalf. " +
  "Use the list_files, read_file, and write_file tools to inspect and modify " +
  "the repository directly — never output diffs or file contents as chat text. " +
  "Make only the changes required by the task below; prefer editing an existing " +
  "file over creating a new one unless the task asks for a new file. " +
  "Reply with a brief summary once you are done.";

async function applyPatchFromClaude(params: {
  apiKey: string;
  model: string;
  effort?: ClaudeEffort;
  prompt: string;
  contextText: string;
  repoRoot: string;
  output: vscode.OutputChannel;
  notify?: (message: string) => void;
  stepLabel: string;
  allowEmpty: boolean;
}): Promise<void> {
  const {
    apiKey,
    model,
    effort,
    prompt,
    contextText,
    repoRoot,
    output,
    notify,
    stepLabel,
    allowEmpty,
  } = params;

  logStep(output, `Calling Claude (${stepLabel})`);
  notify?.(`Calling Claude (${stepLabel})...`);

  const beforeChanged = new Set(await listChangedFiles(repoRoot));

  await runFileEditingToolLoop({
    apiKey,
    model,
    effort,
    system: TOOL_LOOP_SYSTEM_PROMPT,
    prompt: `Context:\n${truncate(contextText, 12000)}\n\nTask:\n${prompt}`,
    repoRoot,
  });

  logStep(output, `Claude finished (${stepLabel})`);

  const afterChanged = await listChangedFiles(repoRoot);
  const madeChanges = afterChanged.some((file) => !beforeChanged.has(file));
  if (!madeChanges && !allowEmpty) {
    throw new Error("Model made no file changes.");
  }
}

async function runPlanExecute(params: {
  apiKey: string;
  model: string;
  effort?: ClaudeEffort;
  prompt: string;
  contextText: string;
  repoRoot: string;
  output: vscode.OutputChannel;
  notify?: (message: string) => void;
  targetCount?: number;
  existingFiles?: string[];
  maxSteps: number;
}): Promise<void> {
  const {
    apiKey,
    model,
    effort,
    prompt,
    repoRoot,
    output,
    maxSteps,
    notify,
    targetCount,
    existingFiles,
  } = params;
  let { contextText } = params;

  logStep(output, "Planning execution");
  notify?.("Planning execution...");
  const plan = await generatePlanWithClaude({
    apiKey,
    model,
    effort,
    prompt,
    context: contextText,
    maxSteps,
    targetCount,
    existingFiles,
    onTick: makeStreamTick(output, notify, "Planning"),
    onUsage: makeUsageLogger(output, "Planning"),
  });
  if (!plan.length) {
    throw new Error("Failed to generate execution plan.");
  }
  logStep(
    output,
    `Plan steps:\n${plan
      .map((step, index) => `${index + 1}. ${step.title}`)
      .join("\n")}`
  );
  notify?.(
    `Plan ready:\n${plan
      .map((step, index) => `${index + 1}. ${step.title}`)
      .join("\n")}`
  );

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    const stepPrompt = buildStepPrompt(prompt, step, i + 1, plan.length);
  logStep(output, `Calling Claude (${i + 1}/${plan.length})`);
    notify?.(`Running step ${i + 1}/${plan.length}: ${step.title}`);
    await applyPatchFromClaude({
      apiKey,
      model,
      effort,
      prompt: stepPrompt,
      contextText,
      repoRoot,
      output,
      notify,
      stepLabel: `step-${i + 1}`,
      allowEmpty: true,
    });
    logStep(output, "Refreshing context after step");
    notify?.("Refreshing context...");
    contextText = await buildContext(repoRoot, prompt);
  }
}

function shouldFallbackToPlan(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.includes("Model made no file changes");
}

async function selectClaudeModel(
  context: vscode.ExtensionContext
): Promise<void> {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    throw new Error("Missing Anthropic API key.");
  }

  const models = await listClaudeModels(apiKey);
  if (models.length === 0) {
    throw new Error("No Claude models available for this account.");
  }

  const pick = await vscode.window.showQuickPick(models, {
    title: "Pick a Claude model",
    placeHolder: "Choose the model for code generation",
  });

  if (!pick) {
    return;
  }

  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  await config.update(
    "claudeModel",
    pick,
    vscode.ConfigurationTarget.Global
  );
}

function createChatPanel(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): vscode.WebviewPanel {
  if (chatPanel) {
    return chatPanel;
  }

  const panel = vscode.window.createWebviewPanel(
    "llmPrAssistant.chat",
    "LLM PR Assistant Chat",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getChatHtml(panel.webview);
  panel.onDidDispose(() => {
    chatPanel = undefined;
  });

  const postStatus = async () => {
    const status = await getSetupStatus(context);
    panel.webview.postMessage({ type: "status", status });
  };

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    try {
      if (message.type === "getStatus") {
        await postStatus();
        return;
      }

      if (message.type === "setup") {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          throw new Error("Open a workspace to run setup.");
        }
        await runSetupWizard(context, workspaceRoot);
        panel.webview.postMessage({
          type: "assistant",
          text: "Setup complete.",
        });
        await postStatus();
        return;
      }

      if (
        message.type === "autoDetectRepo" ||
        message.type === "autoDetectBranch"
      ) {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          throw new Error("Open a workspace to detect repo settings.");
        }
        await detectAndPersistRepoAndBranch(context, workspaceRoot);
        await postStatus();
        return;
      }

      if (message.type === "login") {
        await loginWithGithubDeviceFlow(
          context,
          GITHUB_DEVICE_CLIENT_ID
        );
        panel.webview.postMessage({
          type: "assistant",
          text: "GitHub login completed.",
        });
        await postStatus();
        return;
      }

      if (message.type === "setApiKey") {
        await getApiKey(context);
        panel.webview.postMessage({
          type: "assistant",
          text: "Anthropic API key saved.",
        });
        await postStatus();
        return;
      }

      if (message.type === "selectModel") {
        await selectClaudeModel(context);
        panel.webview.postMessage({
          type: "assistant",
          text: "Claude model updated.",
        });
        await postStatus();
        return;
      }

      if (message.type === "prompt") {
        const status = await getSetupStatus(context);
        const text = String(message.text ?? "").trim();
        if (!text) {
          return;
        }

        if (status.currentStep === "apiKey") {
          await context.secrets.store("llmPrAssistant.anthropicApiKey", text);
          panel.webview.postMessage({
            type: "assistant",
            text: "Anthropic API key saved.",
          });
          await postStatus();
          return;
        }

        if (status.currentStep === "github") {
          panel.webview.postMessage({
            type: "assistant",
            text: "Please click 'Sign In to GitHub' to continue.",
          });
          await postStatus();
          return;
        }

        if (status.currentStep === "repo") {
          if (!isRepoSlug(text)) {
            panel.webview.postMessage({
              type: "assistant",
              text: "Repo must be in owner/repo format.",
            });
            await postStatus();
            return;
          }
          await setRepoSlug(text);
          panel.webview.postMessage({
            type: "assistant",
            text: `Repo set to ${text}.`,
          });
          await postStatus();
          return;
        }

        if (status.currentStep === "baseBranch") {
          await setBaseBranch(text);
          panel.webview.postMessage({
            type: "assistant",
            text: `Base branch set to ${text}.`,
          });
          await postStatus();
          return;
        }

        if (!status.isReady) {
          panel.webview.postMessage({
            type: "assistant",
            text: "Finish setup before submitting tasks.",
          });
          await postStatus();
          return;
        }

        const result = await runGeneratePrompt(
          context,
          output,
          text,
          (message) => {
            panel.webview.postMessage({ type: "statusToast", text: message });
          }
        );
        const summaryText = result.summary
          ? `\n\nChanges:\n${result.summary}`
          : "";
        panel.webview.postMessage({
          type: "assistant",
          text: result.prUrl
            ? `PR created: ${result.prUrl}${summaryText}`
            : `Task complete.${summaryText}`,
        });
        await postStatus();
        return;
      }
    } catch (error) {
      panel.webview.postMessage({
        type: "assistant",
        text: toUserErrorMessage(error),
      });
    }
  });

  void postStatus();
  return panel;
}

function getChatHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    "img-src https: data:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LLM PR Assistant</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1117;
      --panel: #161a23;
      --border: #2a2f3a;
      --muted: #8b93a7;
      --text: #e6e9f2;
      --accent: #7aa2f7;
      --accent-strong: #5b8cff;
      --success: #2ea043;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
    }
    .container { display: flex; flex-direction: column; height: 100vh; }
    .header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(122,162,247,0.08), transparent);
    }
    .header strong { font-size: 14px; letter-spacing: 0.2px; }
    .status {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      font-size: 12px;
    }
    .status strong { display: block; margin-bottom: 8px; color: var(--muted); }
    .status p { margin: 6px 0; }
    .status a { color: var(--accent); text-decoration: none; }
    .messages { flex: 1; overflow: auto; padding: 16px; }
    .toast {
      position: sticky;
      top: 12px;
      margin: 0 16px 12px;
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(36, 44, 62, 0.9);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 12px;
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }
    .toast.visible {
      opacity: 1;
      transform: translateY(0);
    }
    .message { margin-bottom: 14px; }
    .message .role {
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--muted);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.6px;
    }
    .message .bubble {
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 10px 12px;
      border-radius: 10px;
      white-space: pre-wrap;
    }
    .input {
      display: flex;
      gap: 10px;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: var(--panel);
    }
    .input textarea {
      flex: 1;
      resize: none;
      height: 68px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0d1017;
      color: var(--text);
      padding: 10px;
    }
    .actions {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: #121623;
    }
    button {
      cursor: pointer;
      border: 1px solid var(--border);
      background: #1b2130;
      color: var(--text);
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent-strong);
      color: #0b1020;
      font-weight: 600;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .hint {
      color: var(--muted);
      font-size: 11px;
      padding: 0 16px 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <strong>LLM PR Assistant</strong>
    </div>
    <div class="status" id="status"></div>
    <div class="toast" id="toast"></div>
    <div class="messages" id="messages"></div>
    <div class="actions" id="actions"></div>
    <div class="input">
      <textarea id="prompt" placeholder="Tell me what to build or fix"></textarea>
      <button id="sendBtn">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const toast = document.getElementById("toast");
    let toastTimer = null;
    const statusEl = document.getElementById("status");
    const actionsEl = document.getElementById("actions");
    const prompt = document.getElementById("prompt");
    const sendBtn = document.getElementById("sendBtn");
    let currentStep = "apiKey";

    function addMessage(role, text) {
      const wrap = document.createElement("div");
      wrap.className = "message";
      const roleEl = document.createElement("div");
      roleEl.className = "role";
      roleEl.textContent = role;
      const textEl = document.createElement("div");
      textEl.className = "bubble";
      textEl.textContent = text;
      wrap.appendChild(roleEl);
      wrap.appendChild(textEl);
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
    }

    function showToast(text) {
      if (!toast) return;
      if (toastTimer) {
        clearTimeout(toastTimer);
      }
      toast.textContent = text;
      toast.classList.add("visible");
      toastTimer = setTimeout(() => {
        toast.classList.remove("visible");
      }, 2200);
    }

    sendBtn.addEventListener("click", () => {
      const text = prompt.value.trim();
      if (!text) return;
      if (currentStep !== "apiKey") {
        addMessage("You", text);
      }
      vscode.postMessage({ type: "prompt", text });
      prompt.value = "";
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "assistant") {
        addMessage("Assistant", String(message.text ?? ""));
      } else if (message?.type === "statusToast") {
        showToast(String(message.text ?? ""));
      } else if (message?.type === "status") {
        const status = message.status || {};
        currentStep = status.currentStep || "apiKey";
        renderStatus(status);
        renderActions(status);
        applyInputState(status);
      }
    });

    vscode.postMessage({ type: "getStatus" });

    function applyInputState(status) {
      const isReady = Boolean(status.isReady);
      const step = status.currentStep || "apiKey";
      if (step === "apiKey") {
        prompt.placeholder = "Drop your Anthropic API key here (I won't peek)";
        prompt.disabled = false;
        sendBtn.disabled = false;
        return;
      }
      if (step === "repo") {
        prompt.placeholder = "Repo please: owner/repo (yes, with the slash)";
        prompt.disabled = false;
        sendBtn.disabled = false;
        return;
      }
      if (step === "baseBranch") {
        prompt.placeholder = "Base branch? (main/master, usually)";
        prompt.disabled = false;
        sendBtn.disabled = false;
        return;
      }
      if (step === "github") {
        prompt.placeholder = "Sign in to GitHub to unlock PR superpowers";
        prompt.disabled = true;
        sendBtn.disabled = true;
        return;
      }
      prompt.placeholder = "Tell me what to build or fix";
      prompt.disabled = !isReady;
      sendBtn.disabled = !isReady;
    }

    function renderActions(status) {
      const step = status.currentStep || "apiKey";
      actionsEl.innerHTML = "";
      if (step === "github") {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "Sign In to GitHub";
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "login" });
        });
        actionsEl.appendChild(btn);
        return;
      }
      if (step === "repo") {
        const btn = document.createElement("button");
        btn.textContent = "Auto-detect from git";
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "autoDetectRepo" });
        });
        actionsEl.appendChild(btn);
        if (status.hasApiKey) {
          const modelBtn = document.createElement("button");
          modelBtn.textContent = "Select model";
          modelBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "selectModel" });
          });
          actionsEl.appendChild(modelBtn);
        }
        return;
      }
      if (step === "baseBranch") {
        const btn = document.createElement("button");
        btn.textContent = "Auto-detect base branch";
        btn.addEventListener("click", () => {
          vscode.postMessage({ type: "autoDetectBranch" });
        });
        actionsEl.appendChild(btn);
        if (status.hasApiKey) {
          const modelBtn = document.createElement("button");
          modelBtn.textContent = "Select model";
          modelBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "selectModel" });
          });
          actionsEl.appendChild(modelBtn);
        }
        return;
      }
      if (step === "apiKey") {
        const btn = document.createElement("button");
        btn.textContent = "Open Anthropic Console";
        btn.addEventListener("click", () => {
          window.open("https://console.anthropic.com/", "_blank");
        });
        actionsEl.appendChild(btn);
        return;
      }
      if (status.isReady) {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = "Ready to roll";
        actionsEl.appendChild(btn);
        if (status.hasApiKey) {
          const modelBtn = document.createElement("button");
          modelBtn.textContent = "Select model";
          modelBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "selectModel" });
          });
          actionsEl.appendChild(modelBtn);
        }
      }
    }

    function renderStatus(status) {
      const step = status.currentStep || "apiKey";
      if (step === "apiKey") {
        statusEl.innerHTML =
          "<strong>Step 1: Feed me an Anthropic API key</strong>" +
          "<p>Grab one from <a href='https://console.anthropic.com/' target='_blank'>console.anthropic.com</a>, then paste it below.</p>" +
          "<p>We store it securely in VS Code SecretStorage.</p>";
        return;
      }
      if (step === "github") {
        statusEl.innerHTML =
          "<strong>Step 2: Sign in to GitHub</strong>" +
          "<p>Authorize GitHub so I can open PRs without sneaking.</p>";
        return;
      }
      if (step === "repo") {
        statusEl.innerHTML =
          "<strong>Step 3: Pick your repo</strong>" +
          "<p>Enter it as <code>owner/repo</code>. Example: <code>athakur3/llm-pr-assistant</code>.</p>";
        return;
      }
      if (step === "baseBranch") {
        statusEl.innerHTML =
          "<strong>Step 4: Choose a base branch</strong>" +
          "<p>Pick the branch for PRs (usually <code>main</code> or <code>master</code>).</p>";
        return;
      }
      statusEl.innerHTML =
        "<strong>All set — give me a task</strong>" +
        "<p>Try prompts like:</p>" +
        "<ul>" +
        "<li>Write unit tests for the payment service</li>" +
        "<li>Add retry logic to the API client (because networks have moods)</li>" +
        "<li>Refactor the auth middleware for clarity</li>" +
        "<li>Fix lint errors in the checkout module</li>" +
        "</ul>";
    }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let value = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return value;
}

async function getSetupStatus(
  context: vscode.ExtensionContext
): Promise<{
  hasApiKey: boolean;
  hasGithub: boolean;
  hasRepo: boolean;
  hasBaseBranch: boolean;
  currentStep: "apiKey" | "github" | "repo" | "baseBranch" | "ready";
  isReady: boolean;
}> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    await detectAndPersistRepoAndBranch(context, workspaceRoot);
  }
  const hasApiKey = Boolean(
    await context.secrets.get("llmPrAssistant.anthropicApiKey")
  );
  const hasGithub = Boolean(
    (await context.secrets.get("llmPrAssistant.githubToken")) ||
      (config.get<string>("githubToken")?.trim() ?? "")
  );
  const hasRepo = Boolean(config.get<string>("repo")?.trim());
  const hasBaseBranch = Boolean(config.get<string>("baseBranch")?.trim());
  const currentStep = !hasApiKey
    ? "apiKey"
    : !hasGithub
      ? "github"
      : !hasRepo
        ? "repo"
        : !hasBaseBranch
          ? "baseBranch"
          : "ready";
  return {
    hasApiKey,
    hasGithub,
    hasRepo,
    hasBaseBranch,
    currentStep,
    isReady: hasApiKey && hasGithub && hasRepo && hasBaseBranch,
  };
}

async function setRepoSlug(value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  await config.update(
    "repo",
    value,
    vscode.ConfigurationTarget.Workspace
  );
}

async function setBaseBranch(value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  await config.update(
    "baseBranch",
    value,
    vscode.ConfigurationTarget.Workspace
  );
}

async function detectAndPersistRepoAndBranch(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  const repoSlug = config.get<string>("repo")?.trim() ?? "";
  const baseBranch = config.get<string>("baseBranch")?.trim() ?? "";

  if (!repoSlug) {
    const repoRoot = await ensureGitRepo(workspaceRoot);
    const detectedRepo = await detectRepoSlug(repoRoot);
    if (detectedRepo) {
      await config.update(
        "repo",
        detectedRepo,
        vscode.ConfigurationTarget.Workspace
      );
    }
  }

  if (!baseBranch) {
    const repoRoot = await ensureGitRepo(workspaceRoot);
    const detectedBase = await detectBaseBranch(repoRoot);
    if (detectedBase) {
      await config.update(
        "baseBranch",
        detectedBase,
        vscode.ConfigurationTarget.Workspace
      );
    }
  }
}

async function runSetupWizard(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");

  await getApiKey(context);

  const hasToken =
    (await context.secrets.get("llmPrAssistant.githubToken")) ||
    (config.get<string>("githubToken")?.trim() ?? "");

  if (!hasToken) {
    await loginWithGithubDeviceFlow(context, GITHUB_DEVICE_CLIENT_ID);
  }

  const repoRoot = await ensureGitRepo(workspaceRoot);
  const detectedRepo = await detectRepoSlug(repoRoot);
  const repoSlug = (
    await vscode.window.showInputBox({
      title: "Repository (owner/repo)",
      prompt: "Format: owner/repo (with the slash)",
      value: detectedRepo ?? "",
      ignoreFocusOut: true,
    })
  )?.trim();

  if (repoSlug) {
    await config.update(
      "repo",
      repoSlug,
      vscode.ConfigurationTarget.Workspace
    );
  }

  const detectedBase = await detectBaseBranch(repoRoot);
  const baseBranch = await chooseBaseBranch(detectedBase ?? "main");
  if (baseBranch) {
    await config.update(
      "baseBranch",
      baseBranch,
      vscode.ConfigurationTarget.Workspace
    );
  }
}

async function chooseBaseBranch(
  defaultBranch: string
): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: defaultBranch, description: "Detected" },
      { label: "main", description: "Common default" },
      { label: "master", description: "Legacy default" },
      { label: "Other...", description: "Type a custom branch" },
    ],
    {
      title: "Base Branch (PR target)",
      placeHolder: "Pick the branch to target for PRs",
    }
  );

  if (!pick) {
    return undefined;
  }

  if (pick.label === "Other...") {
    const typed = await vscode.window.showInputBox({
      title: "Base Branch (PR target)",
      prompt: "Enter the branch to target for PRs (probably main)",
      value: defaultBranch,
      ignoreFocusOut: true,
    });
    return typed?.trim() || undefined;
  }

  return pick.label;
}

async function detectRepoSlug(repoRoot: string): Promise<string | null> {
  try {
    const origin = await runGit(["remote", "get-url", "origin"], repoRoot);
    return parseGithubSlug(origin);
  } catch {
    return null;
  }
}

async function detectBaseBranch(repoRoot: string): Promise<string | null> {
  try {
    const head = await runGit(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      repoRoot
    );
    const parts = head.split("/");
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

async function getOriginUrl(repoRoot: string): Promise<string | null> {
  try {
    return await runGit(["remote", "get-url", "origin"], repoRoot);
  } catch {
    return null;
  }
}

function isHttpsGithubOrigin(originUrl: string): boolean {
  return originUrl.startsWith("https://github.com/");
}

async function buildChangeSummary(repoRoot: string): Promise<string> {
  try {
    const files = await runGit(["diff", "--name-only"], repoRoot);
    const stats = await runGit(["diff", "--stat"], repoRoot);
    const fileList = files
      .split("\n")
      .filter(Boolean)
      .map((file) => `- ${file}`)
      .join("\n");
    const statLines = stats ? `${stats}\n` : "";
    return `${fileList}\n${statLines}`.trim();
  } catch {
    return "";
  }
}

function toUserErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? "");

  if (raw.includes("model:") || raw.includes("not_found_error")) {
    return (
      "Claude model not available. Set a valid model in settings " +
      "(llmPrAssistant.claudeModel) or use 'claude-opus-5'."
    );
  }

  if (raw.includes("Working tree is not clean")) {
    return (
      "Your repo has uncommitted changes. Commit, stash, or clean changes " +
      "before running the assistant."
    );
  }

  if (raw.includes("Missing Anthropic API key")) {
    return "Anthropic API key is missing. Add it in the setup step.";
  }

  if (raw.includes("Missing GitHub token")) {
    return "GitHub login is required. Click 'Sign In to GitHub' to continue.";
  }

  if (raw.includes("Missing repository")) {
    return "Repository is missing. Enter it as owner/repo.";
  }

  if (raw.includes("Failed to generate execution plan")) {
    return "Could not plan the task. Try a smaller scope or run again.";
  }

  if (raw.includes("Model made no file changes")) {
    return (
      "The model didn't make any file changes. Try rephrasing the request " +
      "or narrowing the scope."
    );
  }

  if (raw.includes("Changes were not approved")) {
    return (
      "Changes were declined in the diff preview. Nothing was committed, " +
      "pushed, or opened as a PR."
    );
  }

  if (raw.includes("declined to respond to this request (refusal)")) {
    return (
      "Claude declined to respond to this request. Try rephrasing or " +
      "narrowing the prompt."
    );
  }

  if (raw.includes("GitHub device code expired")) {
    return "GitHub login expired. Please sign in again.";
  }

  if (raw.includes("GitHub access denied")) {
    return "GitHub access was denied. Please approve the login to continue.";
  }

  if (raw.includes("GitHub login timed out")) {
    return "GitHub login timed out. Please try again.";
  }

  if (raw.includes("Permission to") && raw.includes("denied")) {
    return (
      "Git push failed due to permission issues. Make sure the GitHub " +
      "account you signed in with has access to the repo, then try again."
    );
  }

  return raw || "Something went wrong. Please try again.";
}

