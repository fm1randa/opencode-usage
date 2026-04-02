// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  OPENBAR_ID,
  REFRESH_INTERVAL_MS,
  buildCachePath,
  buildOpenCodeAuthPath,
  emptyCache,
  normalizeCodexPayload,
  normalizeCopilotPayload,
  normalizeZaiPayload,
  nowISO,
  normalizeProviderID,
  readOpenCodeAuthText,
  resolveCodexCredential,
  resolveCopilotCredential,
  resolveZaiCredential,
  resolveZaiUsageURL,
} from "./shared"

const id = OPENBAR_ID
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user"

const rec = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}

const bool = (value: unknown, fallback: boolean) => {
  if (typeof value !== "boolean") return fallback
  return value
}

const num = (value: unknown, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return value
}

const pick = (value: unknown, fallback = "") => {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

const cfg = (value: Record<string, unknown> | undefined) => ({
  enabled: bool(value?.enabled, true),
  refreshMs: Math.max(60_000, num(value?.refresh_ms, REFRESH_INTERVAL_MS)),
  cachePath: pick(value?.cache_path),
})

const createUsage = (provider, status, message, windows = []) => ({
  provider,
  source: "live",
  status,
  fetchedAt: nowISO(),
  windows,
  message,
})

const readCache = async (filePath) => {
  try {
    const text = await readFile(filePath, "utf8")
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object"
      ? {
          version: 1,
          updatedAt: parsed.updatedAt || nowISO(),
          providers: parsed.providers || {},
        }
      : emptyCache()
  } catch {
    return emptyCache()
  }
}

const writeCache = async (filePath, cache) => {
  await mkdir(dirname(filePath), { recursive: true })
  const tempFile = `${filePath}.tmp`
  await writeFile(tempFile, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
  await rename(tempFile, filePath)
}

const staleFallback = (provider, previous, message) => {
  if (previous?.windows?.length) {
    return {
      ...previous,
      provider,
      source: "cache",
      status: "stale",
      message,
    }
  }

  return createUsage(provider, "error", message)
}

const persistSessionProvider = async (filePath, sessionID, providerID) => {
  const provider = normalizeProviderID(providerID)
  if (!provider || !sessionID) return

  const cache = await readCache(filePath)
  cache.updatedAt = nowISO()
  cache.sessionProviders = {
    ...(cache.sessionProviders || {}),
    [sessionID]: provider,
  }
  await writeCache(filePath, cache)
}

const readOpenCodeAuth = async () => {
  const authPath = buildOpenCodeAuthPath(os.homedir(), process.env)
  try {
    return readOpenCodeAuthText(await readFile(authPath, "utf8"))
  } catch {
    return {}
  }
}

const fetchCodexUsage = async (authStore) => {
  const credential = resolveCodexCredential(process.env, authStore)
  const accessToken = credential.accessToken
  const accountId = credential.accountId

  if (!accessToken) {
    return createUsage(
      "openai",
      "missing_auth",
      "Connect OpenCode OpenAI auth or set OPENBAR_CODEX_ACCESS_TOKEN.",
    )
  }

  const response = await fetch(process.env.OPENBAR_CODEX_USAGE_URL?.trim() || CODEX_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
      "User-Agent": "OpenBar",
    },
  })

  if (response.status === 401 || response.status === 403) {
    return createUsage("openai", "missing_auth", "Codex credentials were rejected.")
  }

  if (!response.ok) {
    throw new Error(`Codex usage request failed with ${response.status}.`)
  }

  const payload = normalizeCodexPayload(await response.json())
  if (!payload.windows.length) {
    throw new Error("Codex usage response did not contain rolling window data.")
  }

  return createUsage("openai", "ok", payload.message, payload.windows)
}

const fetchCopilotUsage = async (authStore) => {
  const credential = resolveCopilotCredential(process.env, authStore)
  const token = credential.token

  if (!token) {
    return createUsage(
      "github-copilot",
      "missing_auth",
      "Connect OpenCode GitHub Copilot auth or set OPENBAR_COPILOT_TOKEN.",
    )
  }

  const response = await fetch(process.env.OPENBAR_COPILOT_USAGE_URL?.trim() || COPILOT_USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `token ${token}`,
      "Editor-Plugin-Version": "openbar/0.1.0",
      "Editor-Version": "opencode",
      "User-Agent": "OpenBar",
      "X-Github-Api-Version": "2025-04-01",
    },
  })

  if (response.status === 401 || response.status === 403) {
    return createUsage("github-copilot", "missing_auth", "Copilot credentials were rejected.")
  }

  if (!response.ok) {
    throw new Error(`Copilot usage request failed with ${response.status}.`)
  }

  const payload = normalizeCopilotPayload(await response.json())
  if (!payload.windows.length) {
    throw new Error("Copilot usage response did not contain monthly quota data.")
  }

  return createUsage("github-copilot", "ok", payload.message, payload.windows)
}

const fetchZaiUsage = async (authStore) => {
  const credential = resolveZaiCredential(process.env, authStore)
  const apiKey = credential.apiKey

  if (!apiKey) {
    return createUsage(
      "zai",
      "missing_auth",
      "Set OPENBAR_ZAI_API_KEY to fetch z.ai quota usage.",
    )
  }

  const response = await fetch(resolveZaiUsageURL(process.env), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "User-Agent": "OpenBar",
    },
  })

  if (response.status === 401 || response.status === 403) {
    return createUsage("zai", "missing_auth", "z.ai credentials were rejected.")
  }

  if (!response.ok) {
    throw new Error(`z.ai usage request failed with ${response.status}.`)
  }

  const payload = normalizeZaiPayload(await response.json())
  if (!payload.windows.length) {
    throw new Error("z.ai usage response did not contain quota data.")
  }

  return createUsage("zai", "ok", payload.message, payload.windows)
}

const server: Plugin = async (input, options) => {
  const value = cfg(rec(options))
  if (!value.enabled) return {}

  const cachePath = value.cachePath || buildCachePath(input.directory)
  let cache = await readCache(cachePath)
  let lastRefreshAt = 0
  let inFlight: Promise<void> | undefined

  const refreshAll = async () => {
    if (inFlight) return inFlight

    inFlight = (async () => {
      const previous = cache.providers || {}
      const next = emptyCache()
      const authStore = await readOpenCodeAuth()

      try {
        next.sessionProviders = { ...(cache.sessionProviders || {}) }
        next.providers.openai = await fetchCodexUsage(authStore).catch((error) => {
          return staleFallback("openai", previous.openai, error instanceof Error ? error.message : "Codex usage refresh failed.")
        })

        next.providers["github-copilot"] = await fetchCopilotUsage(authStore).catch((error) => {
          return staleFallback(
            "github-copilot",
            previous["github-copilot"],
            error instanceof Error ? error.message : "Copilot usage refresh failed.",
          )
        })

        next.providers.zai = await fetchZaiUsage(authStore).catch((error) => {
          return staleFallback("zai", previous.zai, error instanceof Error ? error.message : "z.ai usage refresh failed.")
        })

        next.updatedAt = nowISO()
        cache = next
        lastRefreshAt = Date.now()
        await writeCache(cachePath, cache)
      } finally {
        inFlight = undefined
      }
    })()

    return inFlight
  }

  const refreshDue = async () => {
    if (!lastRefreshAt) return refreshAll()
    if (Date.now() - lastRefreshAt >= value.refreshMs) return refreshAll()
  }

  const timer = setInterval(() => {
    void refreshAll()
  }, value.refreshMs)
  timer.unref?.()
  void refreshAll()

  return {
    event: async () => {
      void refreshDue()
    },
    "chat.message": async (message) => {
      if (message?.sessionID && message?.model?.providerID) {
        await persistSessionProvider(cachePath, message.sessionID, message.model.providerID)
        cache = await readCache(cachePath)
      }
      void refreshDue()
    },
  }
}

const plugin = {
  id,
  server,
}

export default plugin
