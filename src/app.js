require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const authRouter = require('./routes/auth');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
const categoriesRouter = require('./routes/categories');
const settingsRouter = require('./routes/settings');
const walletRouter = require('./routes/wallet');
const requireAuth = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');
const { startOrderStatusPoller } = require('./jobs/orderStatusPoller');
const supplierApi = require('./services/supplierApi');

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:4173,http://127.0.0.1:4173')
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

app.get('/health', (req, res) => res.json({ status: 'OK' }));

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
app.use('/api/admin', adminRouter);

app.use((req, res) => {
  res.status(404).json({ status: 'ERROR', code: 'NOT_FOUND', message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('[api]', err);
  res.status(err.status || 500).json({
    status: 'ERROR',
    code: err.code || 'SERVER_ERROR',
    message: err.status && err.status < 500 ? err.message : 'Unexpected server error',
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
