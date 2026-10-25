import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"

function freePort(){return new Promise(r=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>r(port))})})}
const load = Number(process.argv[2]||0)
const workers = []
for (let i=0;i<load;i++) workers.push(spawn(process.execPath,["-e","const t=Date.now();while(Date.now()-t<60000){Math.sqrt(Math.random())}"],{stdio:"ignore"}))

const tmp = mkdtempSync(join(tmpdir(),"probe-proj-"))
const home = mkdtempSync(join(tmpdir(),"probe-home-"))
writeFileSync(join(tmp,"opencode.json"), JSON.stringify({$schema:"https://opencode.ai/config.json"}))
const port = await freePort()
const env = {...process.env, HOME: home}
for (const k of ["GITHUB_TOKEN","GH_TOKEN","OPENAI_API_KEY","ANTHROPIC_API_KEY","OPENCODE_SERVER_PASSWORD","OPENCODE_SERVER_USERNAME","OPENCODE_URL","OPENCODE_CLIENT"]) delete env[k]
const t0 = Date.now()
const p = spawn("opencode",["serve","--port",String(port),"--hostname","127.0.0.1"],{cwd:tmp,stdio:["ignore","pipe","pipe"],detached:true,env})
let err=""
p.stderr.on("data",c=>{err+=c})
let ok=false
while (Date.now()-t0 < 120000) {
  try { const r = await fetch(`http://127.0.0.1:${port}/global/health`); if (r.ok){ok=true;break} } catch {}
  await new Promise(r=>setTimeout(r,200))
}
console.log(JSON.stringify({load, healthy: ok, ms: Date.now()-t0, stderr: err.slice(0,400)}))
try{process.kill(-p.pid,"SIGKILL")}catch{}
for (const w of workers) try{w.kill("SIGKILL")}catch{}
rmSync(tmp,{recursive:true,force:true}); rmSync(home,{recursive:true,force:true})
process.exit(0)
