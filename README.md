# Monarch for Claude

This is a local, single-user Windows connector for Claude Desktop. It exposes the exact tool inventory described in `src/tools/contracts.ts`: read-only account/transaction/category/tag/rule tools plus an audited, preview-and-confirm path for safe classification rules.

## Install

Download the `.mcpb` file from the [latest GitHub release](https://github.com/timbarrow/monarch-for-claude/releases/latest), verify it against the accompanying `.sha256` file, and install it using Claude Desktop's Extensions UI.

## Build

```powershell
npm ci
npm run ci
```

The resulting bundle and SHA-256 file are in `dist/`. No Node installation should be needed at runtime because Claude Desktop supplies Node.

## Connect and reauthenticate

Call `connect_monarch` in Claude. It opens a dedicated browser profile; sign in directly with Monarch. No password, token, cookie, or OTP is accepted by an MCP tool. `get_monarch_connection_status` reports safe diagnostic codes only. Expired sessions are removed and require reconnecting.

## Uninstall

Remove the extension in Claude Desktop. If desired, separately delete `%LOCALAPPDATA%\MonarchForClaude\auth.bin` and `%LOCALAPPDATA%\MonarchForClaude\logs` to remove encrypted local session data and diagnostics.

## Live testing

Live tests are intentionally absent from the default commands. Before use with a real account, validate the browser capture with the owner present and use an impossible, generated merchant criterion for rule write acceptance tests. Never commit real data or credentials.

This is an independent community project and is not affiliated with or endorsed by Monarch Money or Anthropic.
