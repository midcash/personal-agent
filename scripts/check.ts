import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export const REQUIRED_RUNTIME_FILES = [
  'durable_mvp/server.ts',
  'durable_mvp/calendar.ts',
] as const;

export const REFERENCE_PREFIXES = [
  'docs/',
  'durable_mvp/',
  'scripts/',
  'tests/',
  'travel_agent/',
  'verification/',
] as const;

function isFile(target: string): boolean {
  return fs.existsSync(target) && fs.statSync(target).isFile();
}

function isRepoReference(token: string): boolean {
  if (!token) return false;
  if (token.startsWith('http://') || token.startsWith('https://') || token.startsWith('mailto:')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(token) || token.includes('\\')) return false;
  return REFERENCE_PREFIXES.some(prefix => token.startsWith(prefix));
}

function readmeReferences(text: string): string[] {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const rawTokens: string[] = [];
  for (const match of withoutFences.matchAll(/\]\(([^)\s]+)\)/g)) rawTokens.push(match[1]);
  for (const match of withoutFences.matchAll(/`([^`]+)`/g)) rawTokens.push(match[1]);

  const tokens: string[] = [];
  for (const raw of rawTokens) {
    const token = raw.split(/[#?]/, 1)[0].trim();
    if (isRepoReference(token)) tokens.push(token);
  }
  return tokens;
}

/** Return repository/documentation drift problems found under root. */
export function findProblems(root = ROOT): string[] {
  const problems: string[] = [];

  for (const rel of REQUIRED_RUNTIME_FILES) {
    if (!isFile(path.join(root, rel))) {
      problems.push(`required runtime file missing: ${rel}`);
    }
  }

  const readmePath = path.join(root, 'README.md');
  if (!isFile(readmePath)) {
    problems.push('README.md missing');
    return problems;
  }

  const readmeText = fs.readFileSync(readmePath, 'utf8').replace(/^\uFEFF/, '');
  const checked = new Set<string>();
  for (const token of readmeReferences(readmeText)) {
    if (checked.has(token)) continue;
    checked.add(token);
    if (!fs.existsSync(path.join(root, token))) {
      problems.push(`README references missing path: ${token}`);
    }
  }
  return problems;
}

/** Report documentation/repository drift problems; return failure count. */
export function checkDocs(root = ROOT): number {
  const problems = findProblems(root);
  for (const problem of problems) console.log('[docs-check] FAIL: ' + problem);
  return problems.length;
}

function listTestFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => path.join(dir, name));
}

function runNode(args: string[]): number {
  console.log('Running: ' + [process.execPath, ...args].join(' '));
  const result = spawnSync(process.execPath, args, {cwd: ROOT, stdio: 'inherit'});
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(): number {
  const docProblems = checkDocs();
  if (docProblems) {
    console.log(`[docs-check] ${docProblems} documentation/repository drift error(s)`);
    return 1;
  }

  const tscBin = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  const testFiles = [
    ...listTestFiles(path.join(ROOT, 'tests')),
    ...listTestFiles(path.join(ROOT, 'verification/durable-mvp')),
  ];
  if (!testFiles.length) throw new Error('No test files discovered');

  const steps: string[][] = [
    [tscBin, '-p', 'tsconfig.json'],
    [tscBin, '-p', 'durable_mvp/tsconfig.web.json'],
    ['--test', ...testFiles],
  ];
  for (const args of steps) {
    const status = runNode(args);
    if (status !== 0) return status;
  }
  return 0;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const actual = fs.realpathSync(process.argv[1]);
  const current = fs.realpathSync(import.meta.filename);
  return process.platform === 'win32'
    ? actual.toLowerCase() === current.toLowerCase()
    : actual === current;
}

if (isMainModule()) {
  process.exitCode = main();
}
