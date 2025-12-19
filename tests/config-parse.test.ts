/**
 * Tests for config.ts parseConfig function
 *
 * These tests mock all dependencies to properly test the config module
 * which has side effects on import (initializeContext runs immediately).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store mock values
const mockInputs: Record<string, string> = {};

// Mock @actions/core before any imports
vi.mock('@actions/core', () => ({
  getInput: vi.fn((key: string) => mockInputs[key] ?? ''),
  getBooleanInput: vi.fn((key: string) => {
    const value = mockInputs[key]?.toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Input does not meet YAML 1.2 "Core Schema" specification: ${key}`);
  }),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

// Mock fs-extra
const mockFileContents: Record<string, string> = {};
vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn(() => false),
    promises: {
      readFile: vi.fn((filePath: string) => {
        const content = mockFileContents[filePath];
        if (content) {
          return Promise.resolve(Buffer.from(content));
        }
        return Promise.reject(new Error(`File not found: ${filePath}`));
      })
    }
  }
}));

describe('config.ts - parseConfig function', () => {
  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();

    // Reset mock stores
    Object.keys(mockInputs).forEach(key => delete mockInputs[key]);
    Object.keys(mockFileContents).forEach(key => delete mockFileContents[key]);

    // Set required environment
    process.env['GITHUB_SERVER_URL'] = 'https://github.com';

    // Set minimum required inputs
    mockInputs['GH_PAT'] = 'test-token';
    mockInputs['GITHUB_REPOSITORY'] = 'test-owner/test-repo';
    mockInputs['CONFIG_PATH'] = '.github/sync.yml';
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('with file-based config', () => {
    it('should parse simple repo configuration', async () => {
      const configYaml = `
user/target-repo:
  - src/file.txt
  - src/other.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      // Dynamic import to pick up mocks
      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result).toHaveLength(1);
      expect(result[0]?.repo.user).toBe('user');
      expect(result[0]?.repo.name).toBe('target-repo');
      expect(result[0]?.files).toHaveLength(2);
    });

    it('should parse repo with branch specification', async () => {
      const configYaml = `
user/repo@develop:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.branch).toBe('develop');
    });

    it('should parse detailed file configuration', async () => {
      const configYaml = `
user/repo:
  - source: src/template.md
    dest: docs/README.md
    template: true
    replace: false
    deleteOrphaned: true
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      const file = result[0]?.files[0];
      expect(file?.source).toBe('src/template.md');
      expect(file?.dest).toBe('docs/README.md');
      expect(file?.template).toBe(true);
      expect(file?.replace).toBe(false);
      expect(file?.deleteOrphaned).toBe(true);
    });

    it('should parse file with template context object', async () => {
      const configYaml = `
user/repo:
  - source: template.md
    template:
      name: MyProject
      version: 1.0.0
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      const file = result[0]?.files[0];
      expect(file?.template).toEqual({ name: 'MyProject', version: '1.0.0' });
    });

    it('should parse exclude patterns', async () => {
      const configYaml = `
user/repo:
  - source: src/
    exclude: |
      node_modules
      .git
      *.log
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      const file = result[0]?.files[0];
      expect(file?.exclude).toBeDefined();
      expect(file?.exclude).toHaveLength(3);
    });

    it('should parse group configuration', async () => {
      const configYaml = `
group:
  repos:
    - user/repo1
    - user/repo2
  files:
    - shared-file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result).toHaveLength(2);
      expect(result.map(r => r.repo.name)).toContain('repo1');
      expect(result.map(r => r.repo.name)).toContain('repo2');
    });

    it('should parse group with newline-separated repos', async () => {
      const configYaml = `
group:
  repos: |
    user/repo1
    user/repo2
    user/repo3
  files:
    - config.yml
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result).toHaveLength(3);
    });

    it('should parse group with branchSuffix', async () => {
      const configYaml = `
group:
  repos:
    - user/repo
  files:
    - file.txt
  branchSuffix: config-update
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.branchSuffix).toBe('config-update');
    });

    it('should parse group with reviewers', async () => {
      const configYaml = `
group:
  repos:
    - user/repo
  files:
    - file.txt
  reviewers:
    - reviewer1
    - reviewer2
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.reviewers).toEqual(['reviewer1', 'reviewer2']);
    });

    it('should parse multiple groups', async () => {
      const configYaml = `
group:
  - repos:
      - org/repo1
    files:
      - file1.txt
  - repos:
      - org/repo2
    files:
      - file2.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result).toHaveLength(2);
    });

    it('should merge files for same repo across groups', async () => {
      const configYaml = `
group:
  - repos:
      - user/repo
    files:
      - file1.txt
  - repos:
      - user/repo
    files:
      - file2.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      // Same repo in different groups should be merged
      expect(result).toHaveLength(1);
      expect(result[0]?.files).toHaveLength(2);
    });

    it('should parse custom host URL', async () => {
      const configYaml = `
https://github.enterprise.com/org/repo:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.host).toBe('github.enterprise.com');
      expect(result[0]?.repo.user).toBe('org');
      expect(result[0]?.repo.name).toBe('repo');
    });

    it('should apply default values for file config', async () => {
      const configYaml = `
user/repo:
  - source: file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      const file = result[0]?.files[0];
      expect(file?.dest).toBe('file.txt'); // Same as source
      expect(file?.template).toBe(false); // Default
      expect(file?.replace).toBe(true); // Default
      expect(file?.deleteOrphaned).toBe(false); // Default
    });
  });

  describe('with inline config', () => {
    it('should parse inline YAML configuration', async () => {
      mockInputs['INLINE_CONFIG'] = `
user/repo:
  - inline-file.txt
`;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result).toHaveLength(1);
      expect(result[0]?.files[0]?.source).toBe('inline-file.txt');
    });

    it('should prefer inline config over file config', async () => {
      mockInputs['INLINE_CONFIG'] = `
user/inline-repo:
  - inline.txt
`;
      mockFileContents['.github/sync.yml'] = `
user/file-repo:
  - file.txt
`;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      // Should only have inline repo
      expect(result).toHaveLength(1);
      expect(result[0]?.repo.name).toBe('inline-repo');
    });
  });

  describe('edge cases', () => {
    it('should handle repo with dots in name', async () => {
      const configYaml = `
user/repo.js:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.name).toBe('repo.js');
    });

    it('should handle repo with hyphens', async () => {
      const configYaml = `
my-org/my-repo@feature-branch:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.user).toBe('my-org');
      expect(result[0]?.repo.name).toBe('my-repo');
      expect(result[0]?.repo.branch).toBe('feature-branch');
    });

    it('should construct proper repo URL', async () => {
      const configYaml = `
owner/project:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.url).toBe('https://github.com/owner/project');
      expect(result[0]?.repo.fullName).toBe('github.com/owner/project');
    });

    it('should set default branch when not specified', async () => {
      const configYaml = `
user/repo:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.branch).toBe('default');
    });

    it('should generate unique name with branch', async () => {
      const configYaml = `
user/repo@main:
  - file.txt
`;
      mockFileContents['.github/sync.yml'] = configYaml;

      const { parseConfig } = await import('../src/config.js');
      const result = await parseConfig();

      expect(result[0]?.repo.uniqueName).toBe('github.com/user/repo@main');
    });
  });
});

describe('config.ts - context initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockInputs).forEach(key => delete mockInputs[key]);
    process.env['GITHUB_SERVER_URL'] = 'https://github.com';
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('should initialize with GH_PAT token', async () => {
    mockInputs['GH_PAT'] = 'my-pat-token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.GITHUB_TOKEN).toBe('my-pat-token');
    expect(config.default.IS_INSTALLATION_TOKEN).toBe(false);
  });

  it('should initialize with installation token when GH_PAT not provided', async () => {
    mockInputs['GH_INSTALLATION_TOKEN'] = 'my-installation-token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.GITHUB_TOKEN).toBe('my-installation-token');
    expect(config.default.IS_INSTALLATION_TOKEN).toBe(true);
  });

  it('should use default CONFIG_PATH', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.CONFIG_PATH).toBe('.github/sync.yml');
  });

  it('should use custom CONFIG_PATH when provided', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockInputs['CONFIG_PATH'] = 'custom/path/sync.yml';
    mockFileContents['custom/path/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.CONFIG_PATH).toBe('custom/path/sync.yml');
  });

  it('should set PR_LABELS from input', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockInputs['PR_LABELS'] = 'label1,label2,label3';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.PR_LABELS).toEqual(['label1', 'label2', 'label3']);
  });

  it('should set boolean options from input', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockInputs['DRY_RUN'] = 'true';
    mockInputs['SKIP_PR'] = 'true';
    mockInputs['SKIP_CLEANUP'] = 'true';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.DRY_RUN).toBe(true);
    expect(config.default.SKIP_PR).toBe(true);
    expect(config.default.SKIP_CLEANUP).toBe(true);
  });

  it('should set BRANCH_PREFIX from input', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockInputs['BRANCH_PREFIX'] = 'custom-prefix/';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - file.txt';

    const config = await import('../src/config.js');

    expect(config.default.BRANCH_PREFIX).toBe('custom-prefix/');
  });

  it('should default deleteOrphaned from input when not set on files', async () => {
    mockInputs['GH_PAT'] = 'token';
    mockInputs['GITHUB_REPOSITORY'] = 'owner/repo';
    mockInputs['DELETE_ORPHANED'] = 'true';
    mockFileContents['.github/sync.yml'] = 'user/repo:\n  - source: src/\n    dest: dest/';

    const config = await import('../src/config.js');
    const parsed = await config.parseConfig();

    expect(config.default.DELETE_ORPHANED).toBe(true);
    expect(parsed[0]?.files[0]?.deleteOrphaned).toBe(true);
  });
});
