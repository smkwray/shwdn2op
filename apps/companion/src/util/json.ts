export function parseJsonFromMixedText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Expected JSON output, but command returned empty stdout.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to mixed-output extraction.
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastParsed: unknown;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      if (depth === 0 || start === -1) {
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        try {
          lastParsed = JSON.parse(candidate);
        } catch {
          // Keep scanning for the next balanced JSON block.
        }
        start = -1;
      }
    }
  }

  if (typeof lastParsed !== "undefined") {
    return lastParsed;
  }

  const preview = trimmed.slice(0, 200).replace(/\s+/g, " ");
  throw new Error(`Expected JSON output, but could not find a valid JSON object in: ${preview}`);
}
