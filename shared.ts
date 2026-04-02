import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

export const OPENBAR_ID = "openbar"
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const ZAI_QUOTA_PATH = "api/monitor/usage/quota/limit"

export type SupportedProvider = "openai" | "github-copilot" | "zai"
export type ProviderStatus = "ok" | "stale" | "missing_auth" | "error" | "unavailable"
export type ProviderResolutionSource = "selected_model" | "session_assistant" | "unavailable"
export type UsageUnit = "requests" | "interactions" | "credits" | "tokens"

export type WindowUsage = {
  label: string
  used?: number
  limit?: number
  remaining?: number
  unit?: UsageUnit
  resetsAt?: string
  usedPercent?: number
}

export type ProviderUsage = {
  provider: SupportedProvider
  source: "live" | "cache"
  status: ProviderStatus
  fetchedAt: string
  windows: WindowUsage[]
  message?: string
}

export type OpenBarCache = {
  version: 1
  updatedAt: string
  providers: Partial<Record<SupportedProvider, ProviderUsage>>
  sessionProviders: Record<string, SupportedProvider>
}

export type OpenCodeAuthEntry =
  | {
      type: "oauth"
      refresh: string
      access: string
      expires: number
      accountId?: string
      enterpriseUrl?: string
    }
  | {
      type: "api"
      key: string
    }
  | {
      type: "wellknown"
      key: string
      token: string
    }

export type OpenCodeAuthStore = Record<string, OpenCodeAuthEntry>

type EnvInput = Record<string, string | undefined>

export type CodexCredential = {
  accessToken?: string
  accountId?: string
  source: "env" | "opencode" | "missing"
}

export type CopilotCredential = {
  token?: string
  source: "env" | "opencode" | "missing"
}

export type ZaiCredential = {
  apiKey?: string
  source: "env" | "opencode" | "missing"
}

type ResolvedProvider = {
  provider?: SupportedProvider
  source: ProviderResolutionSource
}

type NormalizedPayload = {
  windows: WindowUsage[]
  message?: string
}

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
}

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed || undefined
}

const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min
  if (value > max) return max
  return value
}

const title = (value: string) => {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
}

const parseReset = (value: unknown): string | undefined => {
  const text = asString(value)
  if (text) {
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString()
  }

  const unix = toNumber(value)
  if (!unix || unix <= 0) return
  const parsed = new Date(unix > 1_000_000_000_000 ? unix : unix * 1000)
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString()
}

const formatCopilotLabel = (quotaId: string) => {
  const value = quotaId.toLowerCase()
  if (value.includes("premium") || value.includes("completion") || value.includes("code")) return "PREMIUM"
  if (value.includes("chat")) return "CHAT"
  if (!value) return "MONTH"
  return title(value).toUpperCase()
}

const normalizeCountSnapshot = (
  quotaId: string,
  monthly: Record<string, unknown> | undefined,
  limited: Record<string, unknown> | undefined,
): WindowUsage | undefined => {
  const entitlement = toNumber(monthly?.[quotaId])
  const remaining = toNumber(limited?.[quotaId] ?? monthly?.[quotaId])
  if (entitlement == null && remaining == null) return

  const limit = Math.max(0, entitlement ?? remaining ?? 0)
  const left = clamp(Math.max(0, remaining ?? limit), 0, limit || Number.MAX_SAFE_INTEGER)
  const used = Math.max(0, limit - left)
  return {
    label: formatCopilotLabel(quotaId),
    used,
    limit,
    remaining: left,
    unit: "interactions",
  }
}

const normalizeDirectCopilotSnapshot = (quotaId: string, value: unknown): WindowUsage | undefined => {
  const record = toRecord(value)
  if (!record) return

  const entitlement = Math.max(0, toNumber(record.entitlement) ?? 0)
  const remaining = Math.max(0, toNumber(record.remaining) ?? 0)
  const percentRemaining = clamp(Math.max(0, toNumber(record.percent_remaining) ?? 0), 0, 100)
  const rawQuotaId = asString(record.quota_id) ?? quotaId

  if (entitlement <= 0 && remaining <= 0 && percentRemaining <= 0 && !rawQuotaId) return

  const limit = entitlement > 0 ? entitlement : remaining > 0 && percentRemaining > 0 ? remaining / (percentRemaining / 100) : 0
  if (!limit || !Number.isFinite(limit)) return

  const left = clamp(
    remaining > 0 ? remaining : limit * (percentRemaining / 100),
    0,
    limit,
  )

  return {
    label: formatCopilotLabel(rawQuotaId),
    used: Math.max(0, limit - left),
    limit,
    remaining: left,
    unit: "interactions",
  }
}

export const nowISO = () => new Date().toISOString()

export const emptyCache = (): OpenBarCache => ({
  version: 1,
  updatedAt: nowISO(),
  providers: {},
  sessionProviders: {},
})

export const normalizeProviderID = (value: unknown): SupportedProvider | undefined => {
  const id = asString(value)?.toLowerCase()
  if (!id) return
  if (id === "openai" || id.startsWith("openai")) return "openai"
  if (id.includes("github-copilot")) return "github-copilot"
  if (id === "zai" || id === "z.ai" || id.startsWith("zai-") || id.startsWith("z.ai-")) return "zai"
}

export const resolveProviderFromModelString = (value: unknown): SupportedProvider | undefined => {
  const model = asString(value)
  if (!model) return
  const [provider] = model.split("/", 1)
  return normalizeProviderID(provider)
}

export const providerLabel = (provider?: SupportedProvider) => {
  if (provider === "openai") return "Codex"
  if (provider === "github-copilot") return "GitHub Copilot"
  if (provider === "zai") return "z.ai"
  return "OpenBar"
}

const buildURLFromOverride = (value: string) => {
  const text = value.includes("://") ? value : `https://${value}`
  const url = new URL(text)
  if (!url.pathname || url.pathname === "/") {
    url.pathname = `/${ZAI_QUOTA_PATH}`
  }
  return url.toString()
}

export const resolveZaiUsageURL = (env: EnvInput = process.env) => {
  const quotaURL = asString(env.OPENBAR_ZAI_QUOTA_URL)
  if (quotaURL) return buildURLFromOverride(quotaURL)

  const apiHost = asString(env.OPENBAR_ZAI_API_HOST)
  if (apiHost) return buildURLFromOverride(apiHost)

  return `https://api.z.ai/${ZAI_QUOTA_PATH}`
}

export const buildCachePath = (root: string) => {
  const digest = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12)
  return path.join(os.tmpdir(), "openbar", `${digest}.json`)
}

export const buildOpenCodeAuthPath = (
  home = os.homedir(),
  env: EnvInput = process.env,
) => {
  const xdgDataHome = asString(env.XDG_DATA_HOME) ?? path.join(home, ".local", "share")
  return path.join(xdgDataHome, "opencode", "auth.json")
}

export const formatWindowLabel = (seconds: number) => {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "WINDOW"
  if (seconds % 86_400 === 0) return `${seconds / 86_400}D`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}H`
  if (seconds % 60 === 0) return `${seconds / 60}M`
  return `${Math.round(seconds)}S`
}

export const resolveProviderFromMessages = (
  messages: unknown[],
  selectedModel?: string,
): ResolvedProvider => {
  const selectedProvider = resolveProviderFromModelString(selectedModel)
  if (selectedProvider) {
    return { provider: selectedProvider, source: "selected_model" }
  }

  return resolveProviderFromMessageHistory(messages)
}

export const resolveProviderFromMessageHistory = (messages: unknown[]): ResolvedProvider => {
  
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = toRecord(messages[index])
    if (!record || record.role !== "user") continue
    const model = toRecord(record.model)
    const provider = normalizeProviderID(model?.providerID)
    if (provider) return { provider, source: "selected_model" }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = toRecord(messages[index])
    if (!record || record.role !== "assistant") continue
    const provider = normalizeProviderID(record.providerID)
    if (provider) return { provider, source: "session_assistant" }
  }

  return { source: "unavailable" }
}

export const resolveSessionRoot = (messages: unknown[], fallbackRoot = process.cwd()) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = toRecord(messages[index])
    if (!record || record.role !== "assistant") continue
    const messagePath = toRecord(record.path)
    const root = asString(messagePath?.root)
    if (root) return root
  }

  return path.resolve(fallbackRoot)
}

export const readCacheText = (text: string): OpenBarCache => {
  const parsed = JSON.parse(text)
  const record = toRecord(parsed)
  if (!record) return emptyCache()
  const providers = toRecord(record.providers)
  const sessionProviders = toRecord(record.sessionProviders)

  const normalizedSessionProviders = Object.fromEntries(
    Object.entries(sessionProviders ?? {}).flatMap(([sessionID, provider]) => {
      const normalized = normalizeProviderID(provider)
      return normalized ? [[sessionID, normalized]] : []
    }),
  ) as Record<string, SupportedProvider>

  return {
    version: 1,
    updatedAt: asString(record.updatedAt) ?? nowISO(),
    providers: {
      openai: toRecord(providers?.openai) as ProviderUsage | undefined,
      "github-copilot": toRecord(providers?.["github-copilot"]) as ProviderUsage | undefined,
      zai: toRecord(providers?.zai) as ProviderUsage | undefined,
    },
    sessionProviders: normalizedSessionProviders,
  }
}

export const resolveProviderForSession = (
  sessionID: string,
  messages: unknown[],
  selectedModel?: string,
  sessionProviders: Record<string, SupportedProvider> = {},
): ResolvedProvider => {
  const selectedProvider = resolveProviderFromModelString(selectedModel)
  if (selectedProvider) {
    return { provider: selectedProvider, source: "selected_model" }
  }

  const persisted = sessionProviders[sessionID]
  if (persisted) {
    return { provider: persisted, source: "selected_model" }
  }

  return resolveProviderFromMessageHistory(messages)
}

export const readOpenCodeAuthText = (text: string): OpenCodeAuthStore => {
  const parsed = JSON.parse(text)
  const record = toRecord(parsed)
  if (!record) return {}

  const store: OpenCodeAuthStore = {}
  for (const [providerID, value] of Object.entries(record)) {
    const entry = toRecord(value)
    if (!entry) continue

    if (entry.type === "oauth") {
      const refresh = asString(entry.refresh)
      const access = asString(entry.access)
      const expires = toNumber(entry.expires)
      if (!refresh || !access || expires == null) continue
      store[providerID] = {
        type: "oauth",
        refresh,
        access,
        expires,
        accountId: asString(entry.accountId),
        enterpriseUrl: asString(entry.enterpriseUrl),
      }
      continue
    }

    if (entry.type === "api") {
      const key = asString(entry.key)
      if (!key) continue
      store[providerID] = { type: "api", key }
      continue
    }

    if (entry.type === "wellknown") {
      const key = asString(entry.key)
      const token = asString(entry.token)
      if (!key || !token) continue
      store[providerID] = { type: "wellknown", key, token }
    }
  }

  return store
}

export const resolveCodexCredential = (
  env: EnvInput = process.env,
  auth: OpenCodeAuthStore = {},
): CodexCredential => {
  const accessToken = asString(env.OPENBAR_CODEX_ACCESS_TOKEN)
  if (accessToken) {
    return {
      accessToken,
      accountId: asString(env.OPENBAR_CODEX_ACCOUNT_ID),
      source: "env",
    }
  }

  const entry = auth.openai
  if (entry?.type === "oauth") {
    return {
      accessToken: entry.access || entry.refresh,
      accountId: entry.accountId,
      source: "opencode",
    }
  }

  return { source: "missing" }
}

export const resolveCopilotCredential = (
  env: EnvInput = process.env,
  auth: OpenCodeAuthStore = {},
): CopilotCredential => {
  const token = asString(env.OPENBAR_COPILOT_TOKEN)
  if (token) {
    return { token, source: "env" }
  }

  const entry = auth["github-copilot"]
  if (entry?.type === "oauth") {
    return {
      token: entry.refresh || entry.access,
      source: "opencode",
    }
  }

  return { source: "missing" }
}

export const resolveZaiCredential = (
  env: EnvInput = process.env,
  auth: OpenCodeAuthStore = {},
): ZaiCredential => {
  const apiKey = asString(env.OPENBAR_ZAI_API_KEY)
  if (apiKey) {
    return { apiKey, source: "env" }
  }

  const entry = auth["zai-coding-plan"] ?? auth.zai ?? auth["z.ai"]
  if (entry?.type === "api") {
    return {
      apiKey: entry.key,
      source: "opencode",
    }
  }

  if (entry?.type === "wellknown") {
    return {
      apiKey: entry.token,
      source: "opencode",
    }
  }

  if (entry?.type === "oauth") {
    return {
      apiKey: entry.access || entry.refresh,
      source: "opencode",
    }
  }

  return { source: "missing" }
}

export const snapshotPercent = (window: WindowUsage): number | undefined => {
  if (window.usedPercent != null) return clamp(window.usedPercent, 0, 100)
  if (window.limit == null || window.limit <= 0 || window.used == null) return
  return clamp((window.used / window.limit) * 100, 0, 100)
}

export const formatRelativeTime = (iso: string | undefined, now = Date.now()) => {
  if (!iso) return "unknown"
  const time = new Date(iso).valueOf()
  if (Number.isNaN(time)) return "unknown"

  const future = time > now
  const delta = Math.abs(now - time)
  const minutes = Math.floor(delta / 60_000)
  const hours = Math.floor(delta / 3_600_000)
  const days = Math.floor(delta / 86_400_000)

  if (minutes < 1) return future ? "soon" : "just now"
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  return future ? `in ${days}d` : `${days}d ago`
}

export const normalizeCodexPayload = (payload: unknown): NormalizedPayload => {
  const record = toRecord(payload)
  const rateLimit = toRecord(record?.rate_limit)
  const windows = [toRecord(rateLimit?.primary_window), toRecord(rateLimit?.secondary_window)]
    .flatMap((window) => {
      if (!window) return []
      const seconds = toNumber(window.limit_window_seconds)
      const usedPercent = toNumber(window.used_percent)
      if (seconds == null || usedPercent == null) return []

      return [
        {
          label: formatWindowLabel(seconds),
          usedPercent: clamp(usedPercent, 0, 100),
          resetsAt: parseReset(window.reset_at),
        } satisfies WindowUsage,
      ]
    })

  const plan = asString(record?.plan_type)
  return {
    windows,
    message: plan ? `Plan: ${title(plan)}` : undefined,
  }
}

export const normalizeCopilotPayload = (payload: unknown): NormalizedPayload => {
  const record = toRecord(payload)
  const quotaSnapshots = toRecord(record?.quota_snapshots)
  const windows: WindowUsage[] = []
  const seen = new Set<string>()

  const pushWindow = (window: WindowUsage | undefined) => {
    if (!window) return
    const key = `${window.label}:${window.limit}:${window.used}`
    if (seen.has(key)) return
    seen.add(key)
    windows.push(window)
  }

  pushWindow(normalizeDirectCopilotSnapshot("premium_interactions", quotaSnapshots?.premium_interactions))
  pushWindow(normalizeDirectCopilotSnapshot("chat", quotaSnapshots?.chat))

  if (!windows.length && quotaSnapshots) {
    for (const [key, value] of Object.entries(quotaSnapshots)) {
      pushWindow(normalizeDirectCopilotSnapshot(key, value))
    }
  }

  if (!windows.length) {
    const monthly = toRecord(record?.monthly_quotas)
    const limited = toRecord(record?.limited_user_quotas)
    pushWindow(normalizeCountSnapshot("completions", monthly, limited))
    pushWindow(normalizeCountSnapshot("chat", monthly, limited))
  }

  const resetsAt = parseReset(record?.quota_reset_date)
  const plan = asString(record?.copilot_plan)

  return {
    windows: windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt ?? resetsAt,
    })),
    message: plan ? `Plan: ${title(plan)}` : undefined,
  }
}

const normalizeZaiWindow = (label: string, value: unknown, unit?: UsageUnit): WindowUsage | undefined => {
  const record = toRecord(value)
  if (!record) return

  const limit = toNumber(record.usage)
  const currentValue = toNumber(record.currentValue)
  const remainingValue = toNumber(record.remaining)
  const rawPercent = toNumber(record.percentage)
  const resetsAt = parseReset(record.nextResetTime)

  if (limit != null && limit > 0) {
    const remaining = remainingValue != null ? clamp(remainingValue, 0, limit) : undefined
    const usedFromRemaining = remaining != null ? limit - remaining : undefined
    const usedRaw = usedFromRemaining != null && currentValue != null
      ? Math.max(usedFromRemaining, currentValue)
      : usedFromRemaining ?? currentValue

    if (usedRaw != null) {
      const used = clamp(usedRaw, 0, limit)
      return {
        label,
        used,
        limit,
        remaining: clamp(limit - used, 0, limit),
        unit,
        resetsAt,
      }
    }
  }

  if (rawPercent == null && limit == null && currentValue == null && remainingValue == null && !resetsAt) {
    return
  }

  return {
    label,
    usedPercent: clamp(Math.max(0, rawPercent ?? 0), 0, 100),
    unit,
    resetsAt,
  }
}

export const normalizeZaiPayload = (payload: unknown): NormalizedPayload => {
  const record = toRecord(payload)
  const code = toNumber(record?.code)

  if (record?.success === false || (code != null && code !== 200)) {
    throw new Error(asString(record?.msg) ?? "z.ai API error")
  }

  const data = toRecord(record?.data)
  if (!data) {
    throw new Error(asString(record?.msg) ?? "z.ai usage response did not contain data.")
  }

  const limits = Array.isArray(data.limits) ? data.limits : []
  let tokenWindow: WindowUsage | undefined
  let timeWindow: WindowUsage | undefined

  for (const value of limits) {
    const limit = toRecord(value)
    const type = asString(limit?.type)
    if (type === "TOKENS_LIMIT" && !tokenWindow) {
      tokenWindow = normalizeZaiWindow("TOKENS", limit, "tokens")
      continue
    }

    if (type === "TIME_LIMIT" && !timeWindow) {
      timeWindow = normalizeZaiWindow("MCP", limit)
    }
  }

  const plan = asString(data.planName) ?? asString(data.plan) ?? asString(data.plan_type) ?? asString(data.packageName)

  return {
    windows: [tokenWindow, timeWindow].filter((window): window is WindowUsage => Boolean(window)),
    message: plan ? `Plan: ${title(plan)}` : undefined,
  }
}
