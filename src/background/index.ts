import { matchesPattern, selectBestRule, validateMatchPattern } from "../shared/match";
import { getState, saveState, STORAGE_KEY, updateState, createRuleId } from "../shared/state";
import { hasTemplatePlaceholders, renderTitleFromTemplate } from "../shared/template";
import { DEFAULT_STATE, type RenameRule, type RuleMode } from "../shared/types";

const CONTENT_SCRIPT_ID = "tab-autorename-content";
const CONTENT_SCRIPT_FILE = "content/rename.js";

interface MessageBase {
  type: string;
}

interface ResolveTitleMessage extends MessageBase {
  type: "RESOLVE_TITLE";
  url: string;
}

interface GetStateMessage extends MessageBase {
  type: "GET_STATE";
}

interface SetGlobalEnabledMessage extends MessageBase {
  type: "SET_GLOBAL_ENABLED";
  enabled: boolean;
}

interface UpsertRuleMessage extends MessageBase {
  type: "UPSERT_RULE";
  payload: {
    id?: string;
    pattern: string;
    value: string;
  };
}

interface DeleteRuleMessage extends MessageBase {
  type: "DELETE_RULE";
  id: string;
}

interface ToggleRuleMessage extends MessageBase {
  type: "TOGGLE_RULE";
  id: string;
  enabled: boolean;
}

interface PermissionsChangedMessage extends MessageBase {
  type: "PERMISSIONS_CHANGED";
}

interface GetPermissionMapMessage extends MessageBase {
  type: "GET_PERMISSION_MAP";
  patterns: string[];
}

interface GetRuleMatchMessage extends MessageBase {
  type: "GET_RULE_MATCH";
  url: string;
}

type KnownMessage =
  | ResolveTitleMessage
  | GetStateMessage
  | SetGlobalEnabledMessage
  | UpsertRuleMessage
  | DeleteRuleMessage
  | ToggleRuleMessage
  | PermissionsChangedMessage
  | GetPermissionMapMessage
  | GetRuleMatchMessage;

type SanitizedRuleInputResult =
  | {
      ok: true;
      normalizedPattern: string;
    }
  | {
      ok: false;
      reason: string;
    };

let reconcileTimer: number | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessage(value: unknown): KnownMessage | null {
  if (!isObject(value) || typeof value.type !== "string") {
    return null;
  }

  return value as unknown as KnownMessage;
}

async function initializeStorage(): Promise<void> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  if (!(STORAGE_KEY in stored)) {
    await saveState(DEFAULT_STATE);
  }
}

function sanitizeRuleInput(payload: UpsertRuleMessage["payload"]): SanitizedRuleInputResult {
  const validation = validateMatchPattern(payload.pattern.trim());
  if (!validation.valid || !validation.normalized) {
    return {
      ok: false,
      reason: validation.reason ?? "Pattern is invalid"
    };
  }

  const value = payload.value.trim();
  if (!value) {
    return {
      ok: false,
      reason: "Title value cannot be empty"
    };
  }

  return {
    ok: true,
    normalizedPattern: validation.normalized
  };
}

async function unregisterRenameContentScript(): Promise<void> {
  try {
    await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch {
    // Ignore if script is not currently registered.
  }
}

async function injectContentScriptIntoOpenTabs(activePatterns: string[]): Promise<void> {
  if (activePatterns.length === 0) {
    return;
  }

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || typeof tab.url !== "string") {
      continue;
    }

    const shouldInject = activePatterns.some((pattern) => matchesPattern(pattern, tab.url as string));
    if (!shouldInject) {
      continue;
    }

    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: [CONTENT_SCRIPT_FILE]
      });
    } catch {
      // Ignore restricted tabs or transient execution failures.
    }
  }
}

async function reconcileRegisteredContentScript(): Promise<void> {
  const state = await getState();
  if (!state.globalEnabled) {
    await unregisterRenameContentScript();
    return;
  }

  const hasEnabledRules = state.rules.some((rule) => rule.enabled);
  if (!hasEnabledRules) {
    await unregisterRenameContentScript();
    return;
  }

  const granted = await browser.permissions.getAll();
  const activePatterns = Array.from(
    new Set(
      (granted.origins ?? [])
        .map((pattern) => validateMatchPattern(pattern))
        .filter((result) => result.valid && typeof result.normalized === "string")
        .map((result) => result.normalized as string)
    )
  );

  await unregisterRenameContentScript();

  if (activePatterns.length === 0) {
    return;
  }

  await browser.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: [CONTENT_SCRIPT_FILE],
      matches: activePatterns,
      runAt: "document_start",
      allFrames: false
    }
  ]);

  await injectContentScriptIntoOpenTabs(activePatterns);
}

function scheduleReconcile(): void {
  if (reconcileTimer !== null) {
    clearTimeout(reconcileTimer);
  }

  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileRegisteredContentScript().catch((error) => {
      console.error("Failed to reconcile content script", error);
    });
  }, 120) as unknown as number;
}

function buildTitleFromRule(rule: RenameRule, url: string): string {
  const title = hasTemplatePlaceholders(rule.value) ? renderTitleFromTemplate(rule.value, url) : rule.value;
  return title.trim();
}

function getRuleModeFromValue(value: string): RuleMode {
  return hasTemplatePlaceholders(value) ? "template" : "static";
}

async function getPermissionMap(patterns: string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};

  for (const pattern of patterns) {
    const validation = validateMatchPattern(pattern);
    if (!validation.valid || !validation.normalized) {
      result[pattern] = false;
      continue;
    }

    result[validation.normalized] = await browser.permissions.contains({ origins: [validation.normalized] });
  }

  return result;
}

async function handleMessage(message: KnownMessage): Promise<unknown> {
  switch (message.type) {
    case "GET_STATE": {
      return {
        ok: true,
        state: await getState()
      };
    }

    case "SET_GLOBAL_ENABLED": {
      const nextState = await updateState((state) => ({
        ...state,
        globalEnabled: Boolean(message.enabled)
      }));
      scheduleReconcile();
      return {
        ok: true,
        state: nextState
      };
    }

    case "UPSERT_RULE": {
      const check = sanitizeRuleInput(message.payload);
      if (!check.ok) {
        return {
          ok: false,
          error: check.reason
        };
      }

      const now = Date.now();
      const normalizedValue = message.payload.value.trim();
      const mode = getRuleModeFromValue(normalizedValue);
      const nextState = await updateState((state) => {
        const nextRules = [...state.rules];
        const existingIndex = message.payload.id
          ? nextRules.findIndex((rule) => rule.id === message.payload.id)
          : -1;

        if (existingIndex >= 0) {
          const existing = nextRules[existingIndex];
          nextRules[existingIndex] = {
            ...existing,
            pattern: check.normalizedPattern,
            mode,
            value: normalizedValue,
            updatedAt: now
          };
        } else {
          nextRules.push({
            id: createRuleId(),
            pattern: check.normalizedPattern,
            mode,
            value: normalizedValue,
            enabled: true,
            createdAt: now,
            updatedAt: now
          });
        }

        return {
          ...state,
          rules: nextRules
        };
      });

      scheduleReconcile();
      return {
        ok: true,
        state: nextState
      };
    }

    case "DELETE_RULE": {
      const nextState = await updateState((state) => ({
        ...state,
        rules: state.rules.filter((rule) => rule.id !== message.id)
      }));
      scheduleReconcile();
      return {
        ok: true,
        state: nextState
      };
    }

    case "TOGGLE_RULE": {
      const nextState = await updateState((state) => ({
        ...state,
        rules: state.rules.map((rule) =>
          rule.id === message.id
            ? {
                ...rule,
                enabled: Boolean(message.enabled),
                updatedAt: Date.now()
              }
            : rule
        )
      }));
      scheduleReconcile();
      return {
        ok: true,
        state: nextState
      };
    }

    case "PERMISSIONS_CHANGED": {
      scheduleReconcile();
      return { ok: true };
    }

    case "GET_PERMISSION_MAP": {
      return {
        ok: true,
        map: await getPermissionMap(message.patterns)
      };
    }

    case "GET_RULE_MATCH": {
      const state = await getState();
      if (!state.globalEnabled) {
        return { ok: true, globalEnabled: false, match: null };
      }

      const match = selectBestRule(state.rules, message.url);
      return {
        ok: true,
        globalEnabled: true,
        match: match
          ? {
              id: match.id,
              pattern: match.pattern,
              mode: getRuleModeFromValue(match.value),
              value: match.value,
              enabled: match.enabled
            }
          : null
      };
    }

    case "RESOLVE_TITLE": {
      const state = await getState();
      if (!state.globalEnabled) {
        return { applied: false };
      }

      const rule = selectBestRule(state.rules, message.url);
      if (!rule) {
        return { applied: false };
      }

      const title = buildTitleFromRule(rule, message.url);
      if (!title) {
        return { applied: false };
      }

      return {
        applied: true,
        title,
        ruleId: rule.id
      };
    }

    default:
      return {
        ok: false,
        error: "Unknown message"
      };
  }
}

browser.runtime.onMessage.addListener((rawMessage) => {
  const message = parseMessage(rawMessage);
  if (!message) {
    return Promise.resolve({ ok: false, error: "Invalid message" });
  }
  return handleMessage(message);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes[STORAGE_KEY]) {
    scheduleReconcile();
  }
});

browser.permissions.onAdded.addListener(() => {
  scheduleReconcile();
});

browser.permissions.onRemoved.addListener(() => {
  scheduleReconcile();
});

browser.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(() => {
    scheduleReconcile();
  });
});

browser.runtime.onStartup.addListener(() => {
  void initializeStorage().then(() => {
    scheduleReconcile();
  });
});

void initializeStorage().then(() => {
  scheduleReconcile();
});
