import { t } from './i18n.js';

/** Application-level error with an HTTP status hint and optional i18n metadata. */
export class AppError extends Error {
  constructor(
    message,
    { status = 400, code = 'BAD_REQUEST', details, i18nKey, i18nParams } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.i18nKey = i18nKey;
    this.i18nParams = i18nParams;
  }
}

export class ValidationError extends AppError {
  constructor(message, details, options = {}) {
    super(message, { status: 422, code: 'VALIDATION_ERROR', details, ...options });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', options = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', ...options });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', options = {}) {
    super(message, { status: 409, code: 'CONFLICT', ...options });
    this.name = 'ConflictError';
  }
}

/**
 * Resolve a user-facing error message. Errors raised by services carry an
 * `i18nKey` so the bot can answer in the user's language while the original
 * English `message` remains available for logs, tests and the REST API.
 */
export function errorMessage(locale, err) {
  if (err?.i18nKey) return t(locale, err.i18nKey, err.i18nParams);
  return err?.message ?? t(locale, 'common.unexpected_error');
}
