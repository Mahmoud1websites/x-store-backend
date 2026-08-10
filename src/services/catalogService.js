/**
 * catalogService.js
 *
 * Keeps a local copy of the supplier's product catalog so the app
 * never has to call the supplier live on every screen load, and so
 * you control pricing/margin and availability independently.
 */

const supplierApi = require('./supplierApi');
const store = require('../db/db');

// Set your markup strategy here. Simple flat % for now — swap for
// per-category rules later if needed.
const FALLBACK_MARGIN_PERCENT = Number(process.env.MARGIN_PERCENT || 10);

function applyMargin(supplierPrice, marginPercent = FALLBACK_MARGIN_PERCENT) {
  const price = Number(supplierPrice) * (1 + Number(marginPercent) / 100);
  return Math.round(price * 1000) / 1000; // keep 3 decimals like supplier does
}

/**
 * Pulls the full catalog from the supplier and upserts it locally.
 * Run this on a schedule (e.g. every 15-30 min) via a cron job,
 * and also on-demand from an admin "refresh catalog" button.
 */
async function syncCatalog() {
  const [supplierProducts, settings] = await Promise.all([
    supplierApi.getProducts(),
    store.getAppSettings(),
  ]);
  const marginPercent = Number(settings.default_markup_percent ?? FALLBACK_MARGIN_PERCENT);
  const withMargin = supplierProducts.map((p) => ({
    ...p,
    supplier_price: Number(p.price),
    your_price: applyMargin(p.price, marginPercent),
  }));
  const count = await store.upsertProducts(withMargin);
  return { synced: count };
}

async function listAvailableProducts() {
  const all = await store.listProducts();
  return all.filter((p) => p.available);
}

async function getProductOrThrow(productId) {
  const product = await store.getProduct(productId);
  if (!product) {
    const err = new Error(`Product ${productId} not found in local catalog. Try syncing catalog.`);
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }
  return product;
}

/**
 * Validates a requested quantity against the product's qty_values rule.
 * Mirrors the three shapes documented by the supplier:
 *  - null            -> qty must be exactly 1
 *  - array           -> qty must be one of these exact values
 *  - {min, max}      -> qty must fall within this range
 */
function validateQty(product, qty) {
  const rule = product.qty_values;
  const qtyNum = Number(qty);

  if (rule === null || rule === undefined) {
    if (qtyNum !== 1) {
      throw Object.assign(new Error('This product only allows quantity 1'), { code: 'QTY_NOT_ALLOWED' });
    }
    return;
  }

  if (Array.isArray(rule)) {
    const allowed = rule.map(Number);
    if (!allowed.includes(qtyNum)) {
      throw Object.assign(
        new Error(`Quantity must be one of: ${allowed.join(', ')}`),
        { code: 'QTY_NOT_ALLOWED' }
      );
    }
    return;
  }

  if (rule.min !== undefined && rule.max !== undefined) {
    const min = Number(rule.min);
    const max = Number(rule.max);
    if (qtyNum < min) {
      throw Object.assign(new Error(`Quantity too small (min ${min})`), { code: 'QTY_TOO_SMALL' });
    }
    if (qtyNum > max) {
      throw Object.assign(new Error(`Quantity too large (max ${max})`), { code: 'QTY_TOO_LARGE' });
    }
    return;
  }
}

module.exports = {
  syncCatalog,
  listAvailableProducts,
  getProductOrThrow,
  validateQty,
};
