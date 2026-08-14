const assert = require('assert');
const pricing = require('../services/pricingService');

function run() {
  assert.strictEqual(pricing.calculateCustomerPrice({
    supplierPrice: 10,
    pricingMode: 'global',
    globalMarkupPercent: 20,
  }), 12);

  assert.strictEqual(pricing.calculateCustomerPrice({
    supplierPrice: 10,
    pricingMode: 'percentage',
    customMarkupPercent: 35,
  }), 13.5);

  assert.strictEqual(pricing.calculateCustomerPrice({
    supplierPrice: 10,
    pricingMode: 'fixed',
    fixedPrice: 16.75,
  }), 16.75);

  const enriched = pricing.enrichProductPricing({
    supplier_price: 8,
    your_price: 10,
    pricing_mode: 'fixed',
  }, 15);
  assert.strictEqual(enriched.profit_amount, 2);
  assert.strictEqual(enriched.profit_percent, 25);
  assert.strictEqual(enriched.below_cost, false);

  const legacy = pricing.enrichProductPricing({
    supplier_price: 5,
    your_price: 7,
    price_overridden: true,
  }, 10);
  assert.strictEqual(legacy.pricing_mode, 'fixed');

  assert.throws(() => pricing.calculateCustomerPrice({
    supplierPrice: 10,
    pricingMode: 'percentage',
    customMarkupPercent: -1,
  }), /between 0 and 1000/);

  console.log('Pricing flow checks passed.');
}

run();
