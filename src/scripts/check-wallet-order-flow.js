const assert = require('assert');

const orderServicePath = require.resolve('../services/orderService');
const supplierPath = require.resolve('../services/supplierApi');
const catalogPath = require.resolve('../services/catalogService');
const storePath = require.resolve('../db/db');
const notificationPath = require.resolve('../services/notificationService');

function loadOrderService({ supplier, catalog, store }) {
  delete require.cache[orderServicePath];
  require.cache[supplierPath] = {
    id: supplierPath,
    filename: supplierPath,
    loaded: true,
    exports: supplier,
  };
  require.cache[catalogPath] = {
    id: catalogPath,
    filename: catalogPath,
    loaded: true,
    exports: catalog,
  };
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: store,
  };
  require.cache[notificationPath] = {
    id: notificationPath,
    filename: notificationPath,
    loaded: true,
    exports: { async notifyOrder() {} },
  };
  return require(orderServicePath);
}

function createStore({ insufficient = false } = {}) {
  const orders = new Map();
  const ledger = { debits: 0, credits: 0 };
  return {
    ledger,
    async getUserById(id) {
      return { id, customer_type: 'retail', disabled: false };
    },
    async getOrderByClientRequest(userId, requestId) {
      return Array.from(orders.values()).find(
        (order) =>
          order.user_id === userId && order.client_request_id === requestId
      ) || null;
    },
    async createOrder(order) {
      orders.set(order.order_uuid, { ...order });
      return orders.get(order.order_uuid);
    },
    async getOrderByUuid(orderUuid) {
      return orders.get(orderUuid) || null;
    },
    async updateOrder(orderUuid, patch) {
      const updated = { ...orders.get(orderUuid), ...patch };
      orders.set(orderUuid, updated);
      return updated;
    },
    async listOrdersByUser(userId) {
      return Array.from(orders.values()).filter((order) => order.user_id === userId);
    },
    async debitWallet(userId, amount) {
      if (insufficient) {
        throw Object.assign(new Error('Insufficient wallet balance'), {
          code: 'INSUFFICIENT_FUNDS',
        });
      }
      ledger.debits += Number(amount);
      return 0;
    },
    async creditWallet(userId, amount) {
      ledger.credits += Number(amount);
      return Number(amount);
    },
  };
}

const catalog = {
  async getProductOrThrow() {
    return {
      supplier_product_id: 42,
      your_price: 5,
      supplier_price: 4,
      available: true,
      is_listed: true,
      archived: false,
      qty_values: null,
      params: ['account'],
    };
  },
  validateProductForSale(product) {
    if (!product.available || !product.is_listed || product.archived) {
      throw Object.assign(new Error('Product unavailable'), {
        code: 'PRODUCT_UNAVAILABLE',
      });
    }
  },
  validateQty(product, qty) {
    assert.equal(qty, 1);
  },
  validateExtraParams(product, params) {
    assert.equal(params.account, 'customer-1');
    return params;
  },
};

async function run() {
  const successfulStore = createStore();
  let supplierCalls = 0;
  const service = loadOrderService({
    store: successfulStore,
    catalog,
    supplier: {
      async newOrder() {
        supplierCalls += 1;
        return { data: { status: 'reject', order_id: 'supplier-1' } };
      },
      async checkOrders() {
        return { data: [] };
      },
    },
  });

  const rejected = await service.placeOrder({
    userId: 'user-1',
    productId: 42,
    qty: 1,
    extraParams: { account: 'customer-1' },
    clientRequestId: 'checkout-request-1',
  });
  assert.equal(rejected.status, 'reject');
  assert.ok(rejected.refunded_at);
  assert.equal(successfulStore.ledger.debits, 5);
  assert.equal(successfulStore.ledger.credits, 5);
  assert.equal(supplierCalls, 1);

  const duplicate = await service.placeOrder({
    userId: 'user-1',
    productId: 42,
    qty: 1,
    extraParams: { account: 'customer-1' },
    clientRequestId: 'checkout-request-1',
  });
  assert.equal(duplicate.order_uuid, rejected.order_uuid);
  assert.equal(successfulStore.ledger.debits, 5);
  assert.equal(supplierCalls, 1);

  await assert.rejects(
    service.recheckOrder(rejected.order_uuid, 'another-user'),
    (error) => error.code === 'ORDER_NOT_FOUND'
  );

  const insufficientStore = createStore({ insufficient: true });
  const insufficientService = loadOrderService({
    store: insufficientStore,
    catalog,
    supplier: {
      async newOrder() {
        throw new Error('Supplier must not be called');
      },
      async checkOrders() {
        return { data: [] };
      },
    },
  });
  await assert.rejects(
    insufficientService.placeOrder({
      userId: 'user-2',
      productId: 42,
      qty: 1,
      extraParams: { account: 'customer-1' },
      clientRequestId: 'checkout-request-2',
    }),
    (error) => error.code === 'INSUFFICIENT_FUNDS'
  );
  const failed = await insufficientStore.getOrderByClientRequest(
    'user-2',
    'checkout-request-2'
  );
  assert.equal(failed.status, 'payment_failed');
  assert.equal(insufficientStore.ledger.debits, 0);

  console.log('Wallet-protected order flow tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
