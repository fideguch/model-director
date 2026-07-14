'use strict';
// Unit tests for the deliberation engine. Run: node --test tests/
// Spawns the real CLI (stdin/stdout contract) with an isolated ledger per case.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ENGINE = path.join(__dirname, '..', 'scripts', 'lib', 'model-gate.js');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function decide(task, env = {}) {
  return withHome((home) => {
    const out = execFileSync('node', [ENGINE, 'decide'], {
      input: JSON.stringify(task),
      env: { ...process.env, MODEL_DIRECTOR_HOME: home, ...env },
    });
    return JSON.parse(out.toString());
  });
}

test('planning/high uses fable when available', () => {
  assert.equal(decide({ role: 'planning', complexity: 'high' }).chosen, 'fable');
});

test('planning/high substitutes sol when fable unavailable', () => {
  assert.equal(
    decide({ role: 'planning', complexity: 'high', availability: { fable: false } }).chosen,
    'gpt-5.6-sol'
  );
});

test('MODEL_DIRECTOR_FABLE=off forces the sol substitution', () => {
  assert.equal(
    decide({ role: 'planning', complexity: 'high' }, { MODEL_DIRECTOR_FABLE: 'off' }).chosen,
    'gpt-5.6-sol'
  );
});

test('execution/low picks the cheapest tier (luna)', () => {
  assert.equal(decide({ role: 'execution', complexity: 'low' }).chosen, 'gpt-5.6-luna');
});

test('execution/high picks opus', () => {
  assert.equal(decide({ role: 'execution', complexity: 'high' }).chosen, 'opus');
});

test('review/high is cross-model (sol leads the chain)', () => {
  assert.equal(decide({ role: 'review', complexity: 'high' }).chosen, 'gpt-5.6-sol');
});

test('signals score up to high/frontier complexity', () => {
  const d = decide({ role: 'execution', signals: { architecture: true, novel: true, files: 8 } });
  assert.ok(['high', 'frontier'].includes(d.complexity.level));
});

test('fable is never chosen for execution', () => {
  assert.notEqual(decide({ role: 'execution', complexity: 'frontier' }).chosen, 'fable');
});

test('decision carries a dispatch hint and a summary', () => {
  const d = decide({ role: 'planning', complexity: 'high', availability: { fable: false } });
  assert.match(d.dispatch.command_hint, /codex-run\.sh -m gpt-5\.6-sol/);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});

test('record creates a ledger with an event and an observation', () => {
  withHome((home) => {
    execFileSync('node', [ENGINE, 'record'], {
      input: JSON.stringify({
        provider: 'openai', model: 'gpt-5.6-sol', status: 'success',
        input_tokens: 1000, output_tokens: 500, remaining_ratio: 0.4,
      }),
      env: { ...process.env, MODEL_DIRECTOR_HOME: home },
    });
    const led = JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8'));
    assert.equal(led.events.length, 1);
    assert.equal(led.observations.length, 1);
    assert.equal(led.observations[0].remaining_ratio, 0.4);
  });
});

test('a fresh low-remaining observation makes a model unavailable', () => {
  withHome((home) => {
    const env = { ...process.env, MODEL_DIRECTOR_HOME: home };
    // Observe sol at 0 remaining + rate-limited, then it must not be chosen for planning.
    execFileSync('node', [ENGINE, 'record'], {
      input: JSON.stringify({ provider: 'openai', model: 'gpt-5.6-sol', status: 'error', rate_limited: true, remaining_ratio: 0 }),
      env,
    });
    const out = execFileSync('node', [ENGINE, 'decide'], {
      input: JSON.stringify({ role: 'planning', complexity: 'high', availability: { fable: false } }),
      env,
    });
    assert.notEqual(JSON.parse(out.toString()).chosen, 'gpt-5.6-sol');
  });
});

test('an observation is discounted by usage recorded since (fix #2)', () => {
  withHome((home) => {
    const env = { ...process.env, MODEL_DIRECTOR_HOME: home };
    const rec = (o) => execFileSync('node', [ENGINE, 'record'], { input: JSON.stringify(o), env });
    rec({ provider: 'openai', model: 'gpt-5.6-sol', remaining_ratio: 0.6 });              // observe 0.6
    rec({ provider: 'openai', model: 'gpt-5.6-sol', input_tokens: 200000, output_tokens: 0 }); // spend 0.4 of 500k budget
    const dec = JSON.parse(
      execFileSync('node', [ENGINE, 'decide'], { input: JSON.stringify({ role: 'review', complexity: 'high' }), env }).toString()
    );
    const rr = dec.quota_snapshot['gpt-5.6-sol'].remaining_ratio;
    assert.ok(rr <= 0.25, `expected discounted remaining <= 0.25, got ${rr}`);
  });
});

test('last-resort never resurrects a hard-rejected model (fix #3)', () => {
  withHome((home) => {
    const env = { ...process.env, MODEL_DIRECTOR_HOME: home };
    const rec = (o) => execFileSync('node', [ENGINE, 'record'], { input: JSON.stringify(o), env });
    // Push sol and opus just below the 25% reserve (still >0) so only the
    // reserve blocks them; Fable is hard-rejected via availability.
    rec({ provider: 'openai', model: 'gpt-5.6-sol', input_tokens: 400000, output_tokens: 0 }); // 0.8 of 500k
    rec({ provider: 'anthropic', model: 'opus', input_tokens: 320000, output_tokens: 0 });     // 0.8 of 400k
    const dec = JSON.parse(
      execFileSync('node', [ENGINE, 'decide'], {
        input: JSON.stringify({ role: 'planning', complexity: 'high', availability: { fable: false } }),
        env,
      }).toString()
    );
    assert.equal(dec.last_resort, true);
    assert.notEqual(dec.chosen, 'fable');
  });
});
