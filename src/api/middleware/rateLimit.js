import rateLimit from 'express-rate-limit';
import config from '../../config/index.js';

export const apiLimiter = rateLimit({
  windowMs: config.api.rateLimitWindowMs,
  max: config.api.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

export default apiLimiter;
