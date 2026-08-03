import rateLimit from 'express-rate-limit';

/** 10 verified webhook requests per minute; anything more is suspicious. */
export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests' },
});
