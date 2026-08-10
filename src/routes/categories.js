const express = require('express');
const adminService = require('../services/adminService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const categories = await adminService.listCategories({ publicOnly: true });
    res.json({ status: 'OK', data: categories });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
