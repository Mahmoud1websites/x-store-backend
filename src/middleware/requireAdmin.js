function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      status: 'ERROR',
      code: 'ADMIN_REQUIRED',
      message: 'Administrator access is required',
    });
  }
  next();
}

module.exports = requireAdmin;
