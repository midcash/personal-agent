import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {findProblems} from '../scripts/check.ts';

describe('docs-check', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function write(rel: string, text: string) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, text, 'utf8');
  }

  test('missing runtime file is reported', () => {
    write('README.md', '# fake\n');
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    const problems = findProblems(root);
    assert.ok(problems.some(p => p.includes('calendar.ts')), String(problems));
  });

  test('all runtime files present is green', () => {
    write('README.md', '# fake\n');
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    assert.deepEqual(findProblems(root), []);
  });

  test('missing README references are reported including stale travel_agent paths', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write('README.md', 'see `docs/ghost.md` and [legacy](travel_agent/real_tools.py)\n');
    const problems = findProblems(root);
    assert.ok(problems.some(p => p.includes('docs/ghost.md')), String(problems));
    assert.ok(problems.some(p => p.includes('travel_agent/real_tools.py')), String(problems));
  });

  test('valid README reference is green', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write('docs/product-behavior.md', '# pb\n');
    write('README.md', 'see [x](docs/product-behavior.md)\n');
    assert.deepEqual(findProblems(root), []);
  });

  test('reference with anchor and query is stripped', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write('docs/product-behavior.md', '# pb\n');
    write('README.md', 'see [a](docs/product-behavior.md#S01) and [b](docs/product-behavior.md?x=1)\n');
    assert.deepEqual(findProblems(root), []);
  });

  test('anchor to missing file is still reported', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write('README.md', 'see [a](docs/ghost.md#nope)\n');
    const problems = findProblems(root);
    assert.ok(problems.some(p => p.includes('docs/ghost.md')), String(problems));
  });

  test('reference after fenced block with odd backtick is still detected', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write('README.md', 'before\n```\ncode with ` stray backtick\n```\nsee `docs/ghost.md` here\n');
    const problems = findProblems(root);
    assert.ok(problems.some(p => p.includes('docs/ghost.md')), String(problems));
  });

  test('fenced block contents, URLs, and Windows drive paths are ignored', () => {
    write('durable_mvp/server.ts', "import './calendar.ts'\n");
    write('durable_mvp/calendar.ts', 'export {}\n');
    write(
      'README.md',
      '```\nsee docs/does-not-exist.md\n```\n' +
        'Visit [site](https://example.com/docs/x) or `C:/path/to/docs/store`.\n',
    );
    assert.deepEqual(findProblems(root), []);
  });
});
