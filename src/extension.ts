import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import { URLSearchParams } from "node:url";
import * as vscode from "vscode";
import { buildContext } from "./context";
import {
  applyPatch,
  applyPatchThreeWay,
  commitAll,
  createBranch,
  ensureClean,
  ensureGitRepo,
  pushBranch,
  pushBranchWithToken,
  runGit,
} from "./git";
import { createPullRequest } from "./github";
import {
  ClaudePlanStep,
  generateFileContentWithClaude,
  generatePatchWithClaude,
  generatePlanWithClaude,
  listClaudeModels,
} from "./llm/claude";
import { ensureQdrantBinary, getQdrantStatus, startQdrant } from "./rag/qdrant";

const OUTPUT_CHANNEL_NAME = "LLM PR Assistant";
const GITHUB_DEVICE_CLIENT_ID = "Ov23lixQIJgRYTeNSsBp";
let chatPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = "$(comment-discussion) LLM PR Assistant";
  statusBar.command = "llmPrAssistant.openChat";
  statusBar.tooltip = "Open LLM PR Assistant Chat";
  statusBar.show();

  void startIndexerIfConfigured(context);

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
    output
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

function buildBranchName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `llm/pr-${stamp}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function isUnifiedDiff(text: string): boolean {
  if (!text) {
    return false;
  }
  return text.includes("diff --git ") || text.includes("--- ");
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore missing file cleanup errors.
  }
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
        config.get<string>("claudeModel")?.trim() ??
        "claude-3-5-sonnet-latest";
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

      const branchName = buildBranchName();
      logStep(output, `Creating branch ${branchName}`);
      notify?.("Creating a new branch...");
      progress.report({ message: "Creating branch" });
      await createBranch(repoRoot, branchName);

      logStep(output, "Collecting code context");
      notify?.("Reading the codebase...");
      progress.report({ message: "Collecting code context" });
      let contextText = await buildContext(repoRoot);

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
            prompt,
            contextText,
            repoRoot,
            output,
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

type TaskExecutionTier = "TIER_1" | "TIER_2" | "TIER_3";

function classifyTaskSizing(
  prompt: string,
  contextText: string
): TaskExecutionTier {
  const lower = prompt.toLowerCase();
  const count = extractRequestedCount(lower);
  const promptLength = prompt.length;
  const contextSize = contextText.length;
  const hasScopeSignals =
    /all|every|each|across|compare|generate|create|add|migrate|refactor|update|implement|replace/.test(
      lower
    );

  let score = 0;
  if (promptLength > 600) score += 2;
  else if (promptLength > 300) score += 1;

  if (contextSize > 200_000) score += 2;
  else if (contextSize > 100_000) score += 1;

  if (count >= 20) score += 3;
  else if (count >= 8) score += 2;
  else if (count >= 4) score += 2;

  if (hasScopeSignals) score += 1;

  if (score >= 5) return "TIER_3";
  if (score >= 3) return "TIER_2";
  return "TIER_1";
}

function extractRequestedCount(text: string): number {
  const matches = text.match(/\b\d{1,3}\b/g);
  let maxValue = 0;
  if (matches) {
    maxValue = Math.max(...matches.map((value) => Number(value)));
  }

  const words = text
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const map: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
  };

  for (let i = 0; i < words.length; i += 1) {
    const token = words[i];
    if (token.includes("-")) {
      const parts = token.split("-");
      const base = map[parts[0]];
      const next = map[parts[1]];
      if (base && next && next < 10) {
        maxValue = Math.max(maxValue, base + next);
        continue;
      }
    }
    const value = map[token] ?? map[findClosestNumberWord(token, map, 2)];
    if (value) {
      let total = value;
      if (value >= 20 && value % 10 === 0 && i + 1 < words.length) {
        const next = map[words[i + 1]];
        if (next && next < 10) {
          total = value + next;
        }
      }
      maxValue = Math.max(maxValue, total);
    }
  }

  return maxValue;
}

function findClosestNumberWord(
  token: string,
  map: Record<string, number>,
  maxDistance: number
): string {
  let best = "";
  let bestDistance = maxDistance + 1;
  for (const word of Object.keys(map)) {
    const distance = levenshteinDistance(token, word);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = word;
    }
  }
  return bestDistance <= maxDistance ? best : "";
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const prev = new Array(b.length + 1).fill(0);
  const next = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j += 1) {
    prev[j] = j;
  }
  for (let i = 0; i < a.length; i += 1) {
    next[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      next[j + 1] = Math.min(
        prev[j + 1] + 1,
        next[j] + 1,
        prev[j] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = next[j];
    }
  }
  return prev[b.length];
}

function ensureDiffGitHeader(patch: string): string {
  if (patch.includes("diff --git ")) {
    return patch;
  }
  const lines = patch.split(/\r?\n/);
  const oldIndex = lines.findIndex((line) => line.startsWith("--- "));
  const newIndex = lines.findIndex((line) => line.startsWith("+++ "));
  if (oldIndex < 0 || newIndex < 0) {
    return patch;
  }

  const oldPath = lines[oldIndex].slice(4).trim();
  const newPath = lines[newIndex].slice(4).trim();
  const cleanOld = oldPath.replace(/^a\//, "");
  const cleanNew = newPath.replace(/^b\//, "");
  const aPath = oldPath === "/dev/null" ? cleanNew : cleanOld;
  const bPath = newPath === "/dev/null" ? cleanOld : cleanNew;

  const header: string[] = [`diff --git a/${aPath} b/${bPath}`];
  if (oldPath === "/dev/null") {
    header.push("new file mode 100644");
  } else if (newPath === "/dev/null") {
    header.push("deleted file mode 100644");
  }

  return [...header, ...lines].join("\n");
}

function ensureTrailingNewline(patch: string): string {
  if (!patch) {
    return patch;
  }
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

function extractNewFileContentFromPatch(patch: string): string | null {
  if (!isNewFilePatch(patch)) {
    return null;
  }
  const lines = patch.split(/\r?\n/);
  const content: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("+")) {
      content.push(line.slice(1));
    }
  }
  return content.length ? content.join("\n") : null;
}

function isNewFilePatch(patch: string): boolean {
  return patch.includes("--- /dev/null") || /@@\s+-0,0\s+\+\d/.test(patch);
}

async function isMissingFile(repoRoot: string, filePath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(repoRoot, filePath));
    return false;
  } catch {
    return true;
  }
}

async function writeFileFromNonPatchResponse(params: {
  prompt: string;
  repoRoot: string;
  content: string;
}): Promise<boolean> {
  const { prompt, repoRoot } = params;
  const content = stripCodeFences(params.content).trim();
  if (!content) {
    return false;
  }
  const target = extractFilePathFromPrompt(prompt);
  if (!target) {
    return false;
  }
  const fullPath = path.join(repoRoot, target);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${content}\n`, "utf8");
  return true;
}

function extractFilePathFromPrompt(prompt: string): string | null {
  const match = prompt.match(/([a-zA-Z0-9_./-]+\.(?:js|ts|tsx|jsx|py|java|go|rb|rs|cpp|c|h|md|json|yaml|yml))/);
  return match?.[1] ?? null;
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""));
}

async function normalizePatchForNewFile(
  patch: string,
  repoRoot: string
): Promise<string> {
  const filePath = extractPrimaryFilePath(patch);
  if (!filePath) {
    return patch;
  }
  const fullPath = path.join(repoRoot, filePath);
  let exists = false;
  try {
    await fs.stat(fullPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    return patch;
  }
  if (patch.includes("/dev/null")) {
    return patch;
  }

  const lines = patch.split(/\r?\n/);
  const rewritten = lines
    .map((line) => {
      if (line.startsWith("--- a/")) {
        return "--- /dev/null";
      }
      return line;
    })
    .flatMap((line, index) => {
      if (index === 0 && line.startsWith("diff --git ")) {
        return [line, "new file mode 100644"];
      }
      return [line];
    })
    .join("\n");

  return ensureTrailingNewline(rewritten);
}

async function rewriteNewFilePatchForExistingFile(
  patch: string,
  repoRoot: string
): Promise<string | null> {
  if (!patch.includes("new file mode")) {
    return null;
  }
  const newPathMatch = patch.match(/^\+\+\+\s+b\/(.+)$/m);
  if (!newPathMatch) {
    return null;
  }
  const filePath = newPathMatch[1].trim();
  if (!filePath) {
    return null;
  }
  const fullPath = path.join(repoRoot, filePath);
  try {
    await fs.stat(fullPath);
  } catch {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const rewritten = lines
    .filter((line) => line !== "new file mode 100644")
    .map((line) => {
      if (line.startsWith("--- /dev/null")) {
        return `--- a/${filePath}`;
      }
      return line;
    })
    .join("\n");

  return ensureTrailingNewline(rewritten);
}

async function regeneratePatchWithFreshFileContext(params: {
  apiKey: string;
  model: string;
  prompt: string;
  repoRoot: string;
  originalPatch: string;
}): Promise<string | null> {
  const { apiKey, model, prompt, repoRoot, originalPatch } = params;
  const filePath =
    extractPrimaryFilePath(originalPatch) ?? extractFilePathFromPrompt(prompt);
  if (!filePath) {
    return null;
  }
  const fullPath = path.join(repoRoot, filePath);
  let fileContent = "";
  try {
    fileContent = await fs.readFile(fullPath, "utf8");
  } catch {
    return null;
  }

  const focusedContext =
    `File: ${filePath}\n` +
    "Current contents:\n" +
    fileContent +
    "\n\nOnly modify this file. Output a unified diff.";

  const retryPatch = await generatePatchWithClaude({
    apiKey,
    model,
    prompt,
    context: focusedContext,
  });

  const normalized = ensureTrailingNewline(ensureDiffGitHeader(retryPatch));
  return normalized.trim() ? normalized : null;
}

function extractPrimaryFilePath(patch: string): string | null {
  const plusMatch = patch.match(/^\+\+\+\s+b\/(.+)$/m);
  if (plusMatch?.[1]) {
    return plusMatch[1].trim() || null;
  }
  const diffMatch = patch.match(/^diff --git a\/(.+)\s+b\/(.+)$/m);
  if (diffMatch?.[2]) {
    return diffMatch[2].trim() || null;
  }
  return null;
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  try {
    const files = await runGit(["ls-files"], repoRoot);
    return files.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function createFileFromClaudeIfMissing(params: {
  apiKey: string;
  model: string;
  prompt: string;
  contextText: string;
  repoRoot: string;
  originalPatch: string;
}): Promise<boolean> {
  const { apiKey, model, prompt, contextText, repoRoot, originalPatch } = params;
  const filePath =
    extractPrimaryFilePath(originalPatch) ?? extractFilePathFromPrompt(prompt);
  if (!filePath) {
    return false;
  }
  const fullPath = path.join(repoRoot, filePath);
  try {
    await fs.stat(fullPath);
    return false;
  } catch {
    // continue
  }

  const content = await generateFileContentWithClaude({
    apiKey,
    model,
    prompt: `Create the full contents for ${filePath}.`,
    context: contextText,
    filePath,
  });
  if (!content.trim()) {
    return false;
  }
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${content}\n`, "utf8");
  return true;
}

async function replaceFileFromClaudeOnFailure(params: {
  apiKey: string;
  model: string;
  prompt: string;
  contextText: string;
  repoRoot: string;
  originalPatch: string;
}): Promise<boolean> {
  const { apiKey, model, prompt, contextText, repoRoot, originalPatch } = params;
  const filePath =
    extractPrimaryFilePath(originalPatch) ?? extractFilePathFromPrompt(prompt);
  if (!filePath) {
    return false;
  }
  const fullPath = path.join(repoRoot, filePath);
  let existing = "";
  try {
    existing = await fs.readFile(fullPath, "utf8");
  } catch {
    return false;
  }

  const focusedContext =
    `File: ${filePath}\n` +
    "Current contents:\n" +
    existing +
    "\n\nReturn the full updated file contents.";

  const content = await generateFileContentWithClaude({
    apiKey,
    model,
    prompt,
    context: focusedContext,
    filePath,
  });
  if (!content.trim()) {
    return false;
  }
  await fs.writeFile(fullPath, `${content}\n`, "utf8");
  return true;
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

async function applyPatchFromClaude(params: {
  apiKey: string;
  model: string;
  prompt: string;
  contextText: string;
  repoRoot: string;
  output: vscode.OutputChannel;
  stepLabel: string;
  allowEmpty: boolean;
}): Promise<void> {
  const {
    apiKey,
    model,
    prompt,
    contextText,
    repoRoot,
    stepLabel,
    allowEmpty,
  } = params;

  const patch = await generatePatchWithClaude({
    apiKey,
    model,
    prompt,
    context: contextText,
  });
  const normalizedPatch = await normalizePatchForNewFile(
    ensureTrailingNewline(ensureDiffGitHeader(patch)),
    repoRoot
  );

  if (!normalizedPatch.trim()) {
    if (allowEmpty) {
      return;
    }
    throw new Error("Model response was not a patch.");
  }

  if (!isUnifiedDiff(normalizedPatch)) {
    const wrote = await writeFileFromNonPatchResponse({
      prompt,
      repoRoot,
      content: normalizedPatch,
    });
    if (wrote) {
      return;
    }
    throw new Error("Model response was not a patch.");
  }

  const patchPath = path.join(repoRoot, `.llm-pr-assistant.${stepLabel}.patch`);
  await fs.writeFile(patchPath, normalizedPatch, "utf8");
  const primaryFile = extractPrimaryFilePath(normalizedPatch);
  if (primaryFile && (await isMissingFile(repoRoot, primaryFile))) {
    const contentFromPatch = extractNewFileContentFromPatch(normalizedPatch);
    if (contentFromPatch) {
      await fs.mkdir(path.dirname(path.join(repoRoot, primaryFile)), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(repoRoot, primaryFile),
        ensureTrailingNewline(contentFromPatch),
        "utf8"
      );
      await safeUnlink(patchPath);
      return;
    }
    const created = await createFileFromClaudeIfMissing({
      apiKey,
      model,
      prompt,
      contextText,
      repoRoot,
      originalPatch: normalizedPatch,
    });
    if (created) {
      await safeUnlink(patchPath);
      return;
    }
  }
  try {
    await validatePatch(repoRoot, patchPath);
    await applyPatch(repoRoot, patchPath);
    await safeUnlink(patchPath);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error ?? "");
    const rewritten = await rewriteNewFilePatchForExistingFile(
      normalizedPatch,
      repoRoot
    );
    if (rewritten) {
      await fs.writeFile(patchPath, rewritten, "utf8");
      await validatePatch(repoRoot, patchPath);
      await applyPatch(repoRoot, patchPath);
      await safeUnlink(patchPath);
      return;
    }

    try {
      await applyPatchThreeWay(repoRoot, patchPath);
      await safeUnlink(patchPath);
      return;
    } catch (threeWayError) {
      const refreshed = await regeneratePatchWithFreshFileContext({
        apiKey,
        model,
        prompt,
        repoRoot,
        originalPatch: normalizedPatch,
      });
      if (refreshed) {
        try {
          await fs.writeFile(patchPath, refreshed, "utf8");
          await validatePatch(repoRoot, patchPath);
          await applyPatch(repoRoot, patchPath);
          await safeUnlink(patchPath);
          return;
        } catch {
          // Fall through to file creation/replace fallback.
        }
      }
      const created = await createFileFromClaudeIfMissing({
        apiKey,
        model,
        prompt,
        contextText,
        repoRoot,
        originalPatch: normalizedPatch,
      });
      if (created) {
        await safeUnlink(patchPath);
        return;
      }
      const replaced = await replaceFileFromClaudeOnFailure({
        apiKey,
        model,
        prompt,
        contextText,
        repoRoot,
        originalPatch: normalizedPatch,
      });
      if (replaced) {
        await safeUnlink(patchPath);
        return;
      }
      const threeWayDetails =
        threeWayError instanceof Error
          ? threeWayError.message
          : String(threeWayError ?? "");
      throw new Error(
        "The model returned an invalid patch. " +
          `We saved it to ${patchPath}.\n` +
          details +
          (threeWayDetails ? `\n${threeWayDetails}` : "")
      );
    }
  }
}

async function runPlanExecute(params: {
  apiKey: string;
  model: string;
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
    prompt,
    context: contextText,
    maxSteps,
    targetCount,
    existingFiles,
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
      prompt: stepPrompt,
      contextText,
      repoRoot,
      output,
      stepLabel: `step-${i + 1}`,
      allowEmpty: true,
    });
    logStep(output, "Refreshing context after step");
    notify?.("Refreshing context...");
    contextText = await buildContext(repoRoot);
  }
}

function shouldFallbackToPlan(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return (
    raw.includes("Model response was not a patch") ||
    raw.includes("The model returned an invalid patch")
  );
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

        if (status.currentStep === "indexing") {
          panel.webview.postMessage({
            type: "assistant",
            text: "Indexer is starting. Please wait a moment.",
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
      if (step === "indexing") {
        prompt.placeholder =
          "Teaching the assistant your codebase… no coffee spills";
        prompt.disabled = true;
        sendBtn.disabled = true;
        return;
      }
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
      if (step === "indexing") {
        const btn = document.createElement("button");
        btn.textContent = "Indexer starting...";
        btn.disabled = true;
        actionsEl.appendChild(btn);
        return;
      }
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
      if (step === "indexing") {
        statusEl.innerHTML =
          "<strong>Indexing the repo</strong>" +
          "<p>Setting up Qdrant to turn your requests into vertices — graph‑paper jokes included.</p>";
        return;
      }
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
  hasIndexer: boolean;
  currentStep:
    | "indexing"
    | "apiKey"
    | "github"
    | "repo"
    | "baseBranch"
    | "ready";
  isReady: boolean;
}> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  await startIndexerIfConfigured(context);
  const hasIndexer = getQdrantStatus() === "running";
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
  const currentStep = !hasIndexer
    ? "indexing"
    : !hasApiKey
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
    hasIndexer,
    currentStep,
    isReady: hasIndexer && hasApiKey && hasGithub && hasRepo && hasBaseBranch,
  };
}

function isRepoSlug(value: string): boolean {
  return /^[^/]+\/[^/]+$/.test(value);
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

function parseGithubSlug(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = remoteUrl.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
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

async function validatePatch(
  repoRoot: string,
  patchPath: string
): Promise<void> {
  await runGit(["apply", "--check", patchPath], repoRoot);
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
      "(llmPrAssistant.claudeModel) or use 'claude-3-5-sonnet-latest'."
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

  if (raw.includes("Qdrant binary not found")) {
    return (
      "Qdrant is not configured. Set llmPrAssistant.qdrantPath to a local " +
      "qdrant binary, then try again."
    );
  }

  if (raw.includes("Missing repository")) {
    return "Repository is missing. Enter it as owner/repo.";
  }

  if (raw.includes("Failed to generate execution plan")) {
    return "Could not plan the task. Try a smaller scope or run again.";
  }

  if (raw.includes("Model response was not a patch")) {
    return (
      "The model response wasn't a patch. Try rephrasing the request or " +
      "narrowing the scope."
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

async function getQdrantConfig(
  context: vscode.ExtensionContext
): Promise<{
  binaryPath: string;
  configPath?: string;
  host: string;
  port: number;
  dataDir?: string;
}> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  const binaryPath = await resolveQdrantBinaryPath(context);
  const configPath = config.get<string>("qdrantConfigPath")?.trim() ?? "";
  const host = config.get<string>("qdrantHost")?.trim() ?? "127.0.0.1";
  const port = Number(config.get<number>("qdrantPort") ?? 6333);
  const dataDir = config.get<string>("qdrantDataDir")?.trim() ?? "";

  if (!binaryPath) {
    throw new Error("Qdrant binary not found");
  }

  return {
    binaryPath,
    configPath: configPath || undefined,
    host,
    port,
    dataDir: dataDir || undefined,
  };
}

async function startIndexerIfConfigured(
  context: vscode.ExtensionContext
): Promise<void> {
  const binaryPath = await resolveQdrantBinaryPath(context);
  if (!binaryPath) {
    return;
  }
  if (getQdrantStatus() === "running") {
    return;
  }
  try {
    const cfg = await getQdrantConfig(context);
    await startQdrant(cfg);
  } catch {
    // Silent; status UI will show indexing/disabled state.
  }
}

async function resolveQdrantBinaryPath(
  context: vscode.ExtensionContext
): Promise<string> {
  const config = vscode.workspace.getConfiguration("llmPrAssistant");
  const configured = config.get<string>("qdrantPath")?.trim() ?? "";
  if (configured) {
    return configured;
  }
  const cached =
    context.globalState.get<string>("llmPrAssistant.qdrantPath") ?? "";
  if (cached) {
    return cached;
  }
  const installRoot = path.join(context.globalStorageUri.fsPath, "qdrant");
  const downloaded = await ensureQdrantBinary(installRoot);
  await context.globalState.update("llmPrAssistant.qdrantPath", downloaded);
  return downloaded;
}

