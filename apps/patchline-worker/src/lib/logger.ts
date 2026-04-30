/**
 * Structured logger. Cloudflare's observability captures console output verbatim,
 * so we emit single-line JSON for queryability.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  request_id?: string;
  site_slug?: string;
  site_id?: string;
  event?: string;
  [k: string]: unknown;
}

function emit(level: Level, msg: string, fields: LogFields = {}, err?: unknown) {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  if (err !== undefined) {
    payload.error = err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : { value: String(err) };
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields, err?: unknown) => emit('warn', msg, fields, err),
  error: (msg: string, fields?: LogFields, err?: unknown) => emit('error', msg, fields, err),
};
