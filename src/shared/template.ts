const TEMPLATE_TOKEN_RE = /\{([^{}]+)\}/g;
const DOMAIN_PLACEHOLDER_RE = /^domain(?:-(\d+)(?:to(\d+))?)?$/;
const PATH_PLACEHOLDER_RE = /^path(?:-(\d+)(?:to(\d+))?)?$/;

export interface TemplateRenderContext {
  originalName?: string;
}

interface TemplateParts {
  host: string;
  domain: string;
  domainLabels: string[];
  path: string;
  pathSegments: string[];
  port: string;
  originalName: string;
}

function parseIndex(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 0;
  }
  return parsed;
}

function joinDomainRange(labels: string[], fromRight: number, toRight: number): string {
  if (fromRight < 1 || toRight < fromRight || labels.length === 0 || fromRight > labels.length) {
    return "";
  }

  const boundedEnd = Math.min(toRight, labels.length);
  const startIndex = labels.length - boundedEnd;
  const endIndex = labels.length - fromRight;
  return labels.slice(startIndex, endIndex + 1).join(".");
}

function joinPathRange(segments: string[], fromLeft: number, toLeft: number): string {
  if (fromLeft < 1 || toLeft < fromLeft || segments.length === 0 || fromLeft > segments.length) {
    return "";
  }

  const boundedEnd = Math.min(toLeft, segments.length);
  return segments.slice(fromLeft - 1, boundedEnd).join("/");
}

function buildTemplateParts(url: URL, context?: TemplateRenderContext): TemplateParts {
  const host = url.hostname.toLowerCase();
  const domainLabels = host.split(".").filter(Boolean);
  const pathSegments = url.pathname.split("/").filter(Boolean);

  return {
    host,
    domain: joinDomainRange(domainLabels, 1, 2) || host,
    domainLabels,
    path: pathSegments.join("/"),
    pathSegments,
    port: url.port,
    originalName: context?.originalName ?? ""
  };
}

function resolvePlaceholder(key: string, parts: TemplateParts): string | null {
  if (key === "host") {
    return parts.host;
  }

  if (key === "domain") {
    return parts.domain;
  }

  if (key === "path") {
    return parts.path;
  }

  if (key === "port") {
    return parts.port;
  }

  if (key === "origname") {
    return parts.originalName;
  }

  const domainMatch = DOMAIN_PLACEHOLDER_RE.exec(key);
  if (domainMatch) {
    const fromRight = domainMatch[1] ? parseIndex(domainMatch[1]) : 1;
    const toRight = domainMatch[2] ? parseIndex(domainMatch[2]) : fromRight;
    if (!fromRight || !toRight) {
      return "";
    }
    return joinDomainRange(parts.domainLabels, fromRight, toRight);
  }

  const pathMatch = PATH_PLACEHOLDER_RE.exec(key);
  if (pathMatch) {
    const fromLeft = pathMatch[1] ? parseIndex(pathMatch[1]) : 1;
    const toLeft = pathMatch[2] ? parseIndex(pathMatch[2]) : fromLeft;
    if (!fromLeft || !toLeft) {
      return "";
    }
    return joinPathRange(parts.pathSegments, fromLeft, toLeft);
  }

  return null;
}

export function renderTitleFromTemplate(template: string, urlString: string, context?: TemplateRenderContext): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlString);
  } catch {
    return template;
  }

  const parts = buildTemplateParts(parsedUrl, context);

  return template.replace(TEMPLATE_TOKEN_RE, (match, key: string) => {
    const resolved = resolvePlaceholder(key, parts);
    return resolved === null ? match : resolved;
  });
}

export function hasTemplatePlaceholders(value: string): boolean {
  TEMPLATE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TEMPLATE_TOKEN_RE.exec(value)) !== null) {
    const key = match[1] ?? "";
    if (key === "host" || key === "domain" || key === "path" || key === "port" || key === "origname") {
      return true;
    }

    if (DOMAIN_PLACEHOLDER_RE.test(key) || PATH_PLACEHOLDER_RE.test(key)) {
      return true;
    }
  }

  return false;
}
