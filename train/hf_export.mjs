#!/usr/bin/env node
/**
 * hf_export.mjs — second-pass redaction + HuggingFace-format export of the
 * shipped gold set (evals/gold-cc-oc.example.jsonl).
 *
 * The shipped gold is already redacted for credentials/tokens/emails/paths,
 * but still contains project names and the user handle. This script applies
 * a second pass:
 *   - project names (OpenClawBot, vibebrowser, paperclip, ...) → <proj-a..z>
 *   - user handle dzianisv → <user>
 *   - any remaining /home/<name>/ or /Users/<name>/ → /home/<user>/
 *   - any github.com/dzianisv/<repo> → github.com/<user>/<proj-X>
 *
 * Output: <outdir>/train.jsonl + dataset card stub + redaction log.
 *
 * Usage:
 *   node train/hf_export.mjs --in evals/gold-cc-oc.example.jsonl \
 *     --out /tmp/hf-export/gold-v3
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Salt for project_slug hashing — random per-export so even brute-force
// can't reverse the slug→name mapping across snapshots.
const SLUG_SALT = process.env.HF_EXPORT_SLUG_SALT ?? Math.random().toString(36).slice(2);
function opaqueProject(slug) {
  if (!slug) return '<proj-unknown>';
  const h = createHash('sha256').update(slug + SLUG_SALT).digest('hex').slice(0, 8);
  return `proj-${h}`;
}

const args = parseArgs(process.argv.slice(2));
const IN  = args.in  ?? 'evals/gold-cc-oc.example.jsonl';
const OUT = args.out ?? '/tmp/hf-export/gold-v3';
mkdirSync(OUT, { recursive: true });

// Project name → opaque label.
// Keep the casing variants together so case-insensitive grep can catch them.
// Longest variants FIRST (regex alternation prefers leftmost not longest;
// we control order). Compound identifiers (OpenClawBoxBot, dzianisvs-projects)
// are caught by listing them ahead of stems.
const PROJECT_MAP = [
  ['OpenClawBoxBot|OpenClawBox|OpenClawBot|openclaw|claw(hub)?',    '<proj-a>'],
  ['vibebrowser|VibeBrowser|webagent',                    '<proj-b>'],
  ['vibe',                                                '<proj-b-app>'],
  ['paperclip',                                           '<proj-c>'],
  ['Hermes|hermes',                                       '<proj-d>'],
  ['Lamoom|lamoom',                                       '<proj-e>'],
  ['opencode-plugins|agents-supervisor|reflection-3',     '<proj-f>'],
  ['chrome-devtools-mcp',                                 '<proj-g>'],
  ['elasticchat',                                         '<proj-h>'],
  ['meeper',                                              '<proj-i>'],
  ['codebox|codex-bridge-openclaw-prototype',             '<proj-j>'],
  ['backtest|AgenticHedgeFund',                           '<proj-k>'],
  ['sentry-dashboard',                                    '<proj-l>'],
  ['termux-app',                                          '<proj-m>'],
  ['rfs',                                                 '<proj-n>'],
  ['skills\\.sh|skillssh',                                '<proj-p>'],
];

// Longest first — possessive `dzianisvs` and compound `whoisdzianisvm`
// must catch before stem `dzianisv` (or substring redact eats them anyway,
// but listing keeps audit clear).
// NOTE: `engineer` removed — it's a generic English word and substring match
// ate "engineers"/"engineering"/"users". Remaining /Users/engineer/ paths
// are caught by the /home/<user> normalisation below; the bot account
// `OpenCodeEngineer` is caught by the PII_NETS regex above.
const USER_HANDLES = ['OpenCodeEngineer', 'whoisdzianisvm', 'dzianisvs', 'dzianisv', 'azureuser'];

// User-owned or user-referenced domains/services. Generic vendor names
// (Anthropic, GitHub, Stripe) we keep — they're not identifying.
const DOMAIN_MAP = [
  ['clawhub\\.ai',          '<domain-a>'],
  ['beadaholique\\.com',    '<customer-x>'],
  ['claude\\.ai',           'claude.ai'], // keep — public reference
  ['claude\\.com',          'claude.com'], // keep
];

// Any IPv4 address (public + private) — even private ones leak tailnet topology.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Localhost-ish meta-IP allowlist (keep so prompts about 127.0.0.1 stay readable)
const IPV4_KEEP = new Set(['127.0.0.1', '0.0.0.0', '169.254.169.254']);

// Pass-1 nets: things the audit-time redaction was supposed to catch but
// missed under specific casing/compound conditions. Catch-all here so the
// HF export never publishes secrets even if the original audit was leaky.
const PII_NETS = [
  // Any-domain email — replace with shape-only marker
  [/\b[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '<email>'],
  // Neon Postgres / Supabase / Render / RDS password-in-URL credentials
  [/\b[a-zA-Z0-9_-]+:[a-zA-Z0-9_!@#$%^&*().+/=-]+@[a-zA-Z0-9.-]+\.(neon\.tech|supabase\.co|render\.com|aws\.com)\b/g, '<db-credential>'],
  // Bearer / x-api-key tokens of any length ≥15
  [/Bearer\s+[A-Za-z0-9_.+/=-]{15,}/gi, 'Bearer <REDACTED>'],
  [/x-api-key:\s*[A-Za-z0-9_-]{15,}/gi, 'x-api-key: <REDACTED>'],
  // Anthropic / GitHub / OpenAI / AWS access keys
  [/sk-ant-[A-Za-z0-9_-]{15,}/g, '<anthropic-key>'],
  [/sk-proj-[A-Za-z0-9_-]{15,}/g, '<openai-key>'],
  [/ghp_[A-Za-z0-9]{20,}/g, '<github-pat>'],
  [/gho_[A-Za-z0-9]{20,}/g, '<github-oauth>'],
  [/AKIA[A-Z0-9]{15,}/g, '<aws-access-key>'],
  // Generic "npg_" / "hf_" / "rk_" style secrets
  [/\bnpg_[A-Za-z0-9]{8,}/g, '<neon-password>'],
  [/\bhf_[A-Za-z0-9]{8,}/g, '<hf-token>'],
  [/\b(?:rk|sk|pk)_(?:test|live)_[A-Za-z0-9]{15,}/g, '<stripe-key>'],
  // Casing variants of "engineer" inside path-like contexts. No \b — must
  // catch /Users/Engineer/ even though there is no word break in compounds
  // like "OpenCodeEngineer/" (which is handled separately via USER_HANDLES
  // matched longest-first earlier).
  [/[Ee]ngineer\//g, '<user>/'],
];

function secondPassRedact(s) {
  if (!s) return s;
  let out = s;
  // PII nets run FIRST so password-in-URL gets redacted before
  // project-name substitution touches the domain.
  for (const [pattern, replacement] of PII_NETS) {
    out = out.replace(pattern, replacement);
  }
  // Substring redact (no \b) — needed because identifiers like
  // `paperclip_agent_id`, `OpenClawBoxBot`, `dzianisvs-projects` slip past
  // word boundaries since `_`/`-` are word-adjacent. Match longest variants
  // first so e.g. `OpenClawBoxBot` resolves before stem `claw`.
  for (const [pattern, replacement] of PROJECT_MAP) {
    out = out.replace(new RegExp(`(${pattern})`, 'gi'), replacement);
  }
  for (const u of USER_HANDLES) {
    out = out.replace(new RegExp(u, 'gi'), '<user>');
  }
  for (const [pattern, replacement] of DOMAIN_MAP) {
    out = out.replace(new RegExp(pattern, 'gi'), replacement);
  }
  // IPv4 — replace all except a small allowlist
  out = out.replace(IPV4_RE, (m) => (IPV4_KEEP.has(m) ? m : '<ip>'));
  // generic path normalisation
  out = out.replace(/\/(home|Users)\/[a-zA-Z0-9_-]+/g, '/home/<user>');
  // github.com/<owner>/<repo> with already-redacted owner stays as is
  return out;
}

function redactRecord(rec) {
  const r = { ...rec };
  // Wrapped schema (gold-format with {name, expected, ctx: {...}})
  if (r.ctx) {
    r.ctx = {
      ...r.ctx,
      user_messages: (r.ctx.user_messages ?? []).map(secondPassRedact),
      final_assistant_text: secondPassRedact(r.ctx.final_assistant_text ?? ''),
      tools_available_inferred: r.ctx.tools_available_inferred ?? [],
    };
  }
  // Flat schema (classified-vN format with top-level user_messages, project_slug, etc.)
  if (r.user_messages !== undefined) {
    r.user_messages = (r.user_messages ?? []).map(secondPassRedact);
  }
  if (r.final_assistant_text !== undefined) {
    r.final_assistant_text = secondPassRedact(r.final_assistant_text ?? '');
  }
  if (r.classification?.reason) {
    r.classification = { ...r.classification, reason: secondPassRedact(r.classification.reason) };
  }
  // project_slug is the user's local path baked into Claude Code's project dir:
  //   "-home-azureuser--paperclip-instances-default-..." or
  //   "-Users-engineer-workspace-..."  → leak. Replace with opaque tag.
  // project_slug = the user's local path baked into the CC/OC project dir.
  // Hash it to a stable opaque label so cross-record analysis ("which project
  // did this stop come from") survives but the path itself doesn't.
  if (r.project_slug !== undefined) {
    r.project_slug = opaqueProject(r.project_slug);
  }
  // session_id is a UUID — safe to keep. timestamps are absolute date-times,
  // not identifying on their own.
  return r;
}

const inLines  = readFileSync(IN, 'utf8').split('\n').filter(Boolean);
const records  = inLines.map((l) => JSON.parse(l));
const exported = records.map(redactRecord);

writeFileSync(`${OUT}/train.jsonl`, exported.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Distribution + redaction summary.
// Wrapped records use `expected`; flat records use `classification.category`.
const dist = {};
for (const r of exported) {
  const cat = r.expected ?? r.classification?.category ?? '(unlabeled)';
  dist[cat] = (dist[cat] ?? 0) + 1;
}

const allBlob = JSON.stringify(exported);
const leakCheck = {
  project_names_remaining: Array.from(new Set(allBlob.match(
    /\b(OpenClawBot|openclaw|vibebrowser|paperclip|Hermes|lamoom|opencode-plugins|agents-supervisor)\b/gi,
  ) ?? [])),
  user_handle_remaining:   Array.from(new Set(allBlob.match(/\bdzianisv\b/g) ?? [])),
  raw_homedir_remaining:   Array.from(new Set(allBlob.match(/\/home\/[a-zA-Z0-9_-]+/g) ?? [])),
};

writeFileSync(`${OUT}/redaction-log.json`, JSON.stringify({
  in: IN,
  records: exported.length,
  distribution: dist,
  project_map: PROJECT_MAP.map(([p, r]) => ({ matched: p, replaced_with: r })),
  user_handles_stripped: USER_HANDLES,
  post_pass_leak_check: leakCheck,
}, null, 2));

console.log(`exported ${exported.length} records to ${OUT}/train.jsonl`);
console.log('distribution:', dist);
console.log('post-pass leak check:', leakCheck);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
