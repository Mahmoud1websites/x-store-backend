require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');

const { validateEnvironment } = require('./config/env');
validateEnvironment();

const authRouter = require('./routes/auth');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
const categoriesRouter = require('./routes/categories');
const settingsRouter = require('./routes/settings');
const walletRouter = require('./routes/wallet');
const notificationsRouter = require('./routes/notifications');
const requireAuth = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');
const { startOrderStatusPoller } = require('./jobs/orderStatusPoller');
const supplierApi = require('./services/supplierApi');
const operationsService = require('./services/operationsService');

const app = express();
app.set('trust proxy', 1);









const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin(origin, callback) {
      // Native applications and server-to-server calls do not send Origin.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(Object.assign(new Error('Origin is not allowed by CORS'), { status: 403 }));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.get('/health', (req, res) => res.json({
  status: 'OK',
  service: 'x-store-backend',
  time: new Date().toISOString(),
  request_id: req.id,
}));

// Quick sanity-check route: confirms your token/connection to the
// supplier actually works. Hit this first after setting up .env.
app.get('/api/supplier/profile', requireAuth, requireAdmin, async (req, res) => {
  try {
    const profile = await supplierApi.getProfile();
    res.json({ status: 'OK', data: profile });
  } catch (err) {
    res.status(502).json({ status: 'ERROR', code: err.code, message: err.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/admin', adminRouter);

app.use((req, res) => {
  res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: 'Route not found' });
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    operationsService.log({
      level: 'error',
      source: 'express',
      code: err.code || 'SERVER_ERROR',
      message: err.message,
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: status,
    }).catch(() => undefined);
  }
  res.status(err.status || 500).json({
    status: 'ERROR',
    code: err.code || 'SERVER_ERROR',
    message: err.status && err.status < 500 ? err.message : 'Unexpected server error',
    request_id: req.id,
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startOrderStatusPoller();
  });
}

module.exports = app;
