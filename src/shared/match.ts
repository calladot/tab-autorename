import type { RenameRule } from "./types";

const SUPPORTED_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "data", "file"]);
const WILDCARD_SCHEMES = new Set(["http", "https", "ws", "wss"]);

interface ParsedPattern {
  allUrls: boolean;
  scheme: string;
  host: string;
  path: string;
}

interface PatternSpecificity {
  schemeScore: number;
  hostScore: number;
  hostLiteralLength: number;
  pathLiteralLength: number;
  wildcardPenalty: number;
}

export interface PatternValidation {
  valid: boolean;
  reason?: string;
  normalized?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardPathToRegExp(pathPattern: string): RegExp {
  const source = `^${escapeRegExp(pathPattern).replace(/\\\*/g, ".*")}$`;
  return new RegExp(source);
}

function parsePattern(rawPattern: string): ParsedPattern | null {
  const pattern = rawPattern.trim();

  if (pattern === "<all_urls>") {
    return {
      allUrls: true,
      scheme: "*",
      host: "*",
      path: "/*"
    };
  }

  const match = /^([*]|http|https|ws|wss|ftp|data|file):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!match) {
    return null;
  }

  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const path = match[3];

  if (!path.startsWith("/")) {
    return null;
  }

  if (scheme !== "*" && !SUPPORTED_SCHEMES.has(scheme)) {
    return null;
  }

  if (scheme === "file") {
    if (host !== "" && host !== "*") {
      return null;
    }
  } else if (!host) {
    return null;
  }

  if (host.includes(":")) {
    return null;
  }

  if (host !== "" && host !== "*") {
    if (host.startsWith("*.")) {
      const suffix = host.slice(2);
      if (!suffix || suffix.includes("*")) {
        return null;
      }
    } else if (host.includes("*")) {
      return null;
    }
  }

  return {
    allUrls: false,
    scheme,
    host,
    path
  };
}

function normalizePattern(parsed: ParsedPattern): string {
  if (parsed.allUrls) {
    return "<all_urls>";
  }
  return `${parsed.scheme}://${parsed.host}${parsed.path}`;
}

export function validateMatchPattern(pattern: string): PatternValidation {
  const parsed = parsePattern(pattern);
  if (!parsed) {
    return {
      valid: false,
      reason: "Invalid match pattern"
    };
  }

  return {
    valid: true,
    normalized: normalizePattern(parsed)
  };
}

export function matchesPattern(pattern: string, urlString: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  if (parsed.allUrls) {
    return SUPPORTED_SCHEMES.has(scheme);
  }

  if (parsed.scheme === "*") {
    if (!WILDCARD_SCHEMES.has(scheme)) {
      return false;
    }
  } else if (parsed.scheme !== scheme) {
    return false;
  }

  if (parsed.scheme !== "file") {
    const host = url.hostname.toLowerCase();

    if (parsed.host === "*") {
      // Any host is allowed.
    } else if (parsed.host.startsWith("*.")) {
      const suffix = parsed.host.slice(2);
      if (!(host === suffix || host.endsWith(`.${suffix}`))) {
        return false;
      }
    } else if (host !== parsed.host) {
      return false;
    }
  }

  const pathWithQuery = `${url.pathname}${url.search}`;
  return wildcardPathToRegExp(parsed.path).test(pathWithQuery);
}

function getSpecificity(pattern: string): PatternSpecificity | null {
  const parsed = parsePattern(pattern);
  if (!parsed) {
    return null;
  }

  if (parsed.allUrls) {
    return {
      schemeScore: 0,
      hostScore: 0,
      hostLiteralLength: 0,
      pathLiteralLength: 0,
      wildcardPenalty: 999
    };
  }

  const hostScore =
    parsed.host === "*" ? 1 : parsed.host.startsWith("*.") ? 2 : parsed.host === "" ? 0 : 3;

  const wildcardCount =
    (parsed.scheme === "*" ? 1 : 0) +
    (parsed.host.match(/\*/g)?.length ?? 0) +
    (parsed.path.match(/\*/g)?.length ?? 0);

  return {
    schemeScore: parsed.scheme === "*" ? 1 : 2,
    hostScore,
    hostLiteralLength: parsed.host.replace(/\*/g, "").length,
    pathLiteralLength: parsed.path.replace(/\*/g, "").length,
    wildcardPenalty: wildcardCount
  };
}

function compareSpecificity(a: PatternSpecificity, b: PatternSpecificity): number {
  if (a.schemeScore !== b.schemeScore) {
    return a.schemeScore - b.schemeScore;
  }
  if (a.hostScore !== b.hostScore) {
    return a.hostScore - b.hostScore;
  }
  if (a.hostLiteralLength !== b.hostLiteralLength) {
    return a.hostLiteralLength - b.hostLiteralLength;
  }
  if (a.pathLiteralLength !== b.pathLiteralLength) {
    return a.pathLiteralLength - b.pathLiteralLength;
  }
  return b.wildcardPenalty - a.wildcardPenalty;
}

export function selectBestRule(rules: RenameRule[], urlString: string): RenameRule | null {
  let winner: RenameRule | null = null;
  let winnerSpecificity: PatternSpecificity | null = null;

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (!matchesPattern(rule.pattern, urlString)) {
      continue;
    }

    const specificity = getSpecificity(rule.pattern);
    if (!specificity) {
      continue;
    }

    if (!winner || !winnerSpecificity || compareSpecificity(specificity, winnerSpecificity) > 0) {
      winner = rule;
      winnerSpecificity = specificity;
    }
  }

  return winner;
}
