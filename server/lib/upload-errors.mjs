// Multipart / upload error classification and byte-safe diagnostic truncation (security containment
// D0-2, rev 6; Astra CR5 findings 6 and 7). Pure functions, unit-tested directly by containment.test.mjs.
//
// Client-input multipart failures are recognised AT THE UPLOAD MIDDLEWARE BOUNDARY (multipartBoundary
// wraps each `upload.single(...)`), never by matching words in arbitrary error messages: a storage or
// system error whose message happens to contain "boundary" (an EIO on a staging path, an invariant
// error) stays internal. Recognised classes:
//   - Multer's own errors (name 'MulterError', code LIMIT_*): LIMIT_FILE_SIZE -> 413 (legacy body text),
//     every other limit -> 400 bad_upload;
//   - busboy's malformed-form errors (plain Error, no system code): 'Unexpected end of form',
//     'Malformed part header', 'Unexpected end of multipart data', 'Multipart: Boundary not found',
//     'Missing Content-Type' -> 400 bad_upload;
//   - Multer's request-lifecycle errors 'Request aborted' / 'Request closed' -> 400 bad_upload;
//   - busboy's parser-factory refusal 'Unsupported content type: ...' -> 400 bad_upload;
//   - the fileFilter refusal 'File type not allowed' -> 400 (legacy body text).
// Anything else (system errors carrying `code`/`syscall`/`errno`, errors with an explicit status, unknown
// messages) is NOT client input and is left for the internal path.
const BUSBOY_MESSAGES = new Set([
  'Unexpected end of form',
  'Malformed part header',
  'Unexpected end of multipart data',
  'Multipart: Boundary not found',
  'Missing Content-Type',
  'Request aborted',
  'Request closed',
]);

export function classifyMultipartError(err) {
  if (!err || typeof err !== 'object') return null;
  const code = typeof err.code === 'string' ? err.code : '';
  if (err.name === 'MulterError' || /^LIMIT_[A-Z_]+$/.test(code)) {
    if (code === 'LIMIT_FILE_SIZE') return { status: 413, error: 'File too large (max 100MB)' };
    return { status: 400, error: 'bad_upload' };
  }
  // A system error (EIO, ENOSPC, EACCES, ...) or an error that already carries a status is never
  // reclassified as client input here.
  if (code || err.syscall || typeof err.errno === 'number' || err.status || err.statusCode) return null;
  const message = typeof err.message === 'string' ? err.message : '';
  if (message === 'File type not allowed') return { status: 400, error: 'File type not allowed' };
  if (BUSBOY_MESSAGES.has(message)) return { status: 400, error: 'bad_upload' };
  // busboy's parser factory: a multipart subtype it does not handle (e.g. multipart/mixed) or a
  // Content-Type it cannot parse. Raised only inside the upload middleware, so tagging it there is safe.
  if (message.startsWith('Unsupported content type:') || message.startsWith('Missing Content-Type')) return { status: 400, error: 'bad_upload' };
  return null;
}

/** Wrap an upload middleware so a recognised client-input failure is TAGGED at its origin. */
export function multipartBoundary(mw) {
  return function multipartBoundaryMiddleware(req, res, next) {
    mw(req, res, (err) => {
      if (!err) return next();
      const cls = classifyMultipartError(err);
      if (cls) err.multipart = cls;
      next(err);
    });
  };
}

/**
 * Truncate a string to at most `maxBytes` of UTF-8 WITHOUT cutting a multi-byte character (a cut
 * sequence would decode to U+FFFD and add bytes back). Returns valid UTF-8 whose encoded length is
 * at most maxBytes.
 */
export function capUtf8(input, maxBytes) {
  const s = String(input);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) to the start of the character we would cut.
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}
