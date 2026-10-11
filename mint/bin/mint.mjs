#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { Store } from '../lib/store.js';
import { defineProduct, seedCatalog } from '../lib/catalog.js';
import { format, toMinor } from '../lib/money.js';
import { metrics, priceAdvice } from '../lib/ledger.js';
import { issueLicense, verifyLicense } from '../lib/license.js';
import { createOrder, markPaid } from '../lib/checkout.js';
import { getProvider } from '../lib/providers.js';
import { createApp } from '../lib/server.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function flags(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith('--')) {
      out._ = [...(out._ ?? []), token];
      continue;
    }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (list[i + 1] && !list[i + 1].startsWith('--')) out[key] = list[(i += 1)];
    else out[key] = true;
  }
  return out;
}

const opts = flags(args.slice(1));
const dataDir = process.env.MINT_DATA_DIR ?? path.resolve(process.cwd(), 'mint-data');
const storeFile = path.join(dataDir, 'store.json');

async function secretFile(name, bytes = 32) {
  const file = path.join(dataDir, name);
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    await mkdir(dataDir, { recursive: true });
    const value = randomBytes(bytes).toString('hex');
    await writeFile(file, `${value}\n`, { mode: 0o600 });
    return value;
  }
}

/** Secrets come from the environment in production; locally they are generated once and stored 0600. */
async function resolveSecrets() {
  const licenseSecret = process.env.MINT_LICENSE_SECRET ?? (await secretFile('license.secret'));
  const adminToken = process.env.MINT_ADMIN_TOKEN ?? (await secretFile('admin.token', 24));
  return {
    licenseSecret,
    adminToken,
    generated: !process.env.MINT_LICENSE_SECRET || !process.env.MINT_ADMIN_TOKEN,
  };
}

const openStore = async () => {
  const store = new Store({ file: storeFile });
  await store.load();
  return store;
};

const providerName = (opts.provider ?? process.env.MINT_PROVIDER ?? 'mock').toString();

async function cmdInit() {
  const store = await openStore();
  const products = seedCatalog(store);
  await store.save();
  const { generated } = await resolveSecrets();
  console.log(`mint: initialised ${storeFile}`);
  console.log(`  ${products.length} products ready to sell`);
  console.log(generated ? '  secrets generated in mint-data/ (0600) -- set MINT_LICENSE_SECRET / MINT_ADMIN_TOKEN in production' : '  secrets taken from the environment');
  console.log('\nnext:  node bin/mint.mjs serve     then open http://localhost:8787');
}

async function cmdSeed() {
  const store = await openStore();
  const before = store.all('products').length;
  const products = seedCatalog(store);
  await store.save();
  console.log(`mint: ${store.all('products').length - before} products added (${products.length} total)`);
}

async function cmdProducts() {
  const store = await openStore();
  for (const p of store.all('products')) {
    const label = p.payWhatYouWant ? `${format(p.minimumAmount, p.currency)}+ (PWYW)` : format(p.amount, p.currency);
    console.log(`${p.slug.padEnd(22)} ${label.padEnd(16)} ${p.interval ?? 'one-off'}  ${p.name}`);
  }
}

async function cmdProductAdd() {
  if (!opts.name) throw new Error('--name is required');
  const store = await openStore();
  const product = defineProduct(store, {
    name: opts.name,
    tagline: opts.tagline ?? '',
    description: opts.description ?? '',
    price: opts.price ?? 0,
    interval: opts.interval ?? null,
    payWhatYouWant: Boolean(opts.pwyw),
    minimumAmount: opts.min ? toMinor(opts.min) : undefined,
    seats: opts.seats ? Number(opts.seats) : undefined,
    licenseDays: opts.days ? Number(opts.days) : undefined,
    license: opts['no-license'] ? false : undefined,
  });
  await store.save();
  const advice = priceAdvice({ amount: product.amount, fee: 0 });
  console.log(`mint: added ${product.slug} (${product.id})`);
  console.log(`  price ${format(product.amount, product.currency)}${product.interval ? `/${product.interval}` : ''}`);
  if (advice.suggestion) console.log(`  note: ${advice.suggestion}`);
}

async function cmdServe() {
  const store = await openStore();
  if (!store.all('products').length) {
    seedCatalog(store);
    await store.save();
    console.log('mint: catalog was empty, seeded the defaults');
  }
  const { licenseSecret, adminToken } = await resolveSecrets();
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const app = createApp({
    store,
    providerName,
    adminToken,
    licenseSecret,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? null,
    baseUrl: process.env.MINT_BASE_URL ?? null,
    allowMock: process.env.MINT_ALLOW_MOCK !== '0',
  });
  app.listen(port, () => {
    console.log(`mint: listening on http://localhost:${port}`);
    console.log(`  store      ${storeFile}`);
    console.log(`  provider   ${providerName}${providerName === 'mock' ? ' (simulated payments)' : ''}`);
    console.log(`  storefront http://localhost:${port}/`);
    console.log(`  console    http://localhost:${port}/dashboard?token=${adminToken}`);
  });
}

async function cmdReport() {
  const store = await openStore();
  const days = Number(opts.days ?? 30);
  const m = metrics(store, { days });
  console.log('mint report');
  console.log(`  gross      ${format(m.gross)}`);
  console.log(`  fees       -${format(m.fees)}`);
  console.log(`  refunds    -${format(m.refunds)}`);
  console.log(`  net        ${format(m.net)}   (margin ${(m.margin * 100).toFixed(1)}%)`);
  console.log(`  MRR        ${format(m.mrr)}   ARR ${format(m.arr)}`);
  console.log(`  orders     ${m.orders.paid} paid / ${m.orders.created} created (${(m.conversion * 100).toFixed(1)}% conversion)`);
  console.log(`  customers  ${m.customers}, licenses ${m.licenses.active} active / ${m.licenses.revoked} revoked`);
  if (m.byProduct.length) {
    console.log('\n  by product');
    for (const p of m.byProduct) console.log(`    ${p.name.padEnd(20)} ${String(p.orders).padStart(3)} orders  net ${format(p.net)}`);
  }
}

async function cmdSimulate() {
  const store = await openStore();
  if (!store.all('products').length) await cmdSeed();
  const { licenseSecret } = await resolveSecrets();
  const provider = getProvider('mock');
  const product = store.all('products')[0];
  const order = await createOrder(store, {
    productId: product.id,
    email: opts.email ?? 'buyer@example.com',
    provider,
    baseUrl: 'http://localhost:8787',
  });
  const { license } = await markPaid(store, order.id, { providerRef: `mock_cs_${order.id}`, licenseSecret });
  console.log('mint: end-to-end simulated sale');
  console.log(`  product ${product.name}`);
  console.log(`  order   ${order.id}  ${format(order.amount, order.currency)}  fee ${format(order.fee)}  net ${format(order.net)}`);
  console.log(`  license ${license?.key ?? 'none'}`);
  const check = verifyLicense(license?.key, { secret: licenseSecret });
  console.log(`  verified offline: ${check.valid} (${check.reason})`);
}

async function cmdKeygen() {
  const { licenseSecret } = await resolveSecrets();
  const key = issueLicense({
    productId: opts.product ?? 'manual',
    orderId: opts.order ?? `manual_${Date.now()}`,
    customerId: opts.customer ?? 'manual',
    email: opts.email ?? null,
    seats: opts.seats ? Number(opts.seats) : 1,
    days: opts.days ? Number(opts.days) : null,
    secret: licenseSecret,
  });
  console.log(key);
}

async function cmdVerify() {
  const { licenseSecret } = await resolveSecrets();
  const key = opts._?.[0] ?? opts.key;
  const result = verifyLicense(key, { secret: licenseSecret });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}

function usage() {
  console.log(`mint -- an app that turns a product into collected payments

  node bin/mint.mjs init                        create the store + default catalog
  node bin/mint.mjs seed                        add the default catalog
  node bin/mint.mjs serve [--port 8787]         run storefront + console + webhooks
  node bin/mint.mjs products                    list the catalog
  node bin/mint.mjs product add --name X --price 29 [--interval month] [--pwyw --min 5]
  node bin/mint.mjs simulate [--email you@x]    create + settle an order end to end
  node bin/mint.mjs report [--days 30]          net revenue after fees and refunds
  node bin/mint.mjs keygen [--days 365]         mint a license key by hand
  node bin/mint.mjs verify <key>                verify a key offline

  env: MINT_PROVIDER=mock|stripe, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
       MINT_ADMIN_TOKEN, MINT_LICENSE_SECRET, MINT_DATA_DIR, PORT, MINT_BASE_URL
`);
}

const commands = {
  init: cmdInit,
  seed: cmdSeed,
  products: cmdProducts,
  product: () => (opts._?.[0] === 'add' ? cmdProductAdd() : usage()),
  serve: cmdServe,
  report: cmdReport,
  simulate: cmdSimulate,
  keygen: cmdKeygen,
  verify: cmdVerify,
  help: async () => usage(),
};

try {
  await (commands[command] ?? (async () => { usage(); process.exitCode = 1; }))();
} catch (err) {
  console.error(`mint: ${err.message}`);
  process.exitCode = 1;
}
