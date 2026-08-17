// Pure helpers for cleaning LLM output and normalizing unified diff patches.
// No VS Code or Node API dependencies — everything here is unit-testable.

export function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""));
}

export function extractUnifiedDiff(raw: string): string {
  const cleaned = stripCodeFences(raw).trim();

  const diffIndex = cleaned.indexOf("diff --git ");
  if (diffIndex >= 0) {
    return cleaned.slice(diffIndex).trim();
  }

  const altIndex = cleaned.search(/^---\s+/m);
  if (altIndex >= 0) {
    return cleaned.slice(altIndex).trim();
  }

  return cleaned.trim();
}

export function ensureDiffGitHeader(patch: string): string {
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

export function ensureTrailingNewline(patch: string): string {
  if (!patch) {
    return patch;
  }
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

export function isNewFilePatch(patch: string): boolean {
  return patch.includes("--- /dev/null") || /@@\s+-0,0\s+\+\d/.test(patch);
}

export function extractNewFileContentFromPatch(patch: string): string | null {
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

export function extractPrimaryFilePath(patch: string): string | null {
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

export function extractFilePathFromPrompt(prompt: string): string | null {
  const match = prompt.match(/([a-zA-Z0-9_./-]+\.(?:js|ts|tsx|jsx|py|java|go|rb|rs|cpp|c|h|md|json|yaml|yml))/);
  return match?.[1] ?? null;
}
