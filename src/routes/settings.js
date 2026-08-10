const express = require('express');
const adminService = require('../services/adminService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const settings = await adminService.getPublicSettings();
    res.json({ status: 'OK', data: settings });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
