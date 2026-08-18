// Pure cheap-ranking helper: scores tracked files against a prompt by
// path/keyword overlap, no imports, so tests load it directly under Node's
// type-stripping ESM loader (same trap as prompt.ts/patch.ts).

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "add",
  "make",
  "update",
  "change",
  "please",
  "should",
  "when",
  "then",
  "have",
  "has",
  "not",
  "all",
  "any",
  "can",
  "you",
]);

export function rankFilesByPrompt(
  files: string[],
  prompt: string,
  limit: number
): string[] {
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) {
    return [];
  }

  return files
    .map((file) => ({ file, score: scoreFile(file, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((entry) => entry.file);
}

export function extractKeywords(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return Array.from(new Set(words));
}

function scoreFile(file: string, keywords: string[]): number {
  const lowerPath = file.toLowerCase();
  const segments = lowerPath.split(/[/._-]+/).filter(Boolean);

  let score = 0;
  for (const keyword of keywords) {
    if (segments.includes(keyword)) {
      score += 3;
    } else if (lowerPath.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}
