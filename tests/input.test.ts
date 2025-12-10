import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import {
  getInput,
  getOptionalInput,
  getBooleanInput,
  getArrayInput,
  getDisableableInput,
  getDisableableArrayInput
} from '../src/input.js';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  getMultilineInput: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

describe('input.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getInput (re-exported from @actions/core)', () => {
    it('should call core.getInput directly', () => {
      vi.mocked(core.getInput).mockReturnValue('test-value');

      const result = getInput('TEST_KEY');

      expect(result).toBe('test-value');
      expect(core.getInput).toHaveBeenCalledWith('TEST_KEY');
    });
  });

  describe('getOptionalInput', () => {
    it('should return value when provided', () => {
      vi.mocked(core.getInput).mockReturnValue('optional-value');

      const result = getOptionalInput('OPTIONAL_KEY', 'default');

      expect(result).toBe('optional-value');
    });

    it('should return default when input is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getOptionalInput('OPTIONAL_KEY', 'default-value');

      expect(result).toBe('default-value');
    });
  });

  describe('getBooleanInput', () => {
    it('should return default when input is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      expect(getBooleanInput('BOOL_KEY', true)).toBe(true);
      expect(getBooleanInput('BOOL_KEY', false)).toBe(false);
    });

    it('should call core.getBooleanInput when value is provided', () => {
      vi.mocked(core.getInput).mockReturnValue('true');
      vi.mocked(core.getBooleanInput).mockReturnValue(true);

      const result = getBooleanInput('BOOL_KEY', false);

      expect(result).toBe(true);
      expect(core.getBooleanInput).toHaveBeenCalledWith('BOOL_KEY');
    });

    it('should delegate to core.getBooleanInput for true values', () => {
      vi.mocked(core.getInput).mockReturnValue('TRUE');
      vi.mocked(core.getBooleanInput).mockReturnValue(true);

      const result = getBooleanInput('BOOL_KEY', false);

      expect(result).toBe(true);
    });

    it('should delegate to core.getBooleanInput for false values', () => {
      vi.mocked(core.getInput).mockReturnValue('false');
      vi.mocked(core.getBooleanInput).mockReturnValue(false);

      const result = getBooleanInput('BOOL_KEY', true);

      expect(result).toBe(false);
    });
  });

  describe('getArrayInput', () => {
    it('should parse comma-separated values', () => {
      vi.mocked(core.getInput).mockReturnValue('item1, item2, item3');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should parse newline-separated values', () => {
      vi.mocked(core.getInput).mockReturnValue('item1\nitem2\nitem3');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should parse mixed comma and newline separated values', () => {
      vi.mocked(core.getInput).mockReturnValue('item1, item2\nitem3, item4');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    it('should filter empty items', () => {
      vi.mocked(core.getInput).mockReturnValue('item1,,item2,  ,item3');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should trim whitespace from items', () => {
      vi.mocked(core.getInput).mockReturnValue('  item1  ,  item2  ');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['item1', 'item2']);
    });

    it('should return undefined when input is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toBeUndefined();
    });
  });

  describe('getDisableableInput', () => {
    it.each([
      ['false', undefined],
      ['FALSE', undefined],
      ['0', undefined],
      ['no', undefined],
      ['NO', undefined]
    ])('should return undefined for disabled value "%s"', (input) => {
      vi.mocked(core.getInput).mockReturnValue(input);

      const result = getDisableableInput('DISABLE_KEY', 'default');

      expect(result).toBeUndefined();
    });

    it('should return default value for empty string', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getDisableableInput('DISABLE_KEY', 'default');

      expect(result).toBe('default');
    });

    it('should return value when not disabled', () => {
      vi.mocked(core.getInput).mockReturnValue('actual-value');

      const result = getDisableableInput('DISABLE_KEY', 'default');

      expect(result).toBe('actual-value');
    });

    it('should support false as default value', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getDisableableInput('DISABLE_KEY', false);

      expect(result).toBe(false);
    });
  });

  describe('getDisableableArrayInput', () => {
    it.each([
      ['false', undefined],
      ['FALSE', undefined],
      ['0', undefined],
      ['no', undefined],
      ['NO', undefined]
    ])('should return undefined for disabled value "%s"', (input) => {
      vi.mocked(core.getInput).mockReturnValue(input);

      const result = getDisableableArrayInput('ARRAY_KEY', ['default']);

      expect(result).toBeUndefined();
    });

    it('should return default array when input is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getDisableableArrayInput('ARRAY_KEY', ['default1', 'default2']);

      expect(result).toEqual(['default1', 'default2']);
    });

    it('should parse array when not disabled', () => {
      vi.mocked(core.getInput).mockReturnValue('item1, item2');

      const result = getDisableableArrayInput('ARRAY_KEY', ['default']);

      expect(result).toEqual(['item1', 'item2']);
    });

    it('should parse newline-separated values', () => {
      vi.mocked(core.getInput).mockReturnValue('item1\nitem2\nitem3');

      const result = getDisableableArrayInput('ARRAY_KEY', []);

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should filter empty items', () => {
      vi.mocked(core.getInput).mockReturnValue('item1,,item2,  ,item3');

      const result = getDisableableArrayInput('ARRAY_KEY', []);

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });
  });
});
