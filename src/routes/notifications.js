const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const notifications = require('../services/notificationService');
const pushService = require('../services/pushService');

const router = express.Router();
router.use(requireAuth);

function handler(action) {
  return async (req, res, next) => {
    try {
      res.json({ status: 'OK', data: await action(req) });
    } catch (error) {
      next(error);
    }
  };
}

router.get('/', handler((req) =>
  notifications.listForUser(req.user.id, {
    limit: req.query.limit,
    unreadOnly: req.query.unread === 'true',
  })
));
router.get('/summary', handler((req) => notifications.summary(req.user.id)));
router.post('/push-token', handler((req) =>
  pushService.register(req.user.id, req.body?.token, req.body?.platform)
));
router.delete('/push-token', handler((req) =>
  pushService.unregister(req.user.id, req.body?.token)
));
router.patch('/read-all', handler((req) => notifications.markAllRead(req.user.id)));
router.patch('/:id/read', handler((req) => notifications.markRead(req.user.id, req.params.id)));

module.exports = router;
