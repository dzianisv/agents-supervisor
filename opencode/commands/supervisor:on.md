---
description: Re-enable the supervisor for this session.
---
Re-enable the supervisor. The supervisor is on by default but can be disabled with
`/supervisor off`. This command re-enables it for the current session only.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Call the `supervisor` tool with `action: "on"`.

Relay the tool response.
