import { matchesPattern, selectBestRule, validateMatchPattern } from "../shared/match";
import { hasTemplatePlaceholders, renderTitleFromTemplate } from "../shared/template";
import type { ExtensionState, RenameRule } from "../shared/types";

interface BrowserTab {
  id?: number;
  url?: string;
  title?: string;
}

interface OkResponse<T> {
  ok: true;
  [key: string]: unknown;
  data?: T;
}

interface ErrorResponse {
  ok: false;
  error: string;
}

type AnyResponse = OkResponse<unknown> | ErrorResponse;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const ruleForm = requireElement<HTMLFormElement>("#ruleForm");
const formTitle = requireElement<HTMLElement>("#formTitle");
const patternInput = requireElement<HTMLInputElement>("#pattern");
const valueInput = requireElement<HTMLInputElement>("#value");
const valuePreview = requireElement<HTMLElement>("#valuePreview");
const formMessage = requireElement<HTMLElement>("#formMessage");
const cancelEditButton = requireElement<HTMLButtonElement>("#cancelEdit");
const applyChangesButton = requireElement<HTMLButtonElement>("#applyChanges");
const placeholderList = requireElement<HTMLElement>("#placeholderList");
const rulesList = requireElement<HTMLElement>("#rulesList");
const statusLabel = requireElement<HTMLElement>("#status");

let currentTab: BrowserTab | null = null;
let currentOriginPattern: string | null = null;
let state: ExtensionState = {
  globalEnabled: true,
  rules: []
};
let permissionMap: Record<string, boolean> = {};
let editingRuleId: string | null = null;
const PREVIEW_EMPTY_TEXT = "Preview will appear here";
const PREVIEW_EMPTY_RESULT_TEXT = "(empty result)";

function setStatus(message: string, kind: "ok" | "warn" | "muted" = "muted"): void {
  statusLabel.textContent = message;
  statusLabel.classList.remove("ok", "warn");
  if (kind === "ok") {
    statusLabel.classList.add("ok");
  }
  if (kind === "warn") {
    statusLabel.classList.add("warn");
  }
}

function setFormMessage(message: string, kind: "ok" | "warn" | "muted" = "muted"): void {
  formMessage.textContent = message;
  formMessage.classList.remove("ok", "warn");
  if (kind === "ok") {
    formMessage.classList.add("ok");
  }
  if (kind === "warn") {
    formMessage.classList.add("warn");
  }
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers where clipboard API is unavailable in this context.
    }
  }

  const temp = document.createElement("textarea");
  temp.value = value;
  temp.setAttribute("readonly", "true");
  temp.style.position = "fixed";
  temp.style.left = "-9999px";
  document.body.append(temp);
  temp.select();
  const copied = document.execCommand("copy");
  temp.remove();

  if (!copied) {
    throw new Error("Copy failed");
  }
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await browser.runtime.sendMessage(message)) as AnyResponse & T;
  if (!response || response.ok === false) {
    throw new Error(response?.error ?? "Operation failed");
  }
  return response;
}

function buildOriginPattern(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (!(scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss" || scheme === "ftp")) {
      return null;
    }

    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function getMatchingRules(): RenameRule[] {
  const tabUrl = currentTab?.url;
  if (!tabUrl) {
    return [];
  }

  return state.rules
    .filter((rule) => matchesPattern(rule.pattern, tabUrl))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizePattern(pattern: string): string | null {
  const validation = validateMatchPattern(pattern);
  if (!validation.valid || !validation.normalized) {
    return null;
  }
  return validation.normalized;
}

function buildPreviewTitle(templateValue: string): string {
  const value = templateValue.trim();
  if (!value) {
    return "";
  }

  const tabUrl = currentTab?.url ?? "";
  if (!tabUrl || !hasTemplatePlaceholders(value)) {
    return value;
  }

  return renderTitleFromTemplate(value, tabUrl, { originalName: currentTab?.title ?? "" }).trim();
}

function renderValuePreview(): void {
  const value = valueInput.value.trim();
  if (!value) {
    valuePreview.textContent = PREVIEW_EMPTY_TEXT;
    valuePreview.classList.add("muted");
    return;
  }

  const preview = buildPreviewTitle(value);
  valuePreview.textContent = preview || PREVIEW_EMPTY_RESULT_TEXT;
  valuePreview.classList.toggle("muted", preview.length === 0);
}

function resetForm(): void {
  editingRuleId = null;
  formTitle.textContent = "Add rule";
  patternInput.value = currentOriginPattern ?? "";
  valueInput.value = "";
  cancelEditButton.classList.add("hidden");
  renderValuePreview();
}

function startEdit(rule: RenameRule): void {
  editingRuleId = rule.id;
  formTitle.textContent = "Edit rule";
  patternInput.value = rule.pattern;
  valueInput.value = rule.value;
  cancelEditButton.classList.remove("hidden");
  renderValuePreview();
}

function createButton(label: string, className?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) {
    button.className = className;
  }
  return button;
}

function renderRules(): void {
  rulesList.innerHTML = "";

  const matchingRules = getMatchingRules();
  const bestMatchId = currentTab?.url ? selectBestRule(matchingRules, currentTab.url)?.id ?? null : null;

  if (matchingRules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching rules for this tab.";
    rulesList.append(empty);
    return;
  }

  for (const rule of matchingRules) {
    const item = document.createElement("article");
    item.className = rule.id === bestMatchId ? "rule active" : "rule";

    const head = document.createElement("div");
    head.className = "rule-head";

    const left = document.createElement("label");
    left.className = "toggle-row";

    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = rule.enabled;
    enabledToggle.addEventListener("change", async () => {
      try {
        await sendMessage({ type: "TOGGLE_RULE", id: rule.id, enabled: enabledToggle.checked });
        setStatus(enabledToggle.checked ? "Rule enabled" : "Rule disabled", "ok");
        await refreshPopup();
      } catch (error) {
        enabledToggle.checked = !enabledToggle.checked;
        setStatus(error instanceof Error ? error.message : "Failed to toggle rule", "warn");
      }
    });

    const enabledLabel = document.createElement("span");
    enabledLabel.textContent = "Enabled";
    left.append(enabledToggle, enabledLabel);

    const badges = document.createElement("div");
    badges.className = "rule-badges";

    if (rule.id === bestMatchId) {
      const activeBadge = document.createElement("span");
      activeBadge.className = "badge active";
      activeBadge.textContent = "Active";
      badges.append(activeBadge);
    }

    const permissionBadge = document.createElement("span");
    const hasPermission = permissionMap[rule.pattern] === true;
    permissionBadge.className = `badge ${hasPermission ? "ok" : "warn"}`;
    permissionBadge.textContent = hasPermission ? "Access granted" : "Access missing";

    badges.append(permissionBadge);
    head.append(left, badges);

    const pattern = document.createElement("div");
    pattern.className = "rule-pattern";
    pattern.textContent = rule.pattern;

    const meta = document.createElement("div");
    meta.className = "rule-meta";
    meta.textContent = `${hasTemplatePlaceholders(rule.value) ? "Template" : "Static"}: ${rule.value}`;

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const editButton = createButton("Edit", "secondary");
    editButton.addEventListener("click", () => {
      startEdit(rule);
      setFormMessage("Editing rule", "muted");
      patternInput.focus();
    });

    const deleteButton = createButton("Delete", "danger");
    deleteButton.addEventListener("click", async () => {
      if (!confirm("Delete this rule?")) {
        return;
      }

      try {
        const response = (await sendMessage<{ state: ExtensionState }>({
          type: "DELETE_RULE",
          id: rule.id
        })) as { state: ExtensionState };

        state = response.state;
        const revokedCount = await revokeStalePermissions(state);
        if (revokedCount > 0) {
          setStatus(`Rule deleted. Revoked ${revokedCount} unused permission(s).`, "ok");
        } else {
          setStatus("Rule deleted", "ok");
        }

        if (editingRuleId === rule.id) {
          resetForm();
        }

        await refreshPopup();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to delete rule", "warn");
      }
    });

    actions.append(editButton, deleteButton);
    item.append(head, pattern, meta, actions);
    rulesList.append(item);
  }
}

async function loadGlobalState(): Promise<void> {
  const response = (await sendMessage<{ state: ExtensionState }>({ type: "GET_STATE" })) as {
    state: ExtensionState;
  };
  state = response.state;
}

async function loadCurrentTab(): Promise<void> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  currentTab = tab ?? null;
  const tabUrl = tab?.url ?? "";
  currentOriginPattern = tabUrl ? buildOriginPattern(tabUrl) : null;
}

async function loadPermissionMap(): Promise<void> {
  const patterns = state.rules.map((rule) => rule.pattern);
  const response = (await sendMessage<{ map: Record<string, boolean> }>({
    type: "GET_PERMISSION_MAP",
    patterns
  })) as { map: Record<string, boolean> };

  permissionMap = response.map;
}

async function revokeStalePermissions(nextState: ExtensionState): Promise<number> {
  const activePatterns = new Set(
    nextState.rules
      .map((rule) => normalizePattern(rule.pattern))
      .filter((pattern): pattern is string => typeof pattern === "string")
  );

  const granted = await browser.permissions.getAll();
  const staleOrigins = Array.from(
    new Set(
      (granted.origins ?? [])
        .map((origin) => normalizePattern(origin))
        .filter((origin): origin is string => typeof origin === "string")
        .filter((origin) => !activePatterns.has(origin))
    )
  );

  if (staleOrigins.length === 0) {
    return 0;
  }

  const removed = await browser.permissions.remove({ origins: staleOrigins });
  if (removed) {
    await sendMessage({ type: "PERMISSIONS_CHANGED" });
    return staleOrigins.length;
  }

  return 0;
}

async function runApplyFlow(): Promise<void> {
  const matchingEnabledPatterns = Array.from(
    new Set(
      getMatchingRules()
        .filter((rule) => rule.enabled)
        .map((rule) => normalizePattern(rule.pattern))
        .filter((pattern): pattern is string => typeof pattern === "string")
    )
  );

  const missingPermissions = matchingEnabledPatterns.filter((pattern) => permissionMap[pattern] !== true);

  if (missingPermissions.length > 0) {
    const granted = await browser.permissions.request({ origins: missingPermissions });
    if (granted) {
      await sendMessage({ type: "PERMISSIONS_CHANGED" });
      setStatus("Permissions granted. Closing popup...", "ok");
      return;
    }

    setStatus("Permission request was not granted. Closing popup...", "warn");
    return;
  }

  setStatus("Nothing to apply. Closing popup...", "ok");
}

function closePopup(): void {
  window.close();

  // Some browsers may ignore a close in an async callback. Retry in the next task.
  setTimeout(() => {
    if (window.closed) {
      return;
    }

    window.open("", "_self");
    window.close();
  }, 0);
}

function rulePatternMatchesCurrentTab(pattern: string): boolean {
  const tabUrl = currentTab?.url;
  if (!tabUrl) {
    return false;
  }

  return matchesPattern(pattern, tabUrl);
}

async function refreshPopup(): Promise<void> {
  await loadGlobalState();
  await loadCurrentTab();
  await loadPermissionMap();
  renderRules();

  if (!editingRuleId && !patternInput.value.trim() && currentOriginPattern) {
    patternInput.value = currentOriginPattern;
  }

  renderValuePreview();
}

ruleForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const validation = validateMatchPattern(patternInput.value.trim());
  if (!validation.valid || !validation.normalized) {
    setFormMessage(validation.reason ?? "Invalid match pattern", "warn");
    return;
  }

  if (!rulePatternMatchesCurrentTab(validation.normalized)) {
    setFormMessage("Rule pattern must match the current tab URL", "warn");
    return;
  }

  const value = valueInput.value.trim();
  if (!value) {
    setFormMessage("Title or template cannot be empty", "warn");
    return;
  }

  try {
    await sendMessage({
      type: "UPSERT_RULE",
      payload: {
        id: editingRuleId ?? undefined,
        pattern: validation.normalized,
        value
      }
    });

    setFormMessage(editingRuleId ? "Rule updated. Click Apply to request access." : "Rule added. Click Apply to request access.", "ok");
    resetForm();
    await refreshPopup();
  } catch (error) {
    setFormMessage(error instanceof Error ? error.message : "Failed to save rule", "warn");
  }
});

cancelEditButton.addEventListener("click", () => {
  resetForm();
  setFormMessage("Edit cancelled", "muted");
});

valueInput.addEventListener("input", () => {
  renderValuePreview();
});

placeholderList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const chip = target?.closest<HTMLButtonElement>(".placeholder-chip");
  const placeholder = chip?.dataset.placeholder;

  if (!placeholder) {
    return;
  }

  void copyTextToClipboard(placeholder)
    .then(() => {
      setFormMessage(`Copied ${placeholder} to clipboard`, "ok");
    })
    .catch(() => {
      setFormMessage("Failed to copy placeholder", "warn");
    });
});

applyChangesButton.addEventListener("click", () => {
  applyChangesButton.disabled = true;

  // Start permission request flow first, then close synchronously while still in user gesture context.
  void runApplyFlow().catch((error) => {
    console.error("Failed to apply changes", error);
  });

  closePopup();
});

void refreshPopup()
  .then(() => {
    resetForm();
  })
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : "Failed to load popup", "warn");
  });
