#!/usr/bin/env node
'use strict';

/**
 * model-gate.js — the deliberation engine for the model-director skill.
 *
 * Dependency-free (Node stdlib only). Two subcommands:
 *   decide  < task.json    -> decision JSON on stdout (diagnostics on stderr)
 *   record  < result.json  -> atomically updates the local ledger + appends a
 *                             deliberation/usage record
 *
 * Quota is an ESTIMATE. No CLI reliably returns remaining subscription
 * allowance today, so we combine (a) rate-limit/quota OBSERVATIONS when a call
 * surfaces one, and (b) a local rolling-window ledger vs configurable soft
 * budgets, with a conservative safety reserve. Never inspect auth files.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LIB_DIR = __dirname;                         // scripts/lib
const SCRIPTS_DIR = path.dirname(LIB_DIR);         // scripts
const PROFILES_PATH = path.join(SCRIPTS_DIR, 'model-profiles.json');
const HOME_DIR =
  process.env.MODEL_DIRECTOR_HOME || path.join(os.homedir(), '.model-director');
const LEDGER_PATH = path.join(HOME_DIR, 'ledger.json');
const RECORD_LOG = path.join(HOME_DIR, 'deliberations.jsonl');

const COMPLEXITY_ORDER = { low: 0, medium: 1, high: 2, frontier: 3 };

// ---------- IO helpers ----------
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function atomicWriteJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function appendJSONL(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
function fail(msg, code) {
  process.stderr.write(`model-gate: ${msg}\n`);
  process.exit(code || 1);
}

// ---------- config + ledger ----------
function loadProfiles() {
  const p = readJSON(PROFILES_PATH, null);
  if (!p || !p.models) fail(`cannot read ${PROFILES_PATH}`, 2);
  return p;
}
function loadLedger(profiles) {
  const l = readJSON(LEDGER_PATH, null);
  if (l && l.version) return l;
  return {
    version: 1,
    subscriptions: profiles.subscriptions || {},
    events: [],
    observations: [],
  };
}

// ---------- complexity ----------
function scoreComplexity(sig = {}) {
  let s = 0;
  if (sig.novel) s += 2;
  if (sig.architecture || sig.irreversible) s += 2;
  if (sig.ambiguous) s += 1;
  if ((sig.files || 0) > 5) s += 1;
  if ((sig.context_tokens || 0) > 50000) s += 1;
  if (sig.multi_system_debug) s += 1;
  if (sig.mechanical) s -= 1;
  let level = 'low';
  if (s >= 5) level = 'frontier';
  else if (s >= 3) level = 'high';
  else if (s >= 1) level = 'medium';
  return { score: s, level };
}

// ---------- quota estimation ----------
function windowFor(ledger, provider) {
  const sub = ledger.subscriptions && ledger.subscriptions[provider];
  if (!sub || !Array.isArray(sub.windows) || !sub.windows.length) return null;
  return sub.windows[0]; // single rolling window per provider for now
}

function estimateQuota(ledger, model, profiles) {
  const prof = profiles.models[model];
  if (!prof) return { model, remaining_ratio: 0, confidence: 'low', available: false, source: 'unknown-model' };
  const provider = prof.provider;
  const win = windowFor(ledger, provider);
  if (!win) return { model, remaining_ratio: 1, confidence: 'low', available: true, source: 'no-window' };

  const cutoff = Date.now() - win.duration_sec * 1000;

  // 1) Prefer a fresh observation (a call surfaced a real remaining/reset value).
  const obs = (ledger.observations || [])
    .filter((o) => o.model === model && Date.parse(o.at) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (obs) {
    const rr = Math.max(0, Math.min(1, Number(obs.remaining_ratio)));
    return {
      model,
      remaining_ratio: rr,
      confidence: 'high',
      available: !obs.rate_limited && rr > 0,
      source: obs.source || 'observation',
    };
  }

  // 2) Else estimate from local events vs soft budget.
  const budget = win.soft_budget && win.soft_budget[model];
  if (!budget) return { model, remaining_ratio: 1, confidence: 'low', available: true, source: 'no-budget' };

  const ev = (ledger.events || []).filter(
    (e) => e.model === model && Date.parse(e.started_at) >= cutoff
  );
  const calls = ev.length;
  const tokens = ev.reduce((n, e) => n + (e.input_tokens || 0) + (e.output_tokens || 0), 0);
  const hardLimited = ev.some((e) => e.rate_limited);
  const byCalls = budget.calls ? calls / budget.calls : 0;
  const byTokens = budget.tokens ? tokens / budget.tokens : 0;
  const used = Math.max(byCalls, byTokens);
  const remaining = Math.max(0, 1 - used);
  return {
    model,
    remaining_ratio: remaining,
    confidence: 'low',
    available: !hardLimited && remaining > 0,
    source: 'ledger-estimate',
  };
}

// ---------- selection ----------
function chainFor(profiles, role, level) {
  const byRole = profiles.fallback_chains && profiles.fallback_chains[role];
  if (!byRole) return [];
  return byRole[level] || byRole.medium || [];
}

function selectModel(task, profiles, ledger) {
  const role = task.role || 'execution';
  const complexity = task.complexity
    ? { score: null, level: task.complexity }
    : scoreComplexity(task.signals);
  const level = complexity.level;
  const costSensitivity = task.cost_sensitivity || 'normal';
  const availability = Object.assign({}, task.availability);
  // Global switch: MODEL_DIRECTOR_FABLE=off forces the Fable->gpt-5.6-sol substitution.
  if ((process.env.MODEL_DIRECTOR_FABLE || '').toLowerCase() === 'off') availability.fable = false;
  const policy = profiles.policy || {};
  const reserve = typeof policy.safety_reserve_ratio === 'number' ? policy.safety_reserve_ratio : 0.25;
  const fableMin = typeof policy.fable_min_remaining_ratio === 'number' ? policy.fable_min_remaining_ratio : 0.35;

  let chain = chainFor(profiles, role, level).slice();
  const candidates = [];
  const rejections = [];

  const quotaFor = (m) => estimateQuota(ledger, m, profiles);

  // Under high cost sensitivity, reorder viable chain by ascending cost while
  // preserving capability (only among models whose min_complexity fits).
  if (costSensitivity === 'high') {
    chain.sort((a, b) => (profiles.models[a]?.cost || 99) - (profiles.models[b]?.cost || 99));
  }

  let chosen = null;
  for (const m of chain) {
    const prof = profiles.models[m];
    if (!prof) { rejections.push({ model: m, reason: 'unknown-model' }); continue; }
    const q = quotaFor(m);
    candidates.push(q);

    if (!prof.roles.includes(role)) { rejections.push({ model: m, reason: `not-eligible-for-${role}` }); continue; }
    if (COMPLEXITY_ORDER[level] < COMPLEXITY_ORDER[prof.min_complexity]) {
      // model is "overqualified" is fine; but if model needs MORE than provided, skip
    }
    if (COMPLEXITY_ORDER[prof.min_complexity] > COMPLEXITY_ORDER[level]) {
      rejections.push({ model: m, reason: `min-complexity-${prof.min_complexity}>${level}` });
      continue;
    }
    if (m === 'fable') {
      if (availability.fable === false) { rejections.push({ model: m, reason: 'fable-unavailable-this-session' }); continue; }
      if (!(level === 'high' || level === 'frontier')) { rejections.push({ model: m, reason: 'fable-reserved-for-high/frontier' }); continue; }
      if (q.remaining_ratio < fableMin) { rejections.push({ model: m, reason: `fable-below-min-ratio(${fableMin})` }); continue; }
    }
    if (availability[m] === false) { rejections.push({ model: m, reason: 'explicitly-unavailable' }); continue; }
    if (!q.available) { rejections.push({ model: m, reason: `no-quota(${q.source})` }); continue; }
    if (q.remaining_ratio - reserve <= 0) { rejections.push({ model: m, reason: `below-safety-reserve(${reserve})` }); continue; }

    chosen = m;
    break;
  }

  // Last resort: cheapest available candidate in the chain, ignoring reserve.
  let lastResort = false;
  if (!chosen) {
    const viable = chain
      .filter((m) => profiles.models[m] && quotaFor(m).available)
      .sort((a, b) => (profiles.models[a].cost || 99) - (profiles.models[b].cost || 99));
    if (viable.length) { chosen = viable[0]; lastResort = true; }
  }
  if (!chosen) chosen = 'opus'; // absolute fallback: keep working on Anthropic side

  const idx = chain.indexOf(chosen);
  const fallbacks = idx >= 0 ? chain.slice(idx + 1) : chain.filter((m) => m !== chosen);
  const chosenQuota = quotaFor(chosen);
  const ledgerConfidence = candidates.every((c) => c.confidence === 'high') ? 'high' : 'low';

  return {
    role,
    complexity,
    cost_sensitivity: costSensitivity,
    chosen,
    fallbacks,
    candidates,
    rejections,
    last_resort: lastResort,
    quota_snapshot: candidates.reduce((o, c) => { o[c.model] = { remaining_ratio: Number(c.remaining_ratio.toFixed(2)), confidence: c.confidence, source: c.source }; return o; }, {}),
    ledger_confidence: ledgerConfidence,
    chosen_quota: chosenQuota,
  };
}

function dispatchHint(model, profiles, task) {
  const prof = profiles.models[model] || {};
  if (prof.via === 'codex') {
    const write = task.role === 'execution' ? ' --write' : '';
    return { via: 'codex', model, command_hint: `claude-to-codex/scripts/codex-run.sh -m ${model}${write}` };
  }
  return { via: 'claude-code', model, command_hint: model === 'opus' ? 'main loop or Agent(model:"opus")' : `Agent(model:"${model}")` };
}

function humanReason(sel, task) {
  const c = sel.chosen;
  const lvl = sel.complexity.level;
  const skippedFable = sel.rejections.find((r) => r.model === 'fable');
  const bits = [`${sel.role}/${lvl} → ${c}`];
  if (skippedFable) bits.push(`Fable preserved (${skippedFable.reason})`);
  if (sel.last_resort) bits.push('last-resort pick (quota tight)');
  bits.push(`quota confidence: ${sel.ledger_confidence}`);
  return bits.join('; ');
}

// ---------- subcommands ----------
function cmdDecide() {
  const profiles = loadProfiles();
  const ledger = loadLedger(profiles);
  const task = readJSON(0, null) || (() => { const s = readStdin(); try { return JSON.parse(s); } catch { return null; } })();
  if (!task) fail('decide: invalid task JSON on stdin', 64);

  const sel = selectModel(task, profiles, ledger);
  const decision = {
    timestamp: new Date().toISOString(),
    task_id: task.task_id || null,
    subtask_id: task.subtask_id || null,
    role: sel.role,
    signals: task.signals || null,
    complexity: sel.complexity,
    cost_sensitivity: sel.cost_sensitivity,
    quota_snapshot: sel.quota_snapshot,
    candidates: sel.candidates.map((c) => c.model),
    rejections: sel.rejections,
    chosen: sel.chosen,
    fallbacks: sel.fallbacks,
    dispatch: dispatchHint(sel.chosen, profiles, task),
    reason: humanReason(sel, task),
    ledger_confidence: sel.ledger_confidence,
    summary: `${sel.chosen} for ${sel.role} (${sel.complexity.level})` +
      (sel.fallbacks.length ? `, fallback: ${sel.fallbacks.join(' → ')}` : '') +
      `. ${humanReason(sel, task)}.`,
  };
  appendJSONL(RECORD_LOG, decision);
  process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
}

function cmdRecord() {
  const profiles = loadProfiles();
  const ledger = loadLedger(profiles);
  const r = readJSON(0, null) || (() => { const s = readStdin(); try { return JSON.parse(s); } catch { return null; } })();
  if (!r || !r.model) fail('record: invalid result JSON on stdin (need at least {model})', 64);

  const prof = profiles.models[r.model] || {};
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    started_at: r.started_at || new Date().toISOString(),
    ended_at: r.ended_at || new Date().toISOString(),
    provider: r.provider || prof.provider || 'unknown',
    model: r.model,
    subtask_id: r.subtask_id || null,
    status: r.status || 'success',
    input_tokens: r.input_tokens || 0,
    output_tokens: r.output_tokens || 0,
    tokens_source: r.tokens_source || 'estimate',
    rate_limited: !!r.rate_limited,
  };
  ledger.events = ledger.events || [];
  ledger.events.push(event);

  if (typeof r.remaining_ratio === 'number') {
    ledger.observations = ledger.observations || [];
    ledger.observations.push({
      at: new Date().toISOString(),
      provider: event.provider,
      model: r.model,
      remaining_ratio: r.remaining_ratio,
      resets_at: r.resets_at || null,
      rate_limited: !!r.rate_limited,
      source: r.source || 'cli-event',
    });
  }

  // Prune anything older than the longest window (keep the ledger small).
  const maxWindow = Math.max(
    ...Object.values(ledger.subscriptions || {}).flatMap((s) =>
      (s.windows || []).map((w) => w.duration_sec || 0)
    ),
    18000
  );
  const cutoff = Date.now() - maxWindow * 1000 * 2; // keep 2 windows of history
  ledger.events = ledger.events.filter((e) => Date.parse(e.started_at) >= cutoff);
  ledger.observations = (ledger.observations || []).filter((o) => Date.parse(o.at) >= cutoff);

  atomicWriteJSON(LEDGER_PATH, ledger);
  process.stdout.write(JSON.stringify({ ok: true, recorded: event.id, model: r.model }, null, 2) + '\n');
}

// ---------- main ----------
const sub = process.argv[2];
if (sub === 'decide') cmdDecide();
else if (sub === 'record') cmdRecord();
else fail(`usage: model-gate.js <decide|record>  (got: ${sub || 'nothing'})`, 64);
