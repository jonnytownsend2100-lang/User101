// The ledger answers one question honestly: after fees and refunds, what did
// this actually keep? Gross revenue is a vanity number; net is the real one.

const SETTLED = new Set(['paid', 'partially_refunded', 'refunded']);
const REFUNDED = new Set(['refunded', 'partially_refunded']);

const monthlyEquivalent = (order) => {
  if (!order.interval) return 0;
  if (order.interval === 'year') return Math.round(order.amount / 12);
  if (order.interval === 'week') return Math.round((order.amount * 52) / 12);
  return order.amount; // month
};

const dayKey = (iso) => iso.slice(0, 10);

export function metrics(store, { now = new Date(), days = 30 } = {}) {
  const orders = store.all('orders');
  const settled = orders.filter((o) => SETTLED.has(o.status));
  const sum = (list, pick) => list.reduce((acc, o) => acc + (pick(o) ?? 0), 0);

  const gross = sum(settled, (o) => o.amount);
  const fees = sum(settled, (o) => o.fee);
  const refunds = sum(orders.filter((o) => REFUNDED.has(o.status)), (o) => o.refundedAmount ?? o.amount);
  const net = gross - fees - refunds;

  const active = settled.filter((o) => !REFUNDED.has(o.status));
  const mrr = sum(active.filter((o) => o.interval), monthlyEquivalent);

  const byProduct = new Map();
  for (const order of settled) {
    const row = byProduct.get(order.productId) ?? {
      productId: order.productId,
      name: order.productName,
      orders: 0,
      gross: 0,
      fees: 0,
      refunds: 0,
      net: 0,
    };
    row.orders += 1;
    row.gross += order.amount;
    row.fees += order.fee;
    row.refunds += REFUNDED.has(order.status) ? order.refundedAmount ?? order.amount : 0;
    row.net = row.gross - row.fees - row.refunds;
    byProduct.set(order.productId, row);
  }

  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const dayOrders = settled.filter((o) => dayKey(o.paidAt ?? o.createdAt) === key);
    const dayRefunds = orders.filter((o) => o.refundedAt && dayKey(o.refundedAt) === key);
    series.push({
      date: key,
      orders: dayOrders.length,
      gross: sum(dayOrders, (o) => o.amount),
      net:
        sum(dayOrders, (o) => o.amount - o.fee) -
        sum(dayRefunds, (o) => o.refundedAmount ?? o.amount),
    });
  }

  const paidCount = settled.length;
  const created = orders.filter((o) => o.status !== 'failed').length;

  return {
    generatedAt: now.toISOString(),
    orders: {
      created,
      paid: orders.filter((o) => o.status === 'paid').length,
      refunded: orders.filter((o) => REFUNDED.has(o.status)).length,
      pending: orders.filter((o) => o.status === 'pending').length,
      failed: orders.filter((o) => o.status === 'failed').length,
    },
    conversion: created ? paidCount / created : 0,
    gross,
    fees,
    refunds,
    net,
    margin: gross ? net / gross : 0,
    mrr,
    arr: mrr * 12,
    customers: store.all('customers').length,
    licenses: {
      active: store.all('licenses').filter((l) => l.status === 'active').length,
      revoked: store.all('licenses').filter((l) => l.status === 'revoked').length,
    },
    byProduct: [...byProduct.values()].sort((a, b) => b.net - a.net),
    series,
  };
}

/**
 * Price advice with the arithmetic shown, so it can be argued with.
 * A price whose per-unit margin is negative at typical volume is not a price,
 * it is a subsidy -- usually discovered far too late.
 */
export function priceAdvice({ amount, fee, targetMargin = 0.8 }) {
  const net = amount - fee;
  const margin = amount ? net / amount : 0;
  const minForTarget = Math.ceil(fee / (1 - targetMargin));
  return {
    amount,
    fee,
    net,
    margin,
    targetMargin,
    healthy: margin >= targetMargin,
    suggestion: margin >= targetMargin ? null : `charge at least ${minForTarget} minor units to keep ${Math.round(targetMargin * 100)}%`,
  };
}
