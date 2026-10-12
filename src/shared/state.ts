import { DEFAULT_STATE, type ExtensionState, type RenameRule, type RuleMode } from "./types";

export const STORAGE_KEY = "tabAutoRenameState";

function asRuleMode(value: unknown): RuleMode {
  return value === "template" ? "template" : "static";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeRule(input: unknown): RenameRule | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Partial<RenameRule>;
  const now = Date.now();
  const id = asString(candidate.id, "").trim();
  if (!id) {
    return null;
  }

  const pattern = asString(candidate.pattern, "").trim();
  const value = asString(candidate.value, "");

  return {
    id,
    enabled: asBoolean(candidate.enabled, true),
    pattern,
    mode: asRuleMode(candidate.mode),
    value,
    createdAt: asNumber(candidate.createdAt, now),
    updatedAt: asNumber(candidate.updatedAt, now)
  };
}

function sanitizeState(raw: unknown): ExtensionState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STATE, rules: [] };
  }

  const candidate = raw as Partial<ExtensionState>;
  const rulesInput = Array.isArray(candidate.rules) ? candidate.rules : [];
  const rules = rulesInput
    .map((item) => sanitizeRule(item))
    .filter((item): item is RenameRule => item !== null);

  return {
    globalEnabled: asBoolean(candidate.globalEnabled, DEFAULT_STATE.globalEnabled),
    rules
  };
}

export async function getState(): Promise<ExtensionState> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return sanitizeState(stored[STORAGE_KEY]);
}

export async function saveState(state: ExtensionState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: sanitizeState(state) });
}

export async function updateState(mutator: (state: ExtensionState) => ExtensionState): Promise<ExtensionState> {
  const current = await getState();
  const next = sanitizeState(mutator(current));
  await saveState(next);
  return next;
}

export function createRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
