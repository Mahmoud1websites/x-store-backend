const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const adminService = require('../services/adminService');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const optionalImageUrl = z.union([z.string().url(), z.literal('')]).optional();
const productFields = {
  name: z.string().trim().min(2).max(160),
  supplier_product_id: z.union([z.string().trim().min(1), z.number()]).optional(),
  category_name: z.string().trim().min(1).max(120).optional(),
  your_price: z.coerce.number().min(0),
  image_url: optionalImageUrl,
  available: z.boolean().optional(),
};
const createProductSchema = z.object(productFields);
const updateProductSchema = z.object({
  ...Object.fromEntries(Object.entries(productFields).map(([key, schema]) => [key, schema.optional()])),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const categorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  image_url: optionalImageUrl,
  visible: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const orderSchema = z.object({
  status: z.enum(['pending_supplier', 'wait', 'reject']).optional(),
  admin_note: z.string().trim().max(1000).optional(),
  audit_reason: z.string().trim().min(3).max(500),
});
const userSchema = z.object({
  wallet_balance: z.coerce.number().min(0).optional(),
  disabled: z.boolean().optional(),
  audit_reason: z.string().trim().min(3).max(500),
}).refine((value) => value.wallet_balance !== undefined || value.disabled !== undefined, 'Nothing to update');
const settingsSchema = z.object({
  exchange_rate: z.coerce.number().positive().optional(),
  default_markup_percent: z.coerce.number().min(0).max(1000).optional(),
  maintenance_mode: z.boolean().optional(),
  allow_orders: z.boolean().optional(),
  support_phone: z.string().trim().max(50).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const adminSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(10).max(128),
});

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

router.get('/me', handler((req) => adminService.getAdminMe(req.user)));
router.get('/overview', handler(() => adminService.getOverview()));
router.get('/products', handler((req) => adminService.listProducts(req.query.search)));
router.post('/products', handler((req) => adminService.createProduct(req.user.id, parse(createProductSchema, req.body))));
router.patch('/products/:id', handler((req) => adminService.updateProduct(req.user.id, req.params.id, parse(updateProductSchema, req.body))));
router.delete('/products/:id', handler((req) => adminService.archiveProduct(req.user.id, req.params.id)));

router.get('/categories', handler(() => adminService.listCategories()));
router.patch('/categories/:id', handler((req) => adminService.updateCategory(req.user.id, req.params.id, parse(categorySchema, req.body))));

router.get('/orders', handler((req) => adminService.listOrders(req.query.status)));
router.patch('/orders/:id', handler((req) => adminService.updateOrder(req.user.id, req.params.id, parse(orderSchema, req.body))));

router.get('/users', handler((req) => adminService.listUsers(req.query.search)));
router.patch('/users/:id', handler((req) => adminService.updateUser(req.user.id, req.params.id, parse(userSchema, req.body))));
router.post('/admins', handler((req) => adminService.createAdmin(req.user.id, parse(adminSchema, req.body))));

const supplierLimiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });
router.get('/supplier/status', handler(() => adminService.getSupplierStatus()));
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
