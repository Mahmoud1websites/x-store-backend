require('dotenv').config();

process.env.NODE_ENV = 'production';
const { validateEnvironment } = require('../config/env');

try {
  validateEnvironment();
  console.log('Production environment check passed.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
