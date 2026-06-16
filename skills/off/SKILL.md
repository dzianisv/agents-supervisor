---
name: off
description: Disable the supervisor for this session. Use for "/supervisor:off", "supervisor off", "turn off supervisor", "disable supervisor", "stop supervising".
---

# /supervisor:off — disable for this session

Disable the supervisor hook for the current session only. The plugin stays installed; other sessions are unaffected.

## Steps

1. Get the current session ID and add it to the disabled list:

   ```bash
   node -e "
   const fs = require('fs'), path = require('path');
   const dir = path.join(process.cwd(), '.supervisor');
   fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
   const sid = fs.existsSync(path.join(dir, 'current_session'))
     ? fs.readFileSync(path.join(dir, 'current_session'), 'utf8').trim()
     : process.env.CLAUDE_SESSION_ID ?? '';
   if (!sid) { console.log('No session ID found — supervisor already idle or not yet run.'); process.exit(0); }
   const flag = path.join(dir, 'disabled');
   const existing = fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : [];
   if (!existing.includes(sid)) fs.writeFileSync(flag, [...existing, sid].join('\n') + '\n', 'utf8');
   console.log('Supervisor disabled for session:', sid);
   "
   ```

2. Confirm to the user: "Supervisor disabled for this session. Run `/supervisor:on` to re-enable."

To disable the whole plugin across all sessions: `claude plugin disable supervisor@agents-supervisor`
