---
name: on
description: Re-enable the supervisor for this session after it was disabled with /supervisor:off. Use for "/supervisor:on", "supervisor on", "turn on supervisor", "enable supervisor", "resume supervising".
---

# /supervisor:on — re-enable for this session

Remove the current session from the disabled list so the supervisor hook fires again on the next stop.

## Steps

1. Remove session ID from the disabled list:

   ```bash
   node -e "
   const fs = require('fs'), path = require('path');
   const dir = path.join(process.cwd(), '.supervisor');
   const flag = path.join(dir, 'disabled');
   const sid = fs.existsSync(path.join(dir, 'current_session'))
     ? fs.readFileSync(path.join(dir, 'current_session'), 'utf8').trim()
     : process.env.CLAUDE_SESSION_ID ?? '';
   if (!sid || !fs.existsSync(flag)) { console.log('Supervisor already active.'); process.exit(0); }
   const updated = fs.readFileSync(flag, 'utf8').split('\n').map(l => l.trim()).filter(l => l && l !== sid);
   fs.writeFileSync(flag, updated.join('\n') + (updated.length ? '\n' : ''), 'utf8');
   console.log('Supervisor re-enabled for session:', sid);
   "
   ```

2. Confirm to the user: "Supervisor re-enabled for this session."

To re-enable the whole plugin after `claude plugin disable`: `claude plugin enable supervisor@agents-supervisor`
