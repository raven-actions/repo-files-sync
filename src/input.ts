import * as core from '@actions/core';

// Re-export native function for direct use
export { getInput } from '@actions/core';

/**
 * Get a boolean input with a default value.
 * Unlike core.getBooleanInput, this doesn't throw when input is empty.
 */
export function getBooleanInput(key: string, defaultValue: boolean): boolean {
  const value = core.getInput(key);
  if (value === '') {
    return defaultValue;
  }
  // Use native getBooleanInput for validation (throws on invalid values)
  return core.getBooleanInput(key);
}

/**
 * Get an optional string input with a default value.
 */
export function getOptionalInput(key: string, defaultValue: string): string {
  const value = core.getInput(key);
  return value || defaultValue;
}

/**
 * Get an array input (comma or newline separated).
 * Builds on core.getMultilineInput (newline split + per-line trim) and
 * additionally splits each line on commas.
 */
export function getArrayInput(key: string): string[] | undefined {
  const items = core
    .getMultilineInput(key)
    .flatMap((line) => line.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

/**
 * Check if value represents a disabled state
 */
function isDisabled(value: string): boolean {
  const lowered = value.toLowerCase().trim();
  return lowered === 'false' || lowered === '0' || lowered === 'no';
}

/**
 * Get an input that can be disabled with 'false'.
 * Returns undefined when explicitly disabled, the value when provided, or default otherwise.
 */
export function getDisableableInput(key: string, defaultValue: string | false): string | false | undefined {
  const value = core.getInput(key);
  if (value === '') {
    return defaultValue;
  }
  if (isDisabled(value)) {
    return undefined;
  }
  return value;
}

/**
 * Get an array input that can be disabled with 'false'.
 */
export function getDisableableArrayInput(key: string, defaultValue: string[]): string[] | undefined {
  const value = core.getInput(key);
  if (value === '') {
    return defaultValue;
  }
  if (isDisabled(value)) {
    return undefined;
  }
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
