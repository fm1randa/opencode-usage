import { describe, expect, test } from "bun:test"
import {
  buildOpenCodeAuthPath,
  buildCachePath,
  normalizeCodexPayload,
  normalizeCopilotPayload,
  normalizeZaiPayload,
  formatRelativeTime,
  readOpenCodeAuthText,
  readCacheText,
  resolveCodexCredential,
  resolveCopilotCredential,
  resolveProviderFromMessageHistory,
  resolveZaiCredential,
  resolveProviderForSession,
  resolveProviderFromModelString,
  resolveProviderFromMessages,
  resolveSessionRoot,
  resolveZaiUsageURL,
} from "./shared"

describe("resolveProviderFromMessages", () => {
  test("prefers selected model from config before message history", () => {
    const result = resolveProviderFromMessages(
      [{ role: "assistant", providerID: "openai" }],
      "github-copilot/gpt-5.4",
    )

    expect(result).toEqual({ provider: "github-copilot", source: "selected_model" })
  })

  test("prefers the latest user-selected model", () => {
    const result = resolveProviderFromMessages([
      { role: "assistant", providerID: "openai" },
      { role: "user", model: { providerID: "github-copilot", modelID: "gpt-4.1" } },
    ])

    expect(result).toEqual({ provider: "github-copilot", source: "selected_model" })
  })

  test("falls back to assistant provider when selected model is not set", () => {
    const result = resolveProviderFromMessages([{ role: "assistant", providerID: "github-copilot" }])
    expect(result).toEqual({ provider: "github-copilot", source: "session_assistant" })
  })
})

describe("resolveProviderForSession", () => {
  test("prefers selected model over persisted session provider", () => {
    const result = resolveProviderForSession(
      "session-1",
      [{ role: "assistant", providerID: "openai" }],
      "zai/glm-5.1",
      { "session-1": "github-copilot" },
    )

    expect(result).toEqual({ provider: "zai", source: "selected_model" })
  })

  test("falls back to persisted session provider when selected model is missing", () => {
    const result = resolveProviderForSession(
      "session-1",
      [{ role: "assistant", providerID: "openai" }],
      undefined,
      { "session-1": "github-copilot" },
    )

    expect(result).toEqual({ provider: "github-copilot", source: "selected_model" })
  })

  test("falls back to model and messages when session provider is missing", () => {
    const result = resolveProviderForSession(
      "session-2",
      [{ role: "assistant", providerID: "openai" }],
      "github-copilot/gpt-5.4",
      {},
    )

    expect(result).toEqual({ provider: "github-copilot", source: "selected_model" })
  })
})

describe("resolveProviderFromMessageHistory", () => {
  test("prefers latest user-selected model before assistant provider", () => {
    const result = resolveProviderFromMessageHistory([
      { role: "assistant", providerID: "github-copilot" },
      { role: "user", model: { providerID: "z.ai", modelID: "glm-5.1" } },
    ])

    expect(result).toEqual({ provider: "zai", source: "selected_model" })
  })
})

describe("resolveProviderFromModelString", () => {
  test("extracts provider from provider/model config", () => {
    expect(resolveProviderFromModelString("github-copilot/gpt-5.4")).toBe("github-copilot")
    expect(resolveProviderFromModelString("openai/gpt-5.3-codex")).toBe("openai")
    expect(resolveProviderFromModelString("zai/glm-4.5")).toBe("zai")
    expect(resolveProviderFromModelString("z.ai/glm-4.5")).toBe("zai")
    expect(resolveProviderFromModelString("zai-coding-plan/glm-5-turbo")).toBe("zai")
  })

  test("returns undefined for unknown or malformed values", () => {
    expect(resolveProviderFromModelString(undefined)).toBeUndefined()
    expect(resolveProviderFromModelString("")).toBeUndefined()
    expect(resolveProviderFromModelString("not-a-provider/model")).toBeUndefined()
  })
})

describe("resolveSessionRoot", () => {
  test("uses assistant path root when available", () => {
    expect(
      resolveSessionRoot(
        [
          { role: "assistant", path: { root: "/tmp/project-a" } },
          { role: "user", model: { providerID: "github-copilot" } },
        ],
        "/tmp/project-b",
      ),
    ).toBe("/tmp/project-a")
  })

  test("falls back to the host directory before any assistant message exists", () => {
    const root = resolveSessionRoot(
      [{ role: "user", model: { providerID: "github-copilot" } }],
      "/tmp/project-b",
    )

    expect(root).toBe("/tmp/project-b")
    expect(buildCachePath(root)).toBe(buildCachePath("/tmp/project-b"))
  })
})

describe("normalizeCodexPayload", () => {
  test("keeps rolling window percentages", () => {
    const result = normalizeCodexPayload({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 24,
          reset_at: 1_763_000_000,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 61,
          reset_at: 1_763_500_000,
          limit_window_seconds: 604_800,
        },
      },
    })

    expect(result.message).toBe("Plan: Pro")
    expect(result.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["5H", 24],
      ["7D", 61],
    ])
  })
})

describe("normalizeCopilotPayload", () => {
  test("normalizes direct quota snapshots", () => {
    const result = normalizeCopilotPayload({
      copilot_plan: "individual",
      quota_reset_date: "2026-04-30T00:00:00.000Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 1000,
          remaining: 680,
          percent_remaining: 68,
          quota_id: "premium_interactions",
        },
      },
    })

    expect(result.message).toBe("Plan: Individual")
    expect(result.windows).toEqual([
      {
        label: "PREMIUM",
        limit: 1000,
        remaining: 680,
        resetsAt: "2026-04-30T00:00:00.000Z",
        unit: "interactions",
        used: 320,
      },
    ])
  })

  test("falls back to monthly quota counts", () => {
    const result = normalizeCopilotPayload({
      monthly_quotas: {
        completions: 1000,
      },
      limited_user_quotas: {
        completions: 200,
      },
    })

    expect(result.windows).toEqual([
      {
        label: "PREMIUM",
        limit: 1000,
        remaining: 200,
        unit: "interactions",
        used: 800,
      },
    ])
  })
})

describe("normalizeZaiPayload", () => {
  test("normalizes tokens and MCP rows", () => {
    const result = normalizeZaiPayload({
      code: 200,
      msg: "Operation successful",
      success: true,
      data: {
        planName: "Pro",
        limits: [
          {
            type: "TIME_LIMIT",
            usage: 100,
            currentValue: 0,
            remaining: 100,
            percentage: 0,
          },
          {
            type: "TOKENS_LIMIT",
            usage: 40000000,
            currentValue: 13628365,
            remaining: 26371635,
            percentage: 34,
            nextResetTime: 1768507567547,
          },
        ],
      },
    })

    expect(result.message).toBe("Plan: Pro")
    expect(result.windows).toEqual([
      {
        label: "TOKENS",
        limit: 40000000,
        remaining: 26371635,
        resetsAt: "2026-01-15T20:06:07.547Z",
        unit: "tokens",
        used: 13628365,
      },
      {
        label: "MCP",
        limit: 100,
        remaining: 100,
        resetsAt: undefined,
        unit: undefined,
        used: 0,
      },
    ])
  })

  test("keeps percent rows when z.ai omits counts", () => {
    const result = normalizeZaiPayload({
      code: 200,
      msg: "Operation successful",
      success: true,
      data: {
        limits: [
          {
            type: "TOKENS_LIMIT",
            percentage: 1,
            nextResetTime: 1770724088678,
          },
        ],
      },
    })

    expect(result.windows).toEqual([
      {
        label: "TOKENS",
        resetsAt: "2026-02-10T11:48:08.678Z",
        unit: "tokens",
        usedPercent: 1,
      },
    ])
  })

  test("throws on non-success payloads", () => {
    expect(() =>
      normalizeZaiPayload({
        code: 1001,
        msg: "Authorization Token Missing",
        success: false,
      })).toThrow("Authorization Token Missing")
  })

  test("throws when success payload has no data object", () => {
    expect(() =>
      normalizeZaiPayload({
        code: 200,
        msg: "Operation successful",
        success: true,
      })).toThrow("Operation successful")
  })
})

describe("formatRelativeTime", () => {
  test("formats past timestamps", () => {
    const now = Date.parse("2026-04-01T00:00:00.000Z")
    expect(formatRelativeTime("2026-03-31T23:00:00.000Z", now)).toBe("1h ago")
  })

  test("formats future timestamps for reset labels", () => {
    const now = Date.parse("2026-04-01T00:00:00.000Z")
    expect(formatRelativeTime("2026-04-01T00:00:30.000Z", now)).toBe("soon")
    expect(formatRelativeTime("2026-04-01T01:00:00.000Z", now)).toBe("in 1h")
    expect(formatRelativeTime("2026-05-01T00:00:00.000Z", now)).toBe("in 30d")
  })
})

describe("OpenCode auth integration", () => {
  test("parses oauth entries from auth.json", () => {
    const auth = readOpenCodeAuthText(`{
      "openai": {
        "type": "oauth",
        "refresh": "rt_123",
        "access": "acc_123",
        "expires": 123,
        "accountId": "acct_1"
      },
      "github-copilot": {
        "type": "oauth",
        "refresh": "gho_refresh",
        "access": "gho_access",
        "expires": 0
      }
    }`)

    expect(auth).toEqual({
      openai: {
        type: "oauth",
        refresh: "rt_123",
        access: "acc_123",
        expires: 123,
        accountId: "acct_1",
        enterpriseUrl: undefined,
      },
      "github-copilot": {
        type: "oauth",
        refresh: "gho_refresh",
        access: "gho_access",
        expires: 0,
        accountId: undefined,
        enterpriseUrl: undefined,
      },
    })
  })

  test("prefers OPENBAR codex env vars over OpenCode auth", () => {
    const result = resolveCodexCredential(
      {
        OPENBAR_CODEX_ACCESS_TOKEN: "env-token",
        OPENBAR_CODEX_ACCOUNT_ID: "env-account",
      },
      {
        openai: {
          type: "oauth",
          refresh: "refresh-token",
          access: "auth-token",
          expires: 0,
          accountId: "auth-account",
        },
      },
    )

    expect(result).toEqual({
      accessToken: "env-token",
      accountId: "env-account",
      source: "env",
    })
  })

  test("falls back to OpenCode auth for codex", () => {
    const result = resolveCodexCredential(
      {},
      {
        openai: {
          type: "oauth",
          refresh: "refresh-token",
          access: "auth-token",
          expires: 0,
          accountId: "auth-account",
        },
      },
    )

    expect(result).toEqual({
      accessToken: "auth-token",
      accountId: "auth-account",
      source: "opencode",
    })
  })

  test("prefers OPENBAR copilot env var over OpenCode auth", () => {
    const result = resolveCopilotCredential(
      {
        OPENBAR_COPILOT_TOKEN: "env-token",
      },
      {
        "github-copilot": {
          type: "oauth",
          refresh: "refresh-token",
          access: "auth-token",
          expires: 0,
        },
      },
    )

    expect(result).toEqual({
      token: "env-token",
      source: "env",
    })
  })

  test("falls back to OpenCode auth for copilot", () => {
    const result = resolveCopilotCredential(
      {},
      {
        "github-copilot": {
          type: "oauth",
          refresh: "refresh-token",
          access: "auth-token",
          expires: 0,
        },
      },
    )

    expect(result).toEqual({
      token: "refresh-token",
      source: "opencode",
    })
  })

  test("prefers OPENBAR z.ai env var over OpenCode auth", () => {
    const result = resolveZaiCredential(
      {
        OPENBAR_ZAI_API_KEY: "env-token",
      },
      {
        zai: {
          type: "api",
          key: "auth-token",
        },
      },
    )

    expect(result).toEqual({
      apiKey: "env-token",
      source: "env",
    })
  })

  test("falls back to OpenCode auth for z.ai", () => {
    const result = resolveZaiCredential(
      {},
      {
        "z.ai": {
          type: "api",
          key: "auth-token",
        },
      },
    )

    expect(result).toEqual({
      apiKey: "auth-token",
      source: "opencode",
    })
  })

  test("falls back to OpenCode auth for zai-coding-plan", () => {
    const result = resolveZaiCredential(
      {},
      {
        "zai-coding-plan": {
          type: "api",
          key: "auth-token",
        },
      },
    )

    expect(result).toEqual({
      apiKey: "auth-token",
      source: "opencode",
    })
  })

  test("resolves z.ai endpoint overrides", () => {
    expect(resolveZaiUsageURL({})).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
    expect(resolveZaiUsageURL({ OPENBAR_ZAI_API_HOST: "open.bigmodel.cn" })).toBe(
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    )
    expect(resolveZaiUsageURL({ OPENBAR_ZAI_QUOTA_URL: "https://open.bigmodel.cn/api/coding/paas/v4" })).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4",
    )
  })

  test("builds the same default OpenCode auth path shape", () => {
    expect(buildOpenCodeAuthPath("/Users/filipe", {})).toBe("/Users/filipe/.local/share/opencode/auth.json")
    expect(buildOpenCodeAuthPath("/Users/filipe", { XDG_DATA_HOME: "/tmp/data-home" })).toBe(
      "/tmp/data-home/opencode/auth.json",
    )
  })

  test("parses persisted session provider cache entries", () => {
    const cache = readCacheText(`{
      "version": 1,
      "updatedAt": "2026-04-01T00:00:00.000Z",
      "providers": {
        "zai": {
          "provider": "zai",
          "source": "live",
          "status": "ok",
          "fetchedAt": "2026-04-01T00:00:00.000Z",
          "windows": []
        }
      },
      "sessionProviders": {
        "z1": "z.ai",
        "abc": "github-copilot",
        "bad": "unknown-provider"
      }
    }`)

    expect(cache.providers.zai?.provider).toBe("zai")
    expect(cache.sessionProviders).toEqual({ z1: "zai", abc: "github-copilot" })
  })
})
