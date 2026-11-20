import fs from 'node:fs';
import {parseArgs} from 'node:util';

export const ALLOWED_ENV_KEYS = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
]);

export interface HostOptions {
  mode: 'offline' | 'deepseek';
  data?: string;
  port: number;
  nowFile?: string;
}

/** Parse and validate server CLI flags without touching the environment. */
export function parseHostOptions(argv: readonly string[] = process.argv.slice(2)): HostOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        mode: {type: 'string', default: 'offline'},
        data: {type: 'string'},
        port: {type: 'string', default: '8765'},
        'now-file': {type: 'string'},
      },
    });
  } catch (error) {
    // parseArgs rejects dash-prefixed separate values before returning values.port.
    if (error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' &&
      error.message.startsWith("Option '--port' argument is ambiguous.")) {
      throw new Error('Invalid port');
    }
    throw error;
  }
  const {values} = parsed;
  if (values.mode !== 'offline' && values.mode !== 'deepseek') {
    throw new Error('mode must be offline or deepseek');
  }
  if (!/^\d+$/.test(values.port)) throw new Error('Invalid port');
  const port = Number(values.port);
  if (port > 65535) throw new Error('Invalid port');
  if (values.data !== undefined && !values.data.trim()) throw new Error('Invalid data directory');
  return {mode: values.mode, data: values.data, port, nowFile: values['now-file']};
}

/** Literal .env loader: no shell expansion, execution, or logging. */
export function loadEnv(
  filePath = '.env',
  env: Record<string, string | undefined> = process.env,
): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === "'" || value[0] === '"')
    ) {
      value = value.slice(1, -1);
    }
    if (ALLOWED_ENV_KEYS.has(key) && value && env[key] === undefined) {
      env[key] = value;
    }
  }
}
