# OpenBar

CodexBar within opencode.

> "Open" for OpenCode + "Bar" from [CodexBar](https://github.com/steipete/CodexBar), its inspiration.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["oc-plugin-usage"]
}
```

## Providers

- Codex — rolling windows (`5H`, `7D`)
- GitHub Copilot — monthly quota
- z.ai — token and MCP quota

## Environment Variables

Credentials are resolved from OpenCode's auth store first, falling back to:

| Variable | Provider | Required |
|---|---|---|
| `OPENBAR_CODEX_ACCESS_TOKEN` | Codex | yes* |
| `OPENBAR_CODEX_ACCOUNT_ID` | Codex | no |
| `OPENBAR_COPILOT_TOKEN` | Copilot | yes* |
| `OPENBAR_ZAI_API_KEY` | z.ai | yes* |

\* Only if OpenCode doesn't already hold credentials for that provider.

Optional endpoint overrides: `OPENBAR_CODEX_USAGE_URL`, `OPENBAR_COPILOT_USAGE_URL`, `OPENBAR_ZAI_API_HOST`, `OPENBAR_ZAI_QUOTA_URL`.

## License

MIT
