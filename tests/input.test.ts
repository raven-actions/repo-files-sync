import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as core from '@actions/core';
import {
  getInput,
  getRequiredInput,
  getOptionalInput,
  getBooleanInput,
  getArrayInput
} from '../src/input.js';

// Mock @actions/core
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

describe('input.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getInput', () => {
    describe('string type (default)', () => {
      it('should return string value when provided', () => {
        vi.mocked(core.getInput).mockReturnValue('test-value');

        const result = getInput({ key: 'TEST_KEY' });

        expect(result).toBe('test-value');
        expect(core.getInput).toHaveBeenCalledWith('TEST_KEY', { required: false });
      });

      it('should return default value when input is empty', () => {
        vi.mocked(core.getInput).mockReturnValue('');

        const result = getInput({ key: 'TEST_KEY', default: 'default-value' });

        expect(result).toBe('default-value');
      });

      it('should return undefined when input is empty and no default', () => {
        vi.mocked(core.getInput).mockReturnValue('');

        const result = getInput({ key: 'TEST_KEY' });

        expect(result).toBeUndefined();
      });

      it('should throw error when required input is missing', () => {
        vi.mocked(core.getInput).mockReturnValue('');

        expect(() => getInput({ key: 'REQUIRED_KEY', required: true })).toThrow(
          "Input 'REQUIRED_KEY' is required but was not provided"
        );
      });
    });

    describe('boolean type', () => {
      it.each([
        ['true', true],
        ['TRUE', true],
        ['True', true],
        ['1', true],
        ['yes', true],
        ['YES', true],
        ['false', false],
        ['FALSE', false],
        ['0', false],
        ['no', false],
        ['random', false],
        ['', undefined] // empty returns default
      ])('should parse "%s" as %s', (input, expected) => {
        vi.mocked(core.getInput).mockReturnValue(input);

        const result = getInput({ key: 'BOOL_KEY', type: 'boolean', default: undefined });

        if (input === '') {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBe(expected);
        }
      });

      it('should return default boolean when input is empty', () => {
        vi.mocked(core.getInput).mockReturnValue('');

        const result = getInput({ key: 'BOOL_KEY', type: 'boolean', default: true });

        expect(result).toBe(true);
      });
    });

    describe('array type', () => {
      it('should parse comma-separated values', () => {
        vi.mocked(core.getInput).mockReturnValue('item1, item2, item3');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array' });

        expect(result).toEqual(['item1', 'item2', 'item3']);
      });

      it('should parse newline-separated values', () => {
        vi.mocked(core.getInput).mockReturnValue('item1\nitem2\nitem3');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array' });

        expect(result).toEqual(['item1', 'item2', 'item3']);
      });

      it('should parse mixed comma and newline separated values', () => {
        vi.mocked(core.getInput).mockReturnValue('item1, item2\nitem3, item4');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array' });

        expect(result).toEqual(['item1', 'item2', 'item3', 'item4']);
      });

      it('should filter empty items', () => {
        vi.mocked(core.getInput).mockReturnValue('item1,,item2,  ,item3');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array' });

        expect(result).toEqual(['item1', 'item2', 'item3']);
      });

      it('should trim whitespace from items', () => {
        vi.mocked(core.getInput).mockReturnValue('  item1  ,  item2  ');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array' });

        expect(result).toEqual(['item1', 'item2']);
      });

      it('should return default array when input is empty', () => {
        vi.mocked(core.getInput).mockReturnValue('');

        const result = getInput({ key: 'ARRAY_KEY', type: 'array', default: ['default1', 'default2'] });

        expect(result).toEqual(['default1', 'default2']);
      });
    });

    describe('disableable inputs', () => {
      it.each([
        ['false', undefined],
        ['FALSE', undefined],
        ['0', undefined],
        ['no', undefined],
        ['NO', undefined]
      ])('should return undefined for disabled value "%s"', (input, expected) => {
        vi.mocked(core.getInput).mockReturnValue(input);

        const result = getInput({ key: 'DISABLE_KEY', disableable: true, default: 'default' });

        expect(result).toBe(expected);
      });

      it('should return default value for empty string (not treated as disabled)', () => {
        // Empty string goes through the "empty/missing input" path, returning default
        vi.mocked(core.getInput).mockReturnValue('');

        const result = getInput({ key: 'DISABLE_KEY', disableable: true, default: 'default' });

        expect(result).toBe('default');
      });

      it('should return value when not disabled', () => {
        vi.mocked(core.getInput).mockReturnValue('actual-value');

        const result = getInput({ key: 'DISABLE_KEY', disableable: true, default: 'default' });

        expect(result).toBe('actual-value');
      });

      it('should work with array type and disableable', () => {
        vi.mocked(core.getInput).mockReturnValue('false');

        const result = getInput({
          key: 'ARRAY_KEY',
          type: 'array',
          disableable: true,
          default: ['default']
        });

        expect(result).toBeUndefined();
      });
    });
  });

  describe('getRequiredInput', () => {
    it('should return value when provided', () => {
      vi.mocked(core.getInput).mockReturnValue('required-value');

      const result = getRequiredInput('REQUIRED_KEY');

      expect(result).toBe('required-value');
      expect(core.getInput).toHaveBeenCalledWith('REQUIRED_KEY', { required: true });
    });

    it('should throw error when value is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      expect(() => getRequiredInput('REQUIRED_KEY')).toThrow(
        "Input 'REQUIRED_KEY' is required but was not provided"
      );
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
    it.each([
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false]
    ])('should parse "%s" as %s', (input, expected) => {
      vi.mocked(core.getInput).mockReturnValue(input);

      const result = getBooleanInput('BOOL_KEY', false);

      expect(result).toBe(expected);
    });

    it('should return default when input is empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      expect(getBooleanInput('BOOL_KEY', true)).toBe(true);
      expect(getBooleanInput('BOOL_KEY', false)).toBe(false);
    });
  });

  describe('getArrayInput', () => {
    it('should parse array correctly', () => {
      vi.mocked(core.getInput).mockReturnValue('a, b, c');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should return default array when empty', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getArrayInput('ARRAY_KEY', ['x', 'y']);

      expect(result).toEqual(['x', 'y']);
    });

    it('should return undefined when empty and no default', () => {
      vi.mocked(core.getInput).mockReturnValue('');

      const result = getArrayInput('ARRAY_KEY');

      expect(result).toBeUndefined();
    });
  });
});
