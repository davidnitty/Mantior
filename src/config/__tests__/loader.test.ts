import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig } from '../loader';

describe('config/loader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mantior-config-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const writeConfig = (content: string): string => {
    const path = join(testDir, 'mantior.yaml');
    writeFileSync(path, content, 'utf8');
    return path;
  };

  const validConfig = (): string => `
api:
  name: "Payment API"
  spec: ./specs/api-v2.yaml
  reference_url: https://api.example.com/v1/openapi.json
consumers:
  - repo: "https://github.com/acme/web.git"
    branch: "main"
    language: "typescript"
security:
  github_token: \${GITHUB_TOKEN}
rules:
  auto_pr: true
  pr_labels: ["dependencies", "mantior"]
`;

  it('loads a valid config', () => {
    const path = writeConfig(validConfig());
    const config = loadConfig(path);

    expect(config.api.name).toBe('Payment API');
    expect(config.consumers).toHaveLength(1);
    expect(config.rules.auto_pr).toBe(true);
    expect(config.rules.pr_labels).toEqual(['dependencies', 'mantior']);
    expect(config.mappings).toHaveLength(0);
  });

  it('applies defaults when optional sections are omitted', () => {
    const path = writeConfig(`
api:
  name: "Payment API"
  spec: ./specs/api-v2.yaml
  reference_url: https://api.example.com/v1/openapi.json
consumers:
  - repo: "https://github.com/acme/web.git"
`);
    const config = loadConfig(path);

    expect(config.rules.auto_pr).toBe(true);
    expect(config.consumers[0]?.branch).toBe('main');
    expect(config.consumers[0]?.language).toBe('typescript');
  });

  it('interpolates ${ENV_VAR} from the environment', () => {
    const original = process.env.MANTIOR_TEST_TOKEN;
    process.env.MANTIOR_TEST_TOKEN = 'env-token-value';
    try {
      const path = writeConfig(`
api:
  name: "Payment API"
  spec: ./specs/api-v2.yaml
  reference_url: https://api.example.com/v1/openapi.json
consumers:
  - repo: "https://github.com/acme/web.git"
security:
  github_token: \${MANTIOR_TEST_TOKEN}
`);
      const config = loadConfig(path);
      expect(config.security.github_token).toBe('env-token-value');
    } finally {
      if (original === undefined) {
        delete process.env.MANTIOR_TEST_TOKEN;
      } else {
        process.env.MANTIOR_TEST_TOKEN = original;
      }
    }
  });

  it('throws ConfigError when api section is missing', () => {
    const path = writeConfig('consumers: []');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('parses the validation section', () => {
    const path = writeConfig(`
api:
  name: "Payment API"
  spec: ./specs/api-v2.yaml
  reference_url: https://api.example.com/v1/openapi.json
consumers:
  - repo: "https://github.com/acme/web.git"
validation:
  enabled: true
  package_manager: pnpm
  steps:
    - name: "Install dependencies"
      command: "{pm} install"
      allow_network: true
      timeout: 300
      required: false
    - name: "Run Tests"
      command: "{pm} test"
      allow_network: false
      timeout: 600
      required: true
      parser: "jest"
`);
    const config = loadConfig(path);

    expect(config.validation?.enabled).toBe(true);
    expect(config.validation?.package_manager).toBe('pnpm');
    expect(config.validation?.steps).toHaveLength(2);
    expect(config.validation?.steps[0]).toMatchObject({
      name: 'Install dependencies',
      command: '{pm} install',
      allow_network: true,
      timeout: 300,
      required: false,
    });
    expect(config.validation?.steps[1]).toMatchObject({
      name: 'Run Tests',
      parser: 'jest',
      allow_network: false,
      required: true,
    });
  });

  it('omits validation when the section is absent and defaults step options', () => {
    const path = writeConfig(`
api:
  name: "Payment API"
  spec: ./specs/api-v2.yaml
  reference_url: https://api.example.com/v1/openapi.json
consumers:
  - repo: "https://github.com/acme/web.git"
validation:
  steps:
    - name: "Run Tests"
      command: "{pm} test"
`);
    const config = loadConfig(path);

    expect(config.validation?.enabled).toBe(true);
    expect(config.validation?.package_manager).toBe('auto');
    expect(config.validation?.steps[0]).toMatchObject({
      allow_network: false,
      timeout: 300,
      required: true,
    });
  });

  it('throws ConfigError when the file does not exist', () => {
    expect(() => loadConfig(join(testDir, 'missing.yaml'))).toThrow(ConfigError);
  });
});
