// Pure prompt/plan analysis helpers: task sizing heuristics and plan JSON
// parsing. No imports at all — tests load this file directly under Node's
// type-stripping ESM loader, where an extensionless "./patch" cannot resolve.

export type TaskExecutionTier = "TIER_1" | "TIER_2" | "TIER_3";

export type PlanStep = {
  title: string;
  instruction: string;
};

export function classifyTaskSizing(
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

export function extractRequestedCount(text: string): number {
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

export function findClosestNumberWord(
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

export function levenshteinDistance(a: string, b: string): number {
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

export function parsePlanJson(raw: string): PlanStep[] {
  const cleaned = raw.replace(/```[\s\S]*?```/g, (match) =>
    match.replace(/```/g, "")
  );
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const candidate =
    start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;

  try {
    const data = JSON.parse(candidate);
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((item) => ({
        title: String(item?.title ?? "").trim(),
        instruction: String(item?.instruction ?? "").trim(),
      }))
      .filter((item) => item.title && item.instruction);
  } catch {
    return [];
  }
}
