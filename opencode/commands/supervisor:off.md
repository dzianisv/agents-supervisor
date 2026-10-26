---
description: Disable the supervisor for this session.
---
Disable the supervisor temporarily for this session. The supervisor will not
evaluate steps or interrupt until re-enabled with `/supervisor on`.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Call the `supervisor` tool with `action: "off"`.

Relay the tool response.
