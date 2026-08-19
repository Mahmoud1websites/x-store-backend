const PRICING_MODES = Object.freeze({
  GLOBAL: 'global',
  PERCENTAGE: 'percentage',
  FIXED: 'fixed',
});

const VALID_MODES = new Set(Object.values(PRICING_MODES));

const CUSTOMER_TYPES = Object.freeze({
  RETAIL: 'retail',
  RESELLER: 'reseller',
});

function normalizeCustomerType(value) {
  return String(value || '').toLowerCase() === CUSTOMER_TYPES.RESELLER
    ? CUSTOMER_TYPES.RESELLER
    : CUSTOMER_TYPES.RETAIL;
}

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundPrice(value) {
  return Math.round((numberOr(value) + Number.EPSILON) * 1000) / 1000;
}

function validateMarkup(value, label = 'Markup') {
  const markup = Number(value);
  if (!Number.isFinite(markup) || markup < 0 || markup > 1000) {
    const error = new Error(`${label} must be between 0 and 1000 percent`);
    error.status = 400;
    error.code = 'INVALID_MARKUP';
    throw error;
  }
  return markup;
}

function normalizePricingMode(product = {}) {
  const mode = String(product.pricing_mode || '').toLowerCase();
  if (VALID_MODES.has(mode)) return mode;
  if (product.product_type === 'manual' || product.price_overridden) {
    return PRICING_MODES.FIXED;
  }
  return PRICING_MODES.GLOBAL;
}

function calculateCustomerPrice({
  supplierPrice,
  pricingMode = PRICING_MODES.GLOBAL,
  globalMarkupPercent = 0,
  customMarkupPercent = null,
  fixedPrice = null,
}) {
  const mode = normalizePricingMode({ pricing_mode: pricingMode });
  const cost = numberOr(supplierPrice);
  if (cost < 0) {
    const error = new Error('Supplier price cannot be negative');
    error.status = 400;
    error.code = 'INVALID_SUPPLIER_PRICE';
    throw error;
  }

  if (mode === PRICING_MODES.FIXED) {
    const fixed = Number(fixedPrice);
    if (!Number.isFinite(fixed) || fixed < 0) {
      const error = new Error('A valid fixed customer price is required');
      error.status = 400;
      error.code = 'INVALID_FIXED_PRICE';
      throw error;
    }
    return roundPrice(fixed);
  }

  const markup = mode === PRICING_MODES.PERCENTAGE
    ? validateMarkup(customMarkupPercent, 'Product markup')
    : validateMarkup(globalMarkupPercent, 'Global markup');
  return roundPrice(cost * (1 + markup / 100));
}

function enrichProductPricing(product, globalMarkupPercent = 0) {
  const mode = normalizePricingMode(product);
  const supplierPrice = numberOr(product.supplier_price);
  const customerPrice = numberOr(product.your_price);
  const effectiveMarkup = mode === PRICING_MODES.GLOBAL
    ? numberOr(globalMarkupPercent)
    : mode === PRICING_MODES.PERCENTAGE
      ? numberOr(product.custom_markup_percent)
      : supplierPrice > 0
        ? ((customerPrice - supplierPrice) / supplierPrice) * 100
        : null;
  const profitAmount = roundPrice(customerPrice - supplierPrice);
  const resellerPrice = product.reseller_price == null
    ? customerPrice
    : numberOr(product.reseller_price, customerPrice);
  const resellerProfit = roundPrice(resellerPrice - supplierPrice);

  return {
    ...product,
    supplier_price: supplierPrice,
    your_price: customerPrice,
    pricing_mode: mode,
    custom_markup_percent: mode === PRICING_MODES.PERCENTAGE
      ? numberOr(product.custom_markup_percent)
      : null,
    global_markup_percent: numberOr(globalMarkupPercent),
    effective_markup_percent: effectiveMarkup == null ? null : roundPrice(effectiveMarkup),
    profit_amount: profitAmount,
    profit_percent: supplierPrice > 0
      ? roundPrice((profitAmount / supplierPrice) * 100)
      : null,
    below_cost: supplierPrice > 0 && customerPrice < supplierPrice,
    reseller_price: resellerPrice,
    reseller_profit_amount: resellerProfit,
    reseller_profit_percent: supplierPrice > 0
      ? roundPrice((resellerProfit / supplierPrice) * 100)
      : null,
    reseller_below_cost: supplierPrice > 0 && resellerPrice < supplierPrice,
  };
}

function priceForCustomer(product, customerType) {
  const type = normalizeCustomerType(customerType);
  const retailPrice = numberOr(product.your_price);
  const resellerPrice = product.reseller_price == null
    ? retailPrice
    : numberOr(product.reseller_price, retailPrice);
  return {
    customer_type: type,
    unit_price: roundPrice(
      type === CUSTOMER_TYPES.RESELLER ? resellerPrice : retailPrice,
    ),
  };
}

module.exports = {
  PRICING_MODES,
  VALID_MODES,
  CUSTOMER_TYPES,
  normalizeCustomerType,
  roundPrice,
  validateMarkup,
  normalizePricingMode,
  calculateCustomerPrice,
  enrichProductPricing,
  priceForCustomer,
};
