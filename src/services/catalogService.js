/**
 * catalogService.js
 *
 * Keeps a local copy of the supplier's product catalog so the app
 * never has to call the supplier live on every screen load, and so
 * you control pricing/margin and availability independently.
 */

const supplierApi = require('./supplierApi');
const store = require('../db/db');
const pricingService = require('./pricingService');

// Set your markup strategy here. Simple flat % for now — swap for
// per-category rules later if needed.
const FALLBACK_MARGIN_PERCENT = Number(process.env.MARGIN_PERCENT || 10);

/**
 * Pulls the full catalog from the supplier and upserts it locally.
 * Run this on a schedule (e.g. every 15-30 min) via a cron job,
 * and also on-demand from an admin "refresh catalog" button.
 *
 * IMPORTANT: products you've manually converted to product_type
 * 'manual' (e.g. Shahid, Netflix, OSN, Prime, Watch It — subscriptions
 * you fulfill yourself with an external supplier, not through Kamal
 * Cell's API) are excluded from this sync even though Kamal Cell's
 * catalog still lists them under the same supplier_product_id. Without
 * this exclusion, every sync would silently overwrite your manual
 * setup back to an automated Kamal Cell product and any customer order
 * placed afterward would go to the wrong fulfillment flow.
 */
async function syncCatalog() {
  const [supplierProducts, settings, localProducts] = await Promise.all([
    supplierApi.getProducts(),
    store.getAppSettings(),
    store.listProducts(),
  ]);

  const manualSupplierIds = new Set(
    localProducts
      .filter((product) => product.product_type === 'manual')
      .map((product) => String(product.supplier_product_id))
      .filter((id) => id !== 'undefined' && id !== 'null'),
  );

  const syncable = supplierProducts.filter(
    (p) => !manualSupplierIds.has(String(p.supplier_product_id ?? p.id)),
  );
  const skippedManualCount = supplierProducts.length - syncable.length;

  const marginPercent = Number(settings.default_markup_percent ?? FALLBACK_MARGIN_PERCENT);
  const withMargin = syncable.map((p) => ({
    ...p,
    supplier_price: Number(p.price),
    your_price: pricingService.calculateCustomerPrice({
      supplierPrice: p.price,
      pricingMode: pricingService.PRICING_MODES.GLOBAL,
      globalMarkupPercent: marginPercent,
    }),
  }));
  const count = await store.upsertProducts(withMargin);
  return {
    synced: count,
    global_markup_percent: marginPercent,
    skipped_manual: skippedManualCount,
  };
}

function productForCustomer(product, customerType) {
  const price = pricingService.priceForCustomer(product, customerType);
  // Internal cost and alternative-tier values never leave the backend.
  const {
    supplier_price,
    reseller_price,
    pricing_mode,
    custom_markup_percent,
    price_overridden,
    supplier_price_updated_at,
    ...publicProduct
  } = product;
  return {
    ...publicProduct,
    your_price: price.unit_price,
    price_tier: price.customer_type,
  };
}

async function listAvailableProducts(customerType = 'retail') {
  const all = await store.listProducts();
  return all
    .filter((p) => p.available && p.is_listed && !p.archived)
    .map((product) => productForCustomer(product, customerType));
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

function validateProductForSale(product) {
  if (!product.available || !product.is_listed || product.archived) {
    throw Object.assign(
      new Error('This product is not currently available for purchase'),
      { code: 'PRODUCT_UNAVAILABLE' }
    );
  }
}

function validateExtraParams(product, extraParams) {
  const required = Array.isArray(product.params) ? product.params : [];
  const supplied = extraParams && typeof extraParams === 'object' ? extraParams : {};
  for (const field of required) {
    const value = String(supplied[field] ?? '').trim();
    if (!value) {
      throw Object.assign(new Error(`${field} is required`), { code: 'MISSING_PRODUCT_PARAMETER' });
    }
    if (value.length > 300) {
      throw Object.assign(new Error(`${field} is too long`), { code: 'INVALID_PRODUCT_PARAMETER' });
    }
  }
  return Object.fromEntries(
    required.map((field) => [field, String(supplied[field]).trim()])
  );
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
  productForCustomer,
  getProductOrThrow,
  validateProductForSale,
  validateExtraParams,
  validateQty,
};