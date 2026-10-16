// Compares catalog.js with OpenRouter's live model list and prints what each plan costs Lumo.
// Fails (exit 1) when a paid model is gone, lost tool calling, can't see images when the catalog says
// it can, or now costs more than the catalog assumes; or when no free model with tool calling is left.
// Run: pnpm --filter @lumo/license check-models
import { MODELS, PLANS, freeRoster } from '../catalog.js';

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) throw new Error(`OpenRouter answered with HTTP ${res.status}`);
const live = (await res.json()).data;
const byId = new Map(live.map((m) => [m.id, m]));
const problems = [];

console.log('Paid models (per million tokens: catalog → OpenRouter now)');
for (const m of Object.values(MODELS)) {
  const l = byId.get(m.id);
  if (!l) {
    problems.push(`${m.id} is no longer on OpenRouter`);
    continue;
  }
  const input = Number(l.pricing.prompt) * 1e6;
  const output = Number(l.pricing.completion) * 1e6;
  const vision = !!l.architecture?.input_modalities?.includes('image');
  console.log(`  ${m.id}: in $${m.input} → $${input}, out $${m.output} → $${output}, images ${vision}`);
  if (!(l.supported_parameters ?? []).includes('tools'))
    problems.push(`${m.id} no longer supports tool calling`);
  if (m.vision && !vision) problems.push(`${m.id} can no longer see images`);
  if (input > m.input * 1.001 || output > m.output * 1.001)
    problems.push(`${m.id} costs more than the catalog says; update its prices (and maybe the plan budgets)`);
}

const free = freeRoster(live);
console.log(
  `\nFree roster: ${free.map((m) => `${m.id}${m.vision ? ' (sees images)' : ''}`).join(', ') || 'none'}`,
);
if (!free.length) problems.push('No free model with tool calling is left for the Free plan');

// A typical task: 4 model calls of ~12k prompt tokens and ~600 output tokens.
console.log('\nPlans at full use (model budget + OpenRouter 5.5% credit fee, Whop ~3% + 2.9% + $0.30):');
for (const p of PLANS.filter((p) => p.monthlyBudgetUsd !== null)) {
  const cost = p.monthlyBudgetUsd * 1.055;
  const fees = p.priceUsd * 0.059 + 0.3;
  const profit = p.priceUsd - cost - fees;
  const perTask = (id) => (4 * 12_000 * MODELS[id].input + 4 * 600 * MODELS[id].output) / 1e6;
  const tasks = Math.floor(p.monthlyBudgetUsd / perTask(p.defaultModel));
  console.log(
    `  ${p.name} $${p.priceUsd}: models up to $${cost.toFixed(2)}, fees $${fees.toFixed(2)}, profit at least $${profit.toFixed(2)} (${Math.round((profit / p.priceUsd) * 100)}%); about ${tasks} tasks a month on ${MODELS[p.defaultModel].name}`,
  );
}

if (problems.length) {
  console.error(`\n${problems.map((p) => `✗ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nThe catalog matches OpenRouter.');
