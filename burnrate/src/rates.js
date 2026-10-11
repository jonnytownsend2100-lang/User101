// Runner price table for GitHub-hosted Actions runners.
//
// Source of truth: GitHub Docs, "Actions runner pricing"
//   https://docs.github.com/en/billing/reference/actions-minute-multipliers
// Retrieved and transcribed verbatim on 2026-10-11. Every number below is a
// published list price in USD per minute.
//
// Billing rule that GitHub applies (quoted from the same page):
//   "GitHub rounds the minutes and partial minutes each job uses up to the
//    nearest whole minute."
// That rule is implemented in billing.js, not here.
//
// IMPORTANT, and the reason this file is data rather than hardcoded logic:
// GitHub changes these prices. RATES_META.lastVerified lets the product show
// provenance in the UI ("prices verified 2026-10-11") and lets a user override
// the table without touching code. Never silently guess a price -- unmatched
// jobs are reported as UNPRICED with an explicit count.

export const RATES_META = {
  source: 'https://docs.github.com/en/billing/reference/actions-minute-multipliers',
  sourceTitle: 'GitHub Docs - Actions runner pricing',
  lastVerified: '2026-10-11',
  currency: 'USD',
  unit: 'per-minute',
  roundingRule: 'each job rounds up to the nearest whole minute',
};

// kind: 'standard' | 'larger'
// standard runners consume a plan's included minutes (with an OS multiplier);
// larger runners are *always* charged and never draw on included minutes.
export const RUNNER_RATES = [
  // --- standard GitHub-hosted runners ---
  { sku: 'actions_linux_slim', os: 'linux', cores: 1, arch: 'x64', kind: 'standard', perMinute: 0.002, label: 'Linux 1-core (x64)' },
  { sku: 'actions_linux', os: 'linux', cores: 2, arch: 'x64', kind: 'standard', perMinute: 0.006, label: 'Linux 2-core (x64)' },
  { sku: 'actions_linux_arm', os: 'linux', cores: 2, arch: 'arm64', kind: 'standard', perMinute: 0.005, label: 'Linux 2-core (arm64)' },
  { sku: 'actions_windows', os: 'windows', cores: 2, arch: 'x64', kind: 'standard', perMinute: 0.010, label: 'Windows 2-core (x64)' },
  { sku: 'actions_windows_arm', os: 'windows', cores: 2, arch: 'arm64', kind: 'standard', perMinute: 0.010, label: 'Windows 2-core (arm64)' },
  { sku: 'actions_macos', os: 'macos', cores: 4, arch: 'x64', kind: 'standard', perMinute: 0.062, label: 'macOS 3-core or 4-core (M1 or Intel)' },

  // --- x64-powered larger runners ---
  { sku: 'linux_2_core_advanced', os: 'linux', cores: 2, arch: 'x64', kind: 'larger', perMinute: 0.006, label: 'Linux Advanced 2-core' },
  { sku: 'linux_4_core', os: 'linux', cores: 4, arch: 'x64', kind: 'larger', perMinute: 0.012, label: 'Linux 4-core' },
  { sku: 'linux_8_core', os: 'linux', cores: 8, arch: 'x64', kind: 'larger', perMinute: 0.022, label: 'Linux 8-core' },
  { sku: 'linux_16_core', os: 'linux', cores: 16, arch: 'x64', kind: 'larger', perMinute: 0.042, label: 'Linux 16-core' },
  { sku: 'linux_32_core', os: 'linux', cores: 32, arch: 'x64', kind: 'larger', perMinute: 0.082, label: 'Linux 32-core' },
  { sku: 'linux_64_core', os: 'linux', cores: 64, arch: 'x64', kind: 'larger', perMinute: 0.162, label: 'Linux 64-core' },
  { sku: 'linux_96_core', os: 'linux', cores: 96, arch: 'x64', kind: 'larger', perMinute: 0.252, label: 'Linux 96-core' },
  { sku: 'windows_4_core', os: 'windows', cores: 4, arch: 'x64', kind: 'larger', perMinute: 0.022, label: 'Windows 4-core' },
  { sku: 'windows_8_core', os: 'windows', cores: 8, arch: 'x64', kind: 'larger', perMinute: 0.042, label: 'Windows 8-core' },
  { sku: 'windows_16_core', os: 'windows', cores: 16, arch: 'x64', kind: 'larger', perMinute: 0.082, label: 'Windows 16-core' },
  { sku: 'windows_32_core', os: 'windows', cores: 32, arch: 'x64', kind: 'larger', perMinute: 0.162, label: 'Windows 32-core' },
  { sku: 'windows_64_core', os: 'windows', cores: 64, arch: 'x64', kind: 'larger', perMinute: 0.322, label: 'Windows 64-core' },
  { sku: 'windows_96_core', os: 'windows', cores: 96, arch: 'x64', kind: 'larger', perMinute: 0.552, label: 'Windows 96-core' },
  { sku: 'macos_l', os: 'macos', cores: 12, arch: 'x64', kind: 'larger', perMinute: 0.077, label: 'macOS 12-core' },

  // --- arm64-powered larger runners ---
  { sku: 'linux_2_core_arm', os: 'linux', cores: 2, arch: 'arm64', kind: 'larger', perMinute: 0.005, label: 'Linux 2-core (arm64)' },
  { sku: 'linux_4_core_arm', os: 'linux', cores: 4, arch: 'arm64', kind: 'larger', perMinute: 0.008, label: 'Linux 4-core (arm64)' },
  { sku: 'linux_8_core_arm', os: 'linux', cores: 8, arch: 'arm64', kind: 'larger', perMinute: 0.014, label: 'Linux 8-core (arm64)' },
  { sku: 'linux_16_core_arm', os: 'linux', cores: 16, arch: 'arm64', kind: 'larger', perMinute: 0.026, label: 'Linux 16-core (arm64)' },
  { sku: 'linux_32_core_arm', os: 'linux', cores: 32, arch: 'arm64', kind: 'larger', perMinute: 0.050, label: 'Linux 32-core (arm64)' },
  { sku: 'linux_64_core_arm', os: 'linux', cores: 64, arch: 'arm64', kind: 'larger', perMinute: 0.098, label: 'Linux 64-core (arm64)' },
  { sku: 'windows_2_core_arm', os: 'windows', cores: 2, arch: 'arm64', kind: 'larger', perMinute: 0.008, label: 'Windows 2-core (arm64)' },
  { sku: 'windows_4_core_arm', os: 'windows', cores: 4, arch: 'arm64', kind: 'larger', perMinute: 0.014, label: 'Windows 4-core (arm64)' },
  { sku: 'windows_8_core_arm', os: 'windows', cores: 8, arch: 'arm64', kind: 'larger', perMinute: 0.026, label: 'Windows 8-core (arm64)' },
  { sku: 'windows_16_core_arm', os: 'windows', cores: 16, arch: 'arm64', kind: 'larger', perMinute: 0.050, label: 'Windows 16-core (arm64)' },
  { sku: 'windows_32_core_arm', os: 'windows', cores: 32, arch: 'arm64', kind: 'larger', perMinute: 0.098, label: 'Windows 32-core (arm64)' },
  { sku: 'windows_64_core_arm', os: 'windows', cores: 64, arch: 'arm64', kind: 'larger', perMinute: 0.194, label: 'Windows 64-core (arm64)' },
  { sku: 'macos_xl', os: 'macos', cores: 5, arch: 'arm64', kind: 'larger', perMinute: 0.102, label: 'macOS 5-core (M2 Pro)' },

  // --- GPU-powered larger runners ---
  { sku: 'linux_4_core_gpu', os: 'linux', cores: 4, arch: 'x64', kind: 'larger', perMinute: 0.052, label: 'Linux 4-core (GPU)' },
  { sku: 'windows_4_core_gpu', os: 'windows', cores: 4, arch: 'x64', kind: 'larger', perMinute: 0.102, label: 'Windows 4-core (GPU)' },
];

// Storage list prices, same doc. Artifact/cache storage is a real and
// frequently surprising part of an Actions bill, so we surface it too.
export const STORAGE_RATES = {
  shared_storage_per_gb_month: 0.25,
  actions_cache_per_gb_month: 0.07,
  custom_image_per_gb_month: 0.07,
};

// Included monthly allowances by plan (same GitHub Docs page).
// Standard runners consume these; larger runners never do.
export const PLAN_ALLOWANCES = {
  free: { includedMinutes: 2000, artifactStorageMb: 500, cacheStorageGb: 10, customImageStorageGb: 0 },
  pro: { includedMinutes: 3000, artifactStorageMb: 1000, cacheStorageGb: 10, customImageStorageGb: 0 },
  team: { includedMinutes: 3000, artifactStorageMb: 2000, cacheStorageGb: 10, customImageStorageGb: 75 },
  enterprise: { includedMinutes: 50000, artifactStorageMb: 50000, cacheStorageGb: 10, customImageStorageGb: 150 },
};

// A minute on Windows counts as 2 against a plan's included minutes; macOS
// counts as 10; Linux as 1. Standard runners only -- larger runners are always
// charged outright. Kept configurable because GitHub has been migrating the
// billing semantics around included minutes.
export const OS_MINUTE_MULTIPLIER = { linux: 1, windows: 2, macos: 10 };

const bySku = new Map(RUNNER_RATES.map((r) => [r.sku, r]));

export function getRateBySku(sku) {
  return bySku.get(sku) || null;
}

// Documented *standard* label families. Anything in these families is priced
// exactly, no guessing.
const STANDARD_LABEL_RE = [
  { re: /^ubuntu-slim$/, sku: 'actions_linux_slim' },
  { re: /^ubuntu-(\d+\.\d+|latest)$/, sku: 'actions_linux' },
  { re: /^windows-(\d+|latest)$/, sku: 'actions_windows' },
  { re: /^macos-(1[0-9]|latest)$/, sku: 'actions_macos' },
];

function detectOs(label) {
  if (/\bubuntu\b|\blinux\b/.test(label)) return 'linux';
  if (/\bwindows\b|\bwin\b/.test(label)) return 'windows';
  if (/\bmacos\b|\bios\b|\bxcode\b/.test(label)) return 'macos';
  return null;
}

function detectArch(label) {
  if (/arm64|aarch64|\barm\b/.test(label)) return 'arm64';
  return null;
}

function detectCores(label) {
  // matches "16-core", "16core", "16 cores", "16cpu", "16-cpu"
  const m = label.match(/(\d{1,3})\s*[-_]?\s*(?:core|cores|cpu|cpus)/);
  if (m) return Number(m[1]);
  if (/xlarge/.test(label)) return null; // resolved by the macOS table below
  return null;
}

/**
 * Map a job's runner labels (plus optional runner group name) to a price.
 *
 * Returns null perMinute when we genuinely cannot price the job. That is a
 * deliberate product decision: Burnrate reports an explicit "unpriced jobs"
 * count instead of quietly assigning a wrong price, because a cost report that
 * silently invents numbers is worse than useless to the person paying the bill.
 */
export function resolveRunner(labels = [], runnerGroupName = null) {
  const raw = Array.isArray(labels) ? labels.filter(Boolean).map(String) : [];
  const lc = raw.map((s) => s.toLowerCase().trim());
  const hay = [...lc, String(runnerGroupName || '').toLowerCase()].join(' ');

  if (lc.includes('self-hosted')) {
    return {
      kind: 'self-hosted', sku: null, os: detectOs(hay), cores: detectCores(hay),
      arch: detectArch(hay), perMinute: 0, confidence: 'exact',
      matchedBy: 'self-hosted',
      note: 'self-hosted: no GitHub compute charge (your own infrastructure cost)',
    };
  }

  // 1) exact documented standard labels
  for (const label of lc) {
    for (const { re, sku } of STANDARD_LABEL_RE) {
      if (re.test(label)) {
        const rate = bySku.get(sku);
        return { ...pick(rate), kind: 'standard', confidence: 'exact', matchedBy: `label:${label}` };
      }
    }
  }

  // 2) documented macOS larger-runner suffixes (-large / -xlarge)
  for (const label of lc) {
    if (/^macos-\d+(-large)$/.test(label)) {
      return { ...pick(bySku.get('macos_l')), kind: 'larger', confidence: 'inferred', matchedBy: `label:${label}` };
    }
    if (/^macos-\d+(-xlarge)$/.test(label)) {
      return { ...pick(bySku.get('macos_xl')), kind: 'larger', confidence: 'inferred', matchedBy: `label:${label}` };
    }
  }

  // 3) larger runners: parse OS + cores (+arch) out of the label/group
  const os = detectOs(hay);
  const cores = detectCores(hay);
  if (os && cores) {
    const arch = detectArch(hay) || 'x64';
    const gpu = /gpu/.test(hay);
    let rate = null;
    if (gpu) {
      rate = RUNNER_RATES.find((r) => r.kind === 'larger' && r.os === os && r.cores === cores && /gpu/.test(r.sku));
    }
    if (!rate) {
      rate = RUNNER_RATES.find((r) => r.kind === 'larger' && r.os === os && r.cores === cores && r.arch === arch);
    }
    if (!rate) {
      // fall back to the other architecture rather than dropping the job
      rate = RUNNER_RATES.find((r) => r.kind === 'larger' && r.os === os && r.cores === cores);
    }
    if (rate) {
      return { ...pick(rate), kind: 'larger', confidence: 'inferred', matchedBy: `parsed:${os}/${cores}core/${arch}` };
    }
  }

  // 4) can't price it -- say so
  return {
    kind: 'unknown', sku: null, os, cores, arch: detectArch(hay), perMinute: null,
    confidence: 'unknown', matchedBy: `unmatched:${raw.join(',') || 'no-labels'}`,
    note: 'runner label not found in the price table; job is left unpriced on purpose',
  };
}

function pick(rate) {
  if (!rate) return {};
  return { sku: rate.sku, os: rate.os, cores: rate.cores, arch: rate.arch, perMinute: rate.perMinute };
}


