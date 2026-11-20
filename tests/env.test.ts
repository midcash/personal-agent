import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {loadEnv, parseHostOptions} from '../durable_mvp/env.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(ROOT, 'durable_mvp/server.ts');
const ENV_ALLOWLIST = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'PATHEXT',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
]);

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

describe('parseHostOptions', () => {
  test('offline is the default mode and preserves valid ports', () => {
    assert.deepEqual(parseHostOptions([]), {mode: 'offline', data: undefined, port: 8765, nowFile: undefined});
    assert.deepEqual(parseHostOptions(['--port', '0']), {mode: 'offline', data: undefined, port: 0, nowFile: undefined});
  });

  test('deepseek mode is accepted in both spellings', () => {
    assert.equal(parseHostOptions(['--mode', 'deepseek']).mode, 'deepseek');
    assert.equal(parseHostOptions(['--mode=deepseek']).mode, 'deepseek');
    assert.deepEqual(parseHostOptions(['--mode', 'deepseek', '--port', '9000']), {
      mode: 'deepseek',
      data: undefined,
      port: 9000,
      nowFile: undefined,
    });
  });

  test('other arguments do not override or trigger deepseek, and later mode wins', () => {
    assert.equal(parseHostOptions(['--mode', 'offline', '--data', 'deepseek']).mode, 'offline');
    assert.equal(parseHostOptions(['--data', 'C:/stores/deepseek', '--mode', 'offline']).mode, 'offline');
    assert.equal(parseHostOptions(['--mode', 'deepseek', '--mode', 'offline']).mode, 'offline');
    assert.equal(parseHostOptions(['--mode=deepseek', '--mode=offline']).mode, 'offline');
  });

  test('rejects case-mismatched mode, dangling mode flag, invalid ports, and empty data path', () => {
    assert.throws(() => parseHostOptions(['--mode', 'DeepSeek']), /mode must be offline or deepseek/);
    assert.throws(() => parseHostOptions(['--mode']), /Option '--mode <value>' argument missing/);
    for (const badPort of [
      ['--port', '70000'],
      ['--port', 'abc'],
      ['--port', ''],
      ['--port', '   '],
      ['--port', '0x10'],
      ['--port', '-1'],
      ['--port=-1'],
    ]) {
      assert.throws(() => parseHostOptions(badPort), /Invalid port/);
    }
    for (const badData of [['--data', ''], ['--data', '   ']]) {
      assert.throws(() => parseHostOptions(badData), /Invalid data directory/);
    }
  });
});

describe('loadEnv', () => {
  test('parses BOM, comments, quotes, equals in value, and ignores non-allowlisted or empty keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
    try {
      const envFile = path.join(dir, '.env');
      fs.writeFileSync(
        envFile,
        '\uFEFF' +
          [
            '# comment',
            '',
            'INVALID_LINE_WITHOUT_EQUALS',
            'DEEPSEEK_API_KEY = "sk-abc=123" ',
            "DEEPSEEK_MODEL='deepseek-v4-pro'",
            'DEEPSEEK_BASE_URL=',
            'TUNIU_API_KEY=should-be-ignored',
            'AMAP_API_KEY=should-be-ignored',
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318',
            'UNLISTED_VAR=secret',
          ].join('\n'),
        'utf8',
      );
      const target: Record<string, string | undefined> = {DEEPSEEK_MODEL: 'preset-model'};
      loadEnv(envFile, target);
      assert.deepEqual(target, {
        DEEPSEEK_API_KEY: 'sk-abc=123',
        DEEPSEEK_MODEL: 'preset-model',
      });
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('missing file is a no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-missing-'));
    try {
      const target: Record<string, string | undefined> = {};
      loadEnv(path.join(dir, '.env'), target);
      assert.deepEqual(target, {});
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('server .env loading boundary', () => {
  test('deepseek mode reads .env from working directory while offline mode skips it completely', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-env-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.env'),
        'DEEPSEEK_API_KEY=sk-synthetic-test\nDEEPSEEK_MODEL=invalid-test-model\n',
        'utf8',
      );
      const preloadPath = path.join(dir, 'preload.mjs');
      fs.writeFileSync(
        preloadPath,
        [
          "import fs from 'node:fs';",
          "import {syncBuiltinESMExports} from 'node:module';",
          'const origRead = fs.readFileSync;',
          'fs.readFileSync = function(target, ...rest) {',
          "  if (String(target).endsWith('.env')) throw new Error('DOTENV_READ_INTERCEPTED');",
          '  return origRead.call(this, target, ...rest);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
        'utf8',
      );
      const preloadUrl = pathToFileURL(preloadPath).href;

      const intercepted = spawnSync(
        process.execPath,
        ['--import', preloadUrl, SERVER_PATH, '--mode', 'deepseek', '--data', path.join(dir, 'hook-store'), '--port', '0'],
        {cwd: dir, env: cleanEnv(), encoding: 'utf8'},
      );
      assert.notEqual(intercepted.status, 0);
      assert.ok(intercepted.stderr.includes('DOTENV_READ_INTERCEPTED'), intercepted.stderr);

      const realMode = spawnSync(
        process.execPath,
        [SERVER_PATH, '--mode', 'deepseek', '--data', path.join(dir, 'real-store'), '--port', '0'],
        {cwd: dir, env: cleanEnv(), encoding: 'utf8'},
      );
      assert.notEqual(realMode.status, 0);
      assert.ok(
        realMode.stderr.includes('DEEPSEEK_MODEL is not in the locked pi-ai catalog'),
        realMode.stderr,
      );
      assert.ok(!realMode.stderr.includes('Missing DEEPSEEK_API_KEY'), realMode.stderr);

      const proc = spawn(
        process.execPath,
        ['--import', preloadUrl, SERVER_PATH, '--mode', 'offline', '--data', path.join(dir, 'offline-store'), '--port', '0'],
        {cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe']},
      );
      const closed = new Promise<void>(resolve => proc.once('close', () => resolve()));
      let output = '';
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Offline startup timeout: ' + output)), 20000);
          proc.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes('DURABLE_MVP ')) {
              clearTimeout(timer);
              resolve();
            }
          });
          proc.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
          });
          proc.once('close', () => {
            clearTimeout(timer);
            reject(new Error('Offline host exited early: ' + output));
          });
        });
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill();
        await closed;
      }
      assert.ok(output.includes('DURABLE_MVP http://127.0.0.1:'), output);
      assert.ok(!output.includes('DOTENV_READ_INTERCEPTED'), output);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
