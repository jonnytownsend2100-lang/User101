import { toMinor } from './money.js';

export class CatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogError';
  }
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

export function defineProduct(store, input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new CatalogError('product name is required');

  const currency = String(input.currency ?? 'usd').toLowerCase();
  const amount =
    input.amountMinor != null ? Number(input.amountMinor) : toMinor(input.price ?? 0, currency);
  if (!Number.isInteger(amount) || amount < 0) throw new CatalogError('price must be a non-negative number');

  const interval = input.interval ?? null;
  if (interval && !['month', 'year', 'week'].includes(interval)) {
    throw new CatalogError("interval must be one of 'month', 'year', 'week'");
  }

  const slug = input.slug ? slugify(input.slug) : slugify(name);
  if (store.findOne('products', (p) => p.slug === slug)) {
    throw new CatalogError(`a product with slug '${slug}' already exists`);
  }

  return store.insert('products', {
    slug,
    name,
    tagline: input.tagline ?? '',
    description: input.description ?? '',
    amount,
    currency,
    interval,
    payWhatYouWant: Boolean(input.payWhatYouWant),
    minimumAmount: input.minimumAmount != null ? Number(input.minimumAmount) : amount,
    maxQuantity: input.maxQuantity ?? 100,
    seats: input.seats ?? 1,
    licenseDays: input.licenseDays ?? null,
    license: input.license !== false,
    active: input.active !== false,
    createdAt: new Date().toISOString(),
  });
}

/** A default catalog that is actually sellable, for demos and first run. */
export function seedCatalog(store) {
  const existing = store.all('products');
  if (existing.length) return existing;
  return [
    defineProduct(store, {
      name: 'Mint Pro',
      tagline: 'Unlimited products, refunds and license keys',
      description: 'The paid tier: unlimited SKUs, refund tooling, signed license keys and the revenue ledger.',
      price: 29,
      interval: 'month',
      seats: 3,
    }),
    defineProduct(store, {
      name: 'Mint Lifetime',
      tagline: 'One payment, yours forever',
      description: 'A single payment. Every future version, no subscription.',
      price: 299,
    }),
    defineProduct(store, {
      name: 'Consulting Hour',
      tagline: 'Pay what it is worth to you',
      description: 'Sixty minutes on your pricing, funnel or ledger. Minimum $50.',
      price: 50,
      payWhatYouWant: true,
      minimumAmount: toMinor(50, 'usd'),
    }),
  ];
}
