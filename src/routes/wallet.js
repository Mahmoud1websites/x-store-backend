const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/requireAuth');
const walletService = require('../services/walletService');

const router = express.Router();
router.use(requireAuth);

const createSchema = z.object({
  amount_usd: z.coerce.number().min(1).max(1000),
  customer_note: z.string().trim().max(300).optional().default(''),
});

router.get('/topups', async (req, res, next) => {
  try {
    res.json({ status: 'OK', data: await walletService.listForUser(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.post('/topups', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        status: 'ERROR',
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues.map((issue) => issue.message).join(', '),
      });
    }
    const data = await walletService.createForUser(req.user, parsed.data);
    res.status(data.reused ? 200 : 201).json({ status: 'OK', data });
  } catch (error) {
    next(error);
  }
});

router.patch('/topups/:id/cancel', async (req, res, next) => {
  try {
    const data = await walletService.cancelForUser(req.user.id, req.params.id);
    res.json({ status: 'OK', data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
