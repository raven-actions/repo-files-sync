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

import { configureTemplateAutoescape } from '../src/helpers.js';

describe('helpers.ts - configureTemplateAutoescape', () => {
  // Every other test file renders templates through the shared nunjucks
  // singleton, so always leave autoescape in its safe, default-on state.
  afterAll(() => {
    configureTemplateAutoescape(true);
  });

  it('HTML-escapes characters like single quotes by default', () => {
    configureTemplateAutoescape(true);

    expect(nunjucks.renderString('{{ value }}', { value: "it's" })).toBe('it&#39;s');
  });

  it('does not escape characters when disabled (e.g. for YAML/shell templates)', () => {
    configureTemplateAutoescape(false);

    expect(nunjucks.renderString('{{ value }}', { value: "it's" })).toBe("it's");
  });

  it('re-enabling restores escaping', () => {
    configureTemplateAutoescape(false);
    configureTemplateAutoescape(true);

    expect(nunjucks.renderString('{{ value }}', { value: '<b>' })).toBe('&lt;b&gt;');
  });
});
