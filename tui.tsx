// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { readFile } from "node:fs/promises"
import type { TuiPlugin, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { Show } from "solid-js"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  OPENBAR_ID,
  buildCachePath,
  emptyCache,
  formatRelativeTime,
  providerLabel,
  readCacheText,
  resolveProviderForSession,
  resolveSessionRoot,
  snapshotPercent,
} from "./shared"

const id = OPENBAR_ID
const POLL_MS = 30_000

type Api = Parameters<TuiPlugin>[0]

const bool = (value: unknown, fallback: boolean) => {
  if (typeof value !== "boolean") return fallback
  return value
}

const rec = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}

const cfg = (value: Record<string, unknown> | undefined) => ({
  enabled: bool(value?.enabled, true),
  sidebar: bool(value?.sidebar, true),
})

const fmt = (value: number | undefined) => {
  if (value == null) return "-"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${Math.round(value)}`
}

const bar = (ratio: number, width: number) => {
  const clamped = Math.max(0, Math.min(1, ratio))
  const size = Math.max(4, width)
  const filled = Math.round(clamped * size)
  return "#".repeat(filled) + ".".repeat(size - filled)
}

const fillWidth = (width: number, prefix: string, suffix: string) => {
  return Math.max(4, width - prefix.length - suffix.length - 4)
}

const statusColor = (theme, status) => {
  if (status === "ok") return theme.success
  if (status === "stale") return theme.warning
  if (status === "missing_auth") return theme.warning
  if (status === "error") return theme.error
  return theme.textMuted
}

const barColor = (theme, percent) => {
  if (percent >= 90) return theme.error
  if (percent >= 70) return theme.warning
  return theme.primary
}

const rowText = (window) => {
  if (window.used != null && window.limit != null) {
    const unit = window.unit ? ` ${window.unit}` : ""
    return `${fmt(window.used)} / ${fmt(window.limit)}${unit}`
  }

  if (window.usedPercent != null) {
    return `${Math.round(window.usedPercent)}% used`
  }

  return "No quota details"
}

const statusText = (usage) => {
  if (!usage) return "No quota snapshot yet"
  if (usage.status === "ok") return `Updated ${formatRelativeTime(usage.fetchedAt)}`
  if (usage.status === "stale") return `Stale ${formatRelativeTime(usage.fetchedAt)}`
  if (usage.status === "missing_auth") return "Auth missing"
  if (usage.status === "error") return "Unavailable"
  return usage.provider ? "Loading quota" : "Waiting for provider"
}

const readCache = async (filePath) => {
  try {
    return readCacheText(await readFile(filePath, "utf8"))
  } catch {
    return emptyCache()
  }
}

const UsageCard = (props: { api: Api; theme: any; sessionId: string }) => {
  const [usage, setUsage] = createSignal()
  const [provider, setProvider] = createSignal<string>()
  const [barWidth, setBarWidth] = createSignal(18)

  const load = async () => {
    const messages = props.api.state.session.messages(props.sessionId)
    const root = resolveSessionRoot(messages, props.api.state.path.directory)
    const cache = await readCache(buildCachePath(root))
    const resolved = resolveProviderForSession(
      props.sessionId,
      messages,
      props.api.state.config.model,
      cache.sessionProviders,
    )

    setProvider(resolved.provider)

    if (!resolved.provider) {
      setUsage({
        provider: "openai",
        source: "cache",
        status: "unavailable",
        fetchedAt: new Date(0).toISOString(),
        windows: [],
        message: "No provider could be resolved from this session yet.",
      })
      return
    }

    setUsage(
      cache.providers?.[resolved.provider] || {
        provider: resolved.provider,
        source: "cache",
        status: "unavailable",
        fetchedAt: new Date(0).toISOString(),
        windows: [],
        message: "Waiting for the first quota snapshot.",
      },
    )
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    props.api.state.session.messages(props.sessionId)
    props.api.state.config.model
    void load()
  })

  const title = createMemo(() => providerLabel(provider()))

  return (
    <box
      onSizeChange={function () {
        const next = Math.max(12, this.width - 2)
        setBarWidth((prev) => (prev === next ? prev : next))
      }}
      width="100%"
      flexDirection="column"
      paddingTop={1}
    >
      <text fg={props.theme.primary}>
        <b>{title()}</b>
      </text>
      <text fg={statusColor(props.theme, usage()?.status)}>{statusText(usage())}</text>
      <Show when={usage()?.message}>
        <text fg={props.theme.textMuted}>{usage()?.message}</text>
      </Show>
      <Show when={usage()?.windows?.length}>
        <box flexDirection="column" paddingTop={1}>
          {usage()?.windows.map((window) => {
            const percent = snapshotPercent(window)
            const percentText = percent == null ? "" : ` ${Math.round(percent)}%`
            return (
              <box flexDirection="column">
                <text>
                  <span style={{ fg: props.theme.textMuted }}>{window.label.padEnd(8, " ")}</span>
                  <span style={{ fg: props.theme.text }}>{rowText(window)}</span>
                </text>
                <Show when={percent != null}>
                  <text>
                    <span style={{ fg: barColor(props.theme, percent) }}>
                      [{bar(percent / 100, fillWidth(barWidth(), window.label, percentText))}]
                    </span>
                    <span style={{ fg: props.theme.text }}>{percentText}</span>
                  </text>
                </Show>
                <Show when={window.resetsAt}>
                  <text fg={props.theme.textMuted}>Resets {formatRelativeTime(window.resetsAt)}</text>
                </Show>
              </box>
            )
          })}
        </box>
      </Show>
    </box>
  )
}

const slots = (api: Api, value: () => { sidebar: boolean }): TuiSlotPlugin[] => {
  return [
    {
      order: 50,
      slots: {
        sidebar_content(ctx, input) {
          return (
            <Show when={value().sidebar}>
              <UsageCard api={api} theme={ctx.theme.current} sessionId={input.session_id} />
            </Show>
          )
        },
      },
    },
  ]
}

const tui: TuiPlugin = async (api, options) => {
  const value = cfg(rec(options))
  if (!value.enabled) return

  for (const slot of slots(api, () => value)) {
    api.slots.register(slot)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
