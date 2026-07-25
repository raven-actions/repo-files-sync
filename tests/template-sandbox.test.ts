import { describe, it, expect, vi, afterAll } from 'vitest';
import nunjucks from 'nunjucks';

// Mock @actions/core before importing helpers (same convention as helpers.test.ts)
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

import { configureTemplateSandbox } from '../src/helpers.js';

describe('helpers.ts - configureTemplateSandbox', () => {
  // Every other test file renders templates through the shared nunjucks
  // singleton, so always leave the sandbox in its safe, default-on state.
  afterAll(() => {
    configureTemplateSandbox(true);
  });

  it('blocks constructor property access when enabled', () => {
    configureTemplateSandbox(true);

    expect(nunjucks.renderString('{{ "".constructor }}', {})).toBe('');
    expect(nunjucks.renderString('{{ range.constructor }}', {})).toBe('');
  });

  it('blocks __proto__ and prototype property access when enabled', () => {
    configureTemplateSandbox(true);

    expect(nunjucks.renderString('{{ "".__proto__ }}', {})).toBe('');
    expect(nunjucks.renderString('{{ "".constructor.prototype }}', {})).toBe('');
  });

  it('renders the classic constructor-chain payload harmlessly instead of executing it', () => {
    configureTemplateSandbox(true);

    // Without the guard this would evaluate "return 1+1" as a function body
    // (see the "disabled" test below) - blocked here, calling the resulting
    // `undefined` throws instead of running arbitrary code.
    expect(() => nunjucks.renderString('{{ "".constructor.constructor("return 1+1")() }}', {})).toThrow();
  });

  it('does not affect normal variable/attribute access when enabled', () => {
    configureTemplateSandbox(true);

    expect(nunjucks.renderString('{{ user.name }}', { user: { name: 'Ada' } })).toBe('Ada');
    expect(nunjucks.renderString('{{ range(1, 4) | join(",") }}', {})).toBe('1,2,3');
  });

  it('allows the constructor-chain payload to execute when disabled (proves the toggle is real)', () => {
    configureTemplateSandbox(false);

    expect(nunjucks.renderString('{{ "".constructor.constructor("return 1+1")() }}', {})).toBe('2');
  });

  it('is idempotent when enabled/disabled repeatedly', () => {
    configureTemplateSandbox(true);
    configureTemplateSandbox(true);
    expect(nunjucks.renderString('{{ "".constructor }}', {})).toBe('');

    configureTemplateSandbox(false);
    configureTemplateSandbox(false);
    expect(nunjucks.renderString('{{ "".constructor.constructor("return 3+4")() }}', {})).toBe('7');
  });
});
