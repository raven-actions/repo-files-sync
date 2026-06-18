/**
 * Schema conformance tests.
 *
 * `sync.schema.json` is a hand-written mirror of what the parser in
 * `src/config.ts` accepts. These tests are the automated guard that keeps the
 * two in sync:
 *  - the schema must be a valid JSON Schema and its own examples must pass;
 *  - representative valid configs must validate, invalid ones must be rejected;
 *  - the option keys documented by the schema must match exactly the keys the
 *    parser accepts (FILE_CONFIG_KEYS / GROUP_KEYS, which are derived from the
 *    parser interfaces). Add a field to the parser and this test fails until the
 *    schema is updated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';

import { FILE_CONFIG_KEYS, GROUP_KEYS } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../sync.schema.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as any;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

describe('sync.schema.json', () => {
  it('is a valid JSON Schema that compiles', () => {
    expect(typeof validate).toBe('function');
  });

  describe('self-documented examples', () => {
    const examples = (schema.examples ?? []) as unknown[];

    it('declares at least one example', () => {
      expect(examples.length).toBeGreaterThan(0);
    });

    examples.forEach((example, index) => {
      it(`example #${index} validates against the schema`, () => {
        const valid = validate(example);
        // Surface the offending errors in the failure message if any.
        expect(validate.errors ?? []).toEqual([]);
        expect(valid).toBe(true);
      });
    });
  });

  describe('valid configurations are accepted', () => {
    const validConfigs: Record<string, unknown[]> = {
      'repo-keyed simple file list': [{ 'owner/repo': ['LICENSE', '.github/workflows/ci.yml'] }],
      'repo with branch and detailed file': [{ 'owner/repo@main': [{ source: 'src/', dest: 'lib/', deleteOrphaned: true }] }],
      'template boolean': [{ 'owner/repo': [{ source: 't/README.md', dest: 'README.md', template: true }] }],
      'template object': [{ 'owner/repo': [{ source: 'c.json', dest: 'c.json', template: { appName: 'X', version: '1.0.0' } }] }],
      'include and exclude': [{ 'owner/repo': [{ source: 'src/', dest: 'lib/', exclude: 'node_modules\n*.log', include: '**/*.ts' }] }],
      'replace false': [{ 'owner/repo': [{ source: 'c.json', replace: false }] }],
      'single group': [{ group: { repos: 'o/r1\no/r2', files: ['LICENSE'] } }],
      'group array with reviewers and branchSuffix': [
        {
          group: [
            { repos: ['o/r1', 'o/r2'], files: ['LICENSE'], reviewers: ['a', 'b'] },
            { repos: ['o/r3'], files: ['.gitignore'], branchSuffix: 'gi' }
          ]
        }
      ],
      'custom host URL key': [{ 'https://github.example.com/owner/repo@main': ['LICENSE'] }]
    };

    Object.entries(validConfigs).forEach(([name, [config]]) => {
      it(name, () => {
        const valid = validate(config);
        expect(validate.errors ?? []).toEqual([]);
        expect(valid).toBe(true);
      });
    });
  });

  describe('invalid configurations are rejected', () => {
    const invalidConfigs: Record<string, unknown[]> = {
      'unknown key in file object': [{ 'owner/repo': [{ source: 'x', bogus: true }] }],
      'file object without source': [{ 'owner/repo': [{ dest: 'x' }] }],
      'group missing files': [{ group: { repos: 'o/r' } }],
      'group missing repos': [{ group: { files: ['LICENSE'] } }],
      'group with unknown key': [{ group: { repos: 'o/r', files: ['x'], bogus: 1 } }],
      'repos wrong type': [{ group: { repos: 123, files: ['x'] } }],
      'empty files list': [{ group: { repos: 'o/r', files: [] } }],
      'repo value object without group': [{ 'owner/repo': { foo: 1 } }]
    };

    Object.entries(invalidConfigs).forEach(([name, [config]]) => {
      it(name, () => {
        expect(validate(config)).toBe(false);
      });
    });
  });

  describe('stays in sync with the parser (src/config.ts)', () => {
    it('rejects unknown properties on file objects and groups', () => {
      expect(schema.definitions.fileConfigObject.additionalProperties).toBe(false);
      expect(schema.definitions.group.additionalProperties).toBe(false);
    });

    it('documents exactly the file-level option keys the parser accepts', () => {
      const schemaKeys = Object.keys(schema.definitions.fileConfigObject.properties).sort();
      expect(schemaKeys).toEqual([...FILE_CONFIG_KEYS].sort());
    });

    it('documents exactly the group-level option keys the parser accepts', () => {
      const schemaKeys = Object.keys(schema.definitions.group.properties).sort();
      expect(schemaKeys).toEqual([...GROUP_KEYS].sort());
    });
  });
});
