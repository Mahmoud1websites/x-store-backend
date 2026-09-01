const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const adminService = require('../services/adminService');
const walletService = require('../services/walletService');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const optionalImageUrl = z.union([z.string().url(), z.literal('')]).optional();



const productFields = {
  name: z.string().trim().min(2).max(160),
  supplier_product_id: z.union([z.string().trim().min(1), z.number()]).optional(),
  supplier_category_id: z.coerce.number().int().positive().nullable().optional(),
  category_name: z.string().trim().min(1).max(120).optional(),
  your_price: z.coerce.number().min(0).optional(),
  reseller_price: z.coerce.number().min(0).optional(),
  pricing_mode: z.enum(['global', 'percentage', 'fixed']).optional(),
  custom_markup_percent: z.coerce.number().min(0).max(1000).nullable().optional(),
  image_url: optionalImageUrl,
  available: z.boolean().optional(),
  is_listed: z.boolean().optional(),
  product_type: z.enum(['manual', 'amount', 'package']).optional(),
  supplier_source: z.enum(['kamal_cell', 'topupapp']).optional(),
  params: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
};
const createProductSchema = z.object(productFields).superRefine((value, context) => {
  if (value.your_price === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Customer price is required' });
  }
  if (value.product_type === 'manual' || value.product_type === undefined) return;
  // Non-manual products (e.g. TopUpApp recharges) need a real supplier
  // source and the provider's own product id to place real orders.
  if (!value.supplier_source) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['supplier_source'], message: 'Supplier source is required for non-manual products' });
  }
  if (!value.supplier_product_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['supplier_product_id'], message: 'Provider product ID is required for non-manual products' });
  }
});










const updateProductSchema = z.object({
  ...Object.fromEntries(Object.entries(productFields).map(([key, schema]) => [key, schema.optional()])),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const categorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  image_url: optionalImageUrl,
  visible: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const orderSchema = z.object({
  status: z.enum(['pending_supplier', 'wait', 'reject', 'fulfilled']).optional(),
  admin_note: z.string().trim().max(1000).optional(),
  audit_reason: z.string().trim().min(3).max(500),
  manual_credentials: z.object({
    message: z.string().trim().max(2000).optional().default(''),
    username: z.string().trim().max(160).optional().default(''),
    email: z.string().trim().max(160).optional().default(''),
    password: z.string().trim().max(160).optional().default(''),
    notes: z.string().trim().max(500).optional().default(''),
  }).optional(),
}).refine(
  (value) => value.status !== 'fulfilled' || (
    value.manual_credentials && (
      value.manual_credentials.message
      || (
        (value.manual_credentials.username || value.manual_credentials.email)
        && value.manual_credentials.password
      )
    )
  ),
  { message: 'Account details message (or username/email + password) are required to mark an order fulfilled' },
);



const userSchema = z.object({
  wallet_balance: z.coerce.number().min(0).optional(),
  disabled: z.boolean().optional(),
  customer_type: z.enum(['retail', 'reseller']).optional(),
  audit_reason: z.string().trim().min(3).max(500),
}).refine(
  (value) =>
    value.wallet_balance !== undefined
    || value.disabled !== undefined
    || value.customer_type !== undefined,
  'Nothing to update',
);
const settingsSchema = z.object({
  exchange_rate: z.coerce.number().positive().optional(),
  default_markup_percent: z.coerce.number().min(0).max(1000).optional(),
  maintenance_mode: z.boolean().optional(),
  allow_orders: z.boolean().optional(),
  support_phone: z.string().trim().max(50).optional(),
  whish_phone: z.string().trim().min(8).max(50).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const adminSchema = z.object({
  email: z.string().trim().email(),
  password: z.string()
    .min(12)
    .max(128)
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/\d/, 'Password must include a number'),
});
const adminAccountSchema = z.object({
  current_password: z.string().min(1).max(128),
  email: z.string().trim().email().optional(),
  password: z.string()
    .min(12)
    .max(128)
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/\d/, 'Password must include a number')
    .optional(),
}).refine(
  (value) => value.email !== undefined || value.password !== undefined,
  'Enter a new email or password',
);
const bulkListingSchema = z.object({
  product_ids: z.array(z.union([z.string().min(1), z.number()])).min(1).max(500),
  is_listed: z.boolean(),
});
const bulkPricingSchema = z.object({
  product_ids: z.array(z.union([z.string().min(1), z.number()])).min(1).max(500),
  pricing_mode: z.enum(['global', 'percentage']),
  custom_markup_percent: z.coerce.number().min(0).max(1000).nullable().optional(),
}).superRefine((value, context) => {
  if (value.pricing_mode === 'percentage' && value.custom_markup_percent == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['custom_markup_percent'],
      message: 'Custom markup is required for percentage pricing',
    });
  }
});
const walletReviewSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    whish_reference: z.string().trim().max(120).optional().default(''),
    admin_note: z.string().trim().max(500).optional().default(''),
  })
  .refine(
    (value) => value.action !== 'approve' || value.whish_reference.length >= 3,
    { message: 'Whish transfer reference is required for approval' }
  )
  .refine(
    (value) => value.action !== 'reject' || value.admin_note.length >= 3,
    { message: 'A reason is required when rejecting a request' }
  );

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error(result.error.issues.map((issue) => issue.message).join(', '));
    error.status = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return result.data;
}

function handler(action) {
  return async (req, res, next) => {
    try {
      const data = await action(req);
      res.json({ status: 'OK', data });
    } catch (error) {
      next(error);
    }
  };
}

const accountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/me', handler((req) => adminService.getAdminMe(req.user)));
router.patch('/account', accountLimiter, handler((req) =>
  adminService.updateAdminAccount(req.user.id, parse(adminAccountSchema, req.body))
));
router.get('/overview', handler(() => adminService.getOverview()));
router.get('/reports', handler((req) => adminService.getReports(req.query.days)));
router.get('/audit-logs', handler((req) => adminService.listAuditLogs(req.query.limit)));
router.get('/operations/logs', handler((req) =>
  adminService.listOperationalLogs(req.query.level, req.query.limit)
));
router.get('/products', handler((req) => adminService.listProducts(req.query.search)));
router.post('/products', handler((req) => adminService.createProduct(req.user.id, parse(createProductSchema, req.body))));
router.patch('/products/bulk-listing', handler((req) => {
  const input = parse(bulkListingSchema, req.body);
  return adminService.setProductListing(req.user.id, input.product_ids, input.is_listed);
}));
router.patch('/products/bulk-pricing', handler((req) => {
  const input = parse(bulkPricingSchema, req.body);
  return adminService.setProductPricing(req.user.id, input.product_ids, input);
}));
router.patch('/products/:id', handler((req) => adminService.updateProduct(req.user.id, req.params.id, parse(updateProductSchema, req.body))));
router.delete('/products/:id', handler((req) => adminService.archiveProduct(req.user.id, req.params.id)));

router.get('/categories', handler(() => adminService.listCategories()));
router.patch('/categories/:id', handler((req) => adminService.updateCategory(req.user.id, req.params.id, parse(categorySchema, req.body))));

router.get('/orders', handler((req) => adminService.listOrders(req.query.status)));
router.patch('/orders/:id', handler((req) => adminService.updateOrder(req.user.id, req.params.id, parse(orderSchema, req.body))));

router.get('/users', handler((req) => adminService.listUsers(req.query.search)));
router.patch('/users/:id', handler((req) => adminService.updateUser(req.user.id, req.params.id, parse(userSchema, req.body))));
router.post('/admins', accountLimiter, handler((req) =>
  adminService.createAdmin(req.user.id, parse(adminSchema, req.body))
));

router.get('/wallet-topups', handler((req) => walletService.listForAdmin(req.query.status)));
router.patch('/wallet-topups/:id', handler((req) =>
  walletService.reviewByAdmin(
    req.user.id,
    req.params.id,
    parse(walletReviewSchema, req.body)
  )
));

const supplierLimiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });
router.get('/supplier/status', handler(() => adminService.getSupplierStatus()));
router.get('/supplier/history', handler((req) => adminService.getSupplierSyncHistory(req.query.limit)));
router.post('/supplier/sync', supplierLimiter, handler((req) => adminService.syncSupplier(req.user.id)));

router.get('/settings', handler(() => adminService.getSettings()));
router.patch('/settings', handler((req) => adminService.updateSettings(req.user.id, parse(settingsSchema, req.body))));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) {
      return callback(Object.assign(new Error('Only JPG, PNG and WebP images are allowed'), { status: 400 }));
    }
    callback(null, true);
  },
});
const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
router.post('/uploads/images', uploadLimiter, upload.single('image'), handler((req) => {
  if (!req.file) {
    const error = new Error('Image file is required');
    error.status = 400;
    throw error;
  }
  return adminService.uploadImage(req.user.id, req.file);
}));

module.exports = router;