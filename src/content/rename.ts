import { selectBestRule } from "../shared/match";
import { getState, STORAGE_KEY } from "../shared/state";
import { hasTemplatePlaceholders, renderTitleFromTemplate } from "../shared/template";
import type { ExtensionState, RenameRule } from "../shared/types";

const TITLE_CACHE_KEY = "tabAutoRenameHostTitleCache";
const HOST_CACHE_MAX_ENTRIES = 250;
const HOST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface HostTitleCacheEntry {
  title: string;
  updatedAt: number;
}

type HostTitleCache = Record<string, HostTitleCacheEntry>;

interface WindowWithTabAutoRename extends Window {
  __tabAutoRenameInitialized?: boolean;
}

let internalTitleWrite = false;
let cachedState: ExtensionState | null = null;
let desiredTitle: string | null = null;
let refreshQueued = false;
let refreshRunning = false;
let originalTitleForCurrentUrl = document.title;
let hostTitleCache: HostTitleCache | null = null;
let hostCacheLoadPromise: Promise<void> | null = null;
let hostCachePersistRunning = false;
let pendingHostTitlePersist: string | null = null;

function getHostFromUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function sanitizeHostTitleCacheEntry(value: unknown): HostTitleCacheEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<HostTitleCacheEntry>;
  if (typeof candidate.title !== "string") {
    return null;
  }

  const title = candidate.title.trim();
  if (!title) {
    return null;
  }

  const updatedAt =
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now();

  return { title, updatedAt };
}

function sanitizeHostTitleCache(raw: unknown): HostTitleCache {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const now = Date.now();
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([host, value]) => {
      const normalizedHost = host.trim().toLowerCase();
      if (!normalizedHost) {
        return null;
      }

      const entry = sanitizeHostTitleCacheEntry(value);
      if (!entry || now - entry.updatedAt > HOST_CACHE_TTL_MS) {
        return null;
      }

      return [normalizedHost, entry] as const;
    })
    .filter((item): item is readonly [string, HostTitleCacheEntry] => item !== null)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, HOST_CACHE_MAX_ENTRIES);

  return Object.fromEntries(entries);
}

async function ensureHostTitleCacheLoaded(): Promise<void> {
  if (hostTitleCache !== null) {
    return;
  }

  if (hostCacheLoadPromise) {
    await hostCacheLoadPromise;
    return;
  }

  hostCacheLoadPromise = (async () => {
    try {
      const stored = await browser.storage.local.get(TITLE_CACHE_KEY);
      hostTitleCache = sanitizeHostTitleCache(stored[TITLE_CACHE_KEY]);
    } catch {
      hostTitleCache = {};
    }
  })();

  try {
    await hostCacheLoadPromise;
  } finally {
    hostCacheLoadPromise = null;
  }
}

function getCachedHostTitleForCurrentUrl(): string | null {
  if (!hostTitleCache) {
    return null;
  }

  const host = getHostFromUrl(location.href);
  if (!host) {
    return null;
  }

  const entry = hostTitleCache[host];
  return entry?.title ?? null;
}

function applyCachedHostTitleForCurrentUrl(): void {
  if (cachedState) {
    return;
  }

  const cachedTitle = getCachedHostTitleForCurrentUrl();
  if (!cachedTitle) {
    return;
  }

  desiredTitle = cachedTitle;
  applyDesiredTitleIfNeeded();
}

async function persistHostTitleForCurrentUrl(title: string): Promise<void> {
  const host = getHostFromUrl(location.href);
  if (!host) {
    return;
  }

  await ensureHostTitleCacheLoaded();
  if (!hostTitleCache) {
    return;
  }

  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return;
  }

  const existing = hostTitleCache[host];
  if (existing && existing.title === normalizedTitle) {
    return;
  }

  hostTitleCache[host] = {
    title: normalizedTitle,
    updatedAt: Date.now()
  };

  hostTitleCache = sanitizeHostTitleCache(hostTitleCache);
  await browser.storage.local.set({ [TITLE_CACHE_KEY]: hostTitleCache });
}

async function flushHostTitlePersistQueue(): Promise<void> {
  if (hostCachePersistRunning) {
    return;
  }

  hostCachePersistRunning = true;
  try {
    while (pendingHostTitlePersist) {
      const nextTitle = pendingHostTitlePersist;
      pendingHostTitlePersist = null;
      await persistHostTitleForCurrentUrl(nextTitle);
    }
  } catch {
    // Ignore storage write failures to avoid breaking page behavior.
  } finally {
    hostCachePersistRunning = false;
  }
}

function queueHostTitlePersist(title: string): void {
  pendingHostTitlePersist = title;
  queueMicrotask(() => {
    void flushHostTitlePersistQueue();
  });
}

function buildTitleFromRule(rule: RenameRule, url: string, originalName: string): string {
  const title = hasTemplatePlaceholders(rule.value)
    ? renderTitleFromTemplate(rule.value, url, { originalName })
    : rule.value;
  return title.trim();
}

function computeDesiredTitle(state: ExtensionState, url: string, originalName: string): string | null {
  if (!state.globalEnabled) {
    return null;
  }

  const rule = selectBestRule(state.rules, url);
  if (!rule) {
    return null;
  }

  const title = buildTitleFromRule(rule, url, originalName);
  return title || null;
}

function applyDesiredTitleIfNeeded(): void {
  if (!desiredTitle) {
    return;
  }

  if (document.title !== desiredTitle) {
    internalTitleWrite = true;
    document.title = desiredTitle;
    internalTitleWrite = false;
  }
}

async function refreshStateAndApply(): Promise<void> {
  try {
    cachedState = await getState();
  } catch {
    cachedState = null;
    desiredTitle = null;
    return;
  }

  const previousDesiredTitle = desiredTitle;
  desiredTitle = computeDesiredTitle(cachedState, location.href, originalTitleForCurrentUrl);

  if (desiredTitle && desiredTitle !== previousDesiredTitle) {
    queueHostTitlePersist(desiredTitle);
  }

  applyDesiredTitleIfNeeded();
}

async function runRefreshLoop(): Promise<void> {
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }

  refreshRunning = true;
  do {
    refreshQueued = false;
    await refreshStateAndApply();
  } while (refreshQueued);
  refreshRunning = false;
}

function scheduleRefresh(): void {
  if (refreshQueued) {
    return;
  }

  refreshQueued = true;
  queueMicrotask(() => {
    void runRefreshLoop();
  });
}

function applyForCurrentUrl(): void {
  originalTitleForCurrentUrl = document.title;

  if (!cachedState) {
    applyCachedHostTitleForCurrentUrl();
    scheduleRefresh();
    return;
  }

  const previousDesiredTitle = desiredTitle;
  desiredTitle = computeDesiredTitle(cachedState, location.href, originalTitleForCurrentUrl);

  if (desiredTitle && desiredTitle !== previousDesiredTitle) {
    queueHostTitlePersist(desiredTitle);
  }

  applyDesiredTitleIfNeeded();
}

function patchHistoryMethods(): void {
  const originalPushState = history.pushState.bind(history);
  history.pushState = ((...args) => {
    const result = originalPushState(...args);
    applyForCurrentUrl();
    return result;
  }) as History["pushState"];

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = ((...args) => {
    const result = originalReplaceState(...args);
    applyForCurrentUrl();
    return result;
  }) as History["replaceState"];
}

function observeTitleChanges(): void {
  const observer = new MutationObserver(() => {
    if (internalTitleWrite) {
      return;
    }

    if (desiredTitle) {
      applyDesiredTitleIfNeeded();
      return;
    }

    originalTitleForCurrentUrl = document.title;

    if (!cachedState) {
      scheduleRefresh();
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });
}

function observeStorageChanges(): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[TITLE_CACHE_KEY]) {
      hostTitleCache = sanitizeHostTitleCache(changes[TITLE_CACHE_KEY].newValue);
      applyCachedHostTitleForCurrentUrl();
    }

    if (changes[STORAGE_KEY]) {
      scheduleRefresh();
    }
  });
}

const runtimeWindow = window as WindowWithTabAutoRename;

if (!runtimeWindow.__tabAutoRenameInitialized) {
  runtimeWindow.__tabAutoRenameInitialized = true;

  window.addEventListener("popstate", () => {
    applyForCurrentUrl();
  });

  window.addEventListener("hashchange", () => {
    applyForCurrentUrl();
  });

  patchHistoryMethods();
  observeTitleChanges();
  observeStorageChanges();
  void ensureHostTitleCacheLoaded().then(() => {
    applyCachedHostTitleForCurrentUrl();
  });
  scheduleRefresh();
}
