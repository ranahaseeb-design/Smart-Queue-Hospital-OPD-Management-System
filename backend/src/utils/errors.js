'use strict';
/**
 * API error type and helpers. Every error response has the contract shape
 * { error: { code, message } }.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You do not have permission to perform this action') =>
  new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = 'Resource not found') => new ApiError(404, 'NOT_FOUND', message);
const conflict = (message) => new ApiError(409, 'CONFLICT', message);
const aiUnavailable = (message = 'The AI service is unavailable') => new ApiError(503, 'AI_UNAVAILABLE', message);

/** Wrap an async express handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch(next);
};

/**
 * Express router whose get/post/put/delete wrap every handler with asyncHandler.
 */
function createRouter() {
  const express = require('express');
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map((h) => asyncHandler(h)));
  }
  return router;
}

/**
 * True when a DB error is a unique-constraint violation: MongoDB duplicate key E11000 (also inside
 * bulk-write errors). The error middleware answers it with 409 CONFLICT.
 */
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === 11000 || err.code === 11001) return true;
  if (Array.isArray(err.writeErrors) && err.writeErrors.some((e) => e && (e.code === 11000 || (e.err && e.err.code === 11000)))) {
    return true;
  }
  return Boolean(err.cause && err.cause !== err && isUniqueViolation(err.cause));
}

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  aiUnavailable,
  asyncHandler,
  createRouter,
  isUniqueViolation,
};
