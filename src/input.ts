import * as core from '@actions/core';

/**
 * Possible input value types
 */
export type InputValue = string | boolean | string[] | undefined;

/**
 * Options for getInput function
 */
export interface InputOptions {
  /** The input key name */
  key: string;
  /** The type of the input: 'string' | 'boolean' | 'array' */
  type?: 'string' | 'boolean' | 'array';
  /** Whether the input is required */
  required?: boolean;
  /** Default value if input is not provided */
  default?: InputValue;
  /** Whether the input can be disabled with 'false' */
  disableable?: boolean;
}

/**
 * Parse a string value to boolean
 */
function parseBoolean(value: string): boolean {
  const lowered = value.toLowerCase().trim();
  return lowered === 'true' || lowered === '1' || lowered === 'yes';
}

/**
 * Parse a string value to array (comma or newline separated)
 */
function parseArray(value: string): string[] {
  // Handle both comma-separated and newline-separated values
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Check if value represents a disabled state
 */
function isDisabled(value: string): boolean {
  const lowered = value.toLowerCase().trim();
  return lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === '';
}

/**
 * Get and parse an action input with type conversion and defaults
 *
 * This is a simplified replacement for action-input-parser that uses @actions/core
 */
export function getInput(options: InputOptions): InputValue {
  const { key, type = 'string', required = false, disableable = false } = options;
  const defaultValue = options.default;

  // Get raw input value from GitHub Actions
  const rawValue = core.getInput(key, { required: false });

  // Handle empty/missing input
  if (rawValue === '') {
    if (required) {
      throw new Error(`Input '${key}' is required but was not provided`);
    }
    return defaultValue;
  }

  // Handle disableable inputs (can return undefined when explicitly disabled)
  if (disableable && isDisabled(rawValue)) {
    return undefined;
  }

  // Parse based on type
  switch (type) {
    case 'boolean':
      return parseBoolean(rawValue);

    case 'array':
      return parseArray(rawValue);

    case 'string':
    default:
      return rawValue;
  }
}

/**
 * Get a required string input
 */
export function getRequiredInput(key: string): string {
  const value = core.getInput(key, { required: true });
  if (!value) {
    throw new Error(`Input '${key}' is required but was not provided`);
  }
  return value;
}

/**
 * Get an optional string input with a default value
 */
export function getOptionalInput(key: string, defaultValue: string): string {
  const value = core.getInput(key, { required: false });
  return value || defaultValue;
}

/**
 * Get a boolean input
 */
export function getBooleanInput(key: string, defaultValue: boolean): boolean {
  const value = core.getInput(key, { required: false });
  if (value === '') {
    return defaultValue;
  }
  return parseBoolean(value);
}

/**
 * Get an array input (comma or newline separated)
 */
export function getArrayInput(key: string, defaultValue?: string[]): string[] | undefined {
  const value = core.getInput(key, { required: false });
  if (value === '') {
    return defaultValue;
  }
  return parseArray(value);
}
