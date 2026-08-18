/**
 * Throttling and formatting helpers for streaming progress ticks. Kept pure
 * and dependency-free so they can be unit tested without a real SDK stream.
 */

export function createTickGate(
  thresholdChars: number
): (currentLength: number) => boolean {
  let lastEmittedAt = 0;
  return (currentLength: number) => {
    if (currentLength - lastEmittedAt < thresholdChars) {
      return false;
    }
    lastEmittedAt = currentLength;
    return true;
  };
}

export function formatCharCount(chars: number): string {
  if (chars < 1000) {
    return `${chars} chars`;
  }
  return `${(chars / 1000).toFixed(1)}k chars`;
}

export function formatCacheUsage(
  cacheReadTokens: number,
  cacheCreationTokens: number
): string {
  if (!cacheReadTokens && !cacheCreationTokens) {
    return "cache: none";
  }
  const parts: string[] = [];
  if (cacheReadTokens) {
    parts.push(`${cacheReadTokens} read`);
  }
  if (cacheCreationTokens) {
    parts.push(`${cacheCreationTokens} written`);
  }
  return `cache: ${parts.join(", ")}`;
}
