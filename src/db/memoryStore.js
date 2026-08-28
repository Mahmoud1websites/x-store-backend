/**
 * memoryStore.js
 *
 * TEMPORARY in-memory store so you can run and test the supplier
 * integration end-to-end today without setting up Postgres first.
 *
 * When you're ready to move to a real DB (recommended: Postgres +
 * Prisma), replace the functions below with real queries against
 * these tables:
 *
 *   products(id, supplier_product_id, name, category_name, your_price,
 *            supplier_price, product_type, qty_values_json, params_json,
 *            is_listed, available, updated_at)
 *   orders(id, user_id, product_id, order_uuid, supplier_order_id,
 *          qty, params_json, status, your_price, supplier_price,
 *          created_at, updated_at)
 *
 * The function signatures here are intentionally shaped like they'd
 * look with a real DB (async, return plain objects) so swapping the
 * implementation later doesn't require touching orderService.js or
 * catalogService.js.
 */

const products = new Map(); // key: supplier_product_id
const orders = new Map();   // key: order_uuid
const users = new Map();    // key: user id (uuid)
const usersByEmail = new Map(); // key: lowercased email -> user id, for fast login lookup

// ---- Users ----

async function createUser({ id, email, passwordHash }) {
  const user = {
    id,
    email,
    password_hash: passwordHash,
    wallet_balance: 0,
    role: 'customer',
    disabled: false,
    created_at: new Date().toISOString(),
  };
  users.set(id, user);
  usersByEmail.set(email.toLowerCase(), id);
  return user;
}

async function getUserByEmail(email) {
  const id = usersByEmail.get(email.toLowerCase());
  return id ? users.get(id) : null;
}

async function getUserById(id) {
  return users.get(id) || null;
}

async function updateUser(id, patch) {
  const existing = users.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  users.set(id, updated);
  return updated;
}

async function getAppSettings() {
  return { default_markup_percent: 10 };
}

async function debitWallet(userId, amount) {
  const user = users.get(userId);
  if (!user || Number(user.wallet_balance) < Number(amount)) {
    throw new Error('Insufficient wallet balance');
  }
  user.wallet_balance = Number(user.wallet_balance) - Number(amount);
  return user.wallet_balance;
}

async function creditWallet(userId, amount) {
  const user = users.get(userId);
  if (!user) throw new Error('User not found');
  user.wallet_balance = Number(user.wallet_balance) + Number(amount);
  return user.wallet_balance;
}

// ---- Products ----

async function upsertProducts(productList) {
  for (const p of productList) {
    const existing = products.get(String(p.id));
    products.set(String(p.id), {
      supplier_product_id: p.id,
      name: p.name,
      category_name: p.category_name,
      supplier_price: p.price,
      your_price: p.price, // TODO: apply your margin logic here
      product_type: p.product_type,
      qty_values: p.qty_values,
      params: p.params,
      is_listed: existing?.is_listed ?? false,
      available: p.available,
      updated_at: new Date().toISOString(),
    });
  }
  return products.size;
}

async function getProduct(supplierProductId) {
  return products.get(String(supplierProductId)) || null;
}

async function listProducts() {
  return Array.from(products.values());
}

// ---- Orders ----

async function createOrder(order) {
  const duplicate = Array.from(orders.values()).find(
    (existing) =>
      existing.user_id === order.user_id &&
      existing.client_request_id === order.client_request_id
  );
  if (duplicate) return duplicate;
  orders.set(order.order_uuid, {
    ...order,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return orders.get(order.order_uuid);
}

async function getOrderByClientRequest(userId, clientRequestId) {
  return Array.from(orders.values()).find(
    (order) =>
      order.user_id === userId && order.client_request_id === clientRequestId
  ) || null;
}

async function getOrderByUuid(orderUuid) {
  return orders.get(orderUuid) || null;
}

async function updateOrder(orderUuid, patch) {
  const existing = orders.get(orderUuid);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
  orders.set(orderUuid, updated);
  return updated;
}

async function listOrdersByStatus(status) {
  return Array.from(orders.values()).filter((o) => o.status === status);
}

async function listOrdersByStatuses(statuses) {
  return Array.from(orders.values()).filter((order) =>
    statuses.includes(order.status)
  );
}

async function listOrdersByUser(userId) {
  return Array.from(orders.values())
    .filter((order) => order.user_id === userId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

module.exports = {
  upsertProducts,
  getProduct,
  listProducts,
  createOrder,
  getOrderByClientRequest,
  getOrderByUuid,
  updateOrder,
  listOrdersByStatus,
  listOrdersByStatuses,
  listOrdersByUser,
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
  getAppSettings,
  debitWallet,
  creditWallet,
};
