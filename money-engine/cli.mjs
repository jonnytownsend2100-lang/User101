#!/usr/bin/env node
/**
 * Money Engine CLI — the same model, in the terminal.
 *
 *   node cli.mjs --playbook micro-saas --target 3000
 *   node cli.mjs --mode flow --price 150 --units 40 --fixed 900 --hours 25
 *   node cli.mjs --playbook local-service --json
 *
 * With no flags it runs the default scenario. Flags map onto engine inputs:
 *   --mode --price --units --growth --churn --var --fixed --cac --tax
 *   --startup --hours --months --playbook --target --json
 */
import { simulate, goalSeek, InputError } from './src/engine.mjs';
import { PLAYBOOKS, playbookById } from './src/playbooks.mjs';

const USAGE = `Money Engine — model the money before you spend the time.

  node cli.mjs [flags]

Flags (all optional; any flag overrides the playbook preset):
  --playbook <id>   start from a playbook preset
  --mode <flow|recurring>
  --price <n>       price per unit / per month
  --units <n>       starting customers or units per month
  --growth <n>      new customers per month, %
  --churn <n>       churn per month, % (recurring only)
  --var <n>         cost to deliver, % of revenue
  --fixed <n>       fixed costs per month
  --cac <n>         cost to win one customer
  --startup <n>     one-off setup cost
  --tax <n>         tax set-aside, % of profit
  --hours <n>       hours per week
  --months <n>      months to project
  --target <n>      target monthly net profit, for goal-seek
  --json            emit the raw result instead of a report
  --help            this message

Playbooks: ${PLAYBOOKS.map((p) => p.id).join(', ')}

Examples:
  node cli.mjs --playbook micro-saas --target 3000
  node cli.mjs --mode flow --price 150 --units 40 --fixed 900 --hours 25
  node cli.mjs --playbook local-service --json
`;


const FLAG_TO_FIELD = {
  price: 'price',
  units: 'units',
  growth: 'growthPct',
  churn: 'churnPct',
  var: 'variableCostPct',
  fixed: 'fixedCostMonthly',
  cac: 'acqCostPerUnit',
  tax: 'taxRatePct',
  startup: 'startupCost',
  hours: 'hoursPerWeek',
  months: 'months',
  mode: 'mode',
  playbook: 'playbook',
  target: 'targetMonthlyNet',
};

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.trim();
    if (key === 'help' || key === 'h') {
      out.help = true;
      continue;
    }

    if (key === 'json') {
      out.json = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++i];
    if (value === undefined) throw new InputError(`Flag --${key} needs a value`);
    const field = FLAG_TO_FIELD[key];
    if (!field) throw new InputError(`Unknown flag --${key}`);
    out[field] = field === 'mode' || field === 'playbook' ? String(value) : Number(value);
  }
  return out;
}

const money = (v, dp = 0) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

function bar(value, max, width = 28) {
  if (!Number.isFinite(value) || max <= 0) return '';
  const filled = Math.max(0, Math.round((Math.abs(value) / max) * width));
  return (value < 0 ? '-' : '') + '█'.repeat(filled);
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function renderReport({ playbook, result, goal }) {
  const L = [];
  const line = (s = '') => L.push(s);
  const cfg = result.config;
  const rule = '─'.repeat(74);

  line(rule);
  line(`  MONEY ENGINE  ·  ${playbook ? playbook.name : cfg.label}`);
  line(rule);
  line(
    `  Model: ${cfg.mode === 'recurring' ? 'recurring (subscriptions/retainers)' : 'flow (one-off sales)'}` +
      `   ${money(cfg.price, 2)}/unit · ${cfg.units} units · ${cfg.months} months`
  );
  line();

  line('  WHERE IT LANDS');
  line(`    Monthly net at month ${cfg.months}`.padEnd(40) + padL(money(result.steadyState.netProfit), 14));
  line(`    Trailing-12-month net`.padEnd(40) + padL(money(result.annualNet), 14));
  line(
    `    Net margin at the end`.padEnd(40) +
      padL(result.steadyState.netMarginPct === null ? '—' : result.steadyState.netMarginPct.toFixed(1) + '%', 14)
  );
  line(
    `    Effective rate`.padEnd(40) +
      padL(result.effectiveHourlyRate === null ? '—' : money(result.effectiveHourlyRate, 2) + '/hr', 14) +
      `  (${cfg.hoursPerWeek} h/week)`
  );
  line();

  line('  WHAT IT TAKES');
  line(
    `    Units to break even`.padEnd(40) +
      padL(result.breakEvenUnits === null ? 'unreachable' : result.breakEvenUnits.toFixed(1) + '/mo', 14)
  );
  line(`    Contribution per unit`.padEnd(40) + padL(money(result.contributionPerUnit, 2), 14));
  line(`    First profitable month`.padEnd(40) + padL(result.monthsToBreakEven ?? 'never', 14));
  line(
    `    Payback on startup capital`.padEnd(40) +
      padL(result.monthsToPayback ?? 'never', 14) +
      (result.peakInvestment < 0 ? `  (deepest: ${money(result.peakInvestment)})` : '')
  );
  line();

  const max = Math.max(...result.series.map((r) => Math.abs(r.revenue)), 1);
  line('  MONTHLY REVENUE');
  for (const row of result.series) {
    if (cfg.months > 18 && row.month > 6 && row.month <= cfg.months - 6) {
      if (row.month === 7) line('    ...');
      continue;
    }
    line(
      `    ${padL(row.month, 3)}  ${pad(row.revenue.toFixed(0), 8)}  ${bar(row.revenue, max)}  net ${money(row.netProfit)}`
    );
  }
  line();

  line('  LEVERS, RANKED BY ANNUAL IMPACT (~10% move each)');
  const ranked = result.sensitivities;
  const top = Math.max(...ranked.map((s) => Math.abs(s.annualNetDelta ?? 0)), 1);
  ranked.forEach((s, i) => {
    const delta = s.annualNetDelta ?? 0;
    line(
      `    ${padL(i + 1, 2)}. ${pad(s.label, 30)} ${padL(s.effective ? money(delta) : 'n/a', 10)}  ${bar(delta, top, 16)}`
    );
  });
  line();

  if (goal) {
    line(`  TO CLEAR ${money(goal.targetMonthlyNet)}/MONTH, NET`);
    if (goal.reachable) {
      line(`    Units needed at this price`.padEnd(40) + padL(goal.requiredUnits.toFixed(1) + '/mo', 14));
      line(`    ...or this price at ${cfg.units} units`.padEnd(40) + padL(money(goal.requiredPrice, 2), 14));
    } else {
      line(`    ${goal.note}`);
    }
    line();
  }

  if (result.warnings.length) {
    line('  WATCH OUT');
    for (const w of result.warnings) line(`    ! ${w}`);
    line();
  }

  return L.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const wantJson = Boolean(args.json);
  const target = args.targetMonthlyNet;
  delete args.json;
  delete args.targetMonthlyNet;

  let input = { ...args };
  let playbook = null;
  if (args.playbook) {
    playbook = playbookById(args.playbook);
    if (!playbook) {
      console.error(`Unknown playbook "${args.playbook}". Available: ${PLAYBOOKS.map((p) => p.id).join(', ')}`);
      process.exitCode = 2;
      return;
    }
    input = { ...playbook.preset, ...input };
    delete input.playbook;
  }

  const result = simulate(input);
  const goal = target !== undefined ? goalSeek(result.config, target) : null;

  if (wantJson) {
    console.log(JSON.stringify({ ...result, goal }, null, 2));
    return;
  }
  console.log(renderReport({ playbook, result, goal }));
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof InputError) {
    console.error(`Input error: ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});

