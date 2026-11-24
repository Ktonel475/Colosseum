/** Application-level error with an HTTP status hint. */
export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 422, code: 'VALIDATION_ERROR', details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { status: 404, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, { status: 409, code: 'CONFLICT' });
    this.name = 'ConflictError';
  }
}
