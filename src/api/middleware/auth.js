import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * Bearer-token authentication for protected endpoints.
 */
export function requireApiKey(req, res, next) {
  if (!config.api.authSecret) {
    logger.error('API_AUTH_SECRET is not configured; refusing protected request');
    return res.status(503).json({ error: 'API authentication is not configured' });
  }
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || token !== config.api.authSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

export default requireApiKey;
