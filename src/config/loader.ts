import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { load as loadYaml } from 'js-yaml';

import { logger } from '../logger';

// ──────────────────────────────────────────────
// CONFIG TYPES
// ──────────────────────────────────────────────

export type ApiProtocol = 'rest' | 'graphql';

export interface ApiConfig {
  name: string;
  /** Protocol of the API under maintenance: REST/OpenAPI or GraphQL SDL. */
  protocol?: ApiProtocol;
  /** Path to the NEW spec (OpenAPI file/URL, or GraphQL .graphql/.gql SDL). */
  spec: string;
  /** URL (or local path) of the CURRENT/LIVE spec consumers are coded against. */
  reference_url: string;
}

export interface ConsumerConfig {
  repo: string;
  branch: string;
  language: string;
}

export interface SecurityConfig {
  github_token?: string;
}

export interface RulesConfig {
  auto_pr: boolean;
  default_reviewer?: string;
  pr_labels: string[];
}

export interface MappingConfig {
  old_path: string;
  new_path: string;
  transform?: string;
}

export interface NotificationsConfig {
  slack_webhook?: string;
}

export interface ValidationStepConfig {
  name: string;
  /** Command with an optional `{pm}` placeholder interpolated at runtime. */
  command: string;
  allow_network: boolean;
  /** Timeout in seconds. */
  timeout: number;
  required: boolean;
  parser?: string;
}

export interface ValidationConfig {
  enabled: boolean;
  /** 'auto' | 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry' | 'go' */
  package_manager: string;
  steps: ValidationStepConfig[];
}

export interface MantiorConfig {
  api: ApiConfig;
  consumers: ConsumerConfig[];
  security: SecurityConfig;
  rules: RulesConfig;
  mappings: MappingConfig[];
  notifications: NotificationsConfig;
  validation?: ValidationConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ──────────────────────────────────────────────
// LOADER
// ──────────────────────────────────────────────

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!ENV_PATTERN.test(value)) {
      return value;
    }
    ENV_PATTERN.lastIndex = 0;
    return value.replace(ENV_PATTERN, (match: string, name: string) => process.env[name] ?? match);
  }
  if (Array.isArray(value)) {
    return value.map(entry => interpolateEnv(entry));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnv(entry);
    }
    return result;
  }
  return value;
}

/**
 * Load and validate mantior.yaml. Relative spec paths resolve against the
 * config file's directory, so the CLI works from any cwd (fixes the E2E
 * fixture which references specs by absolute path).
 */
export function loadConfig(
  configPath = process.env.MANTIOR_CONFIG ?? 'mantior.yaml',
): MantiorConfig {
  const absolutePath = resolve(process.cwd(), configPath);
  if (!existsSync(absolutePath)) {
    throw new ConfigError(`Config file not found: ${absolutePath}`);
  }

  let raw: unknown;
  try {
    raw = loadYaml(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `Failed to parse ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const document = interpolateEnv(raw ?? {}) as Record<string, unknown>;
  const baseDir = dirOf(absolutePath);

  const config: MantiorConfig = {
    api: parseApi(document.api, baseDir),
    consumers: parseConsumers(document.consumers),
    security: parseSecurity(document.security),
    rules: parseRules(document.rules),
    mappings: parseMappings(document.mappings),
    notifications: parseNotifications(document.notifications),
    validation: parseValidation(document.validation),
  };

  return config;
}

/** Stable fingerprint of a config file, stored on scan records. */
export function configHash(configPath: string): string {
  return createHash('sha1').update(readFileSync(configPath)).digest('hex').slice(0, 16);
}

// ──────────────────────────────────────────────
// SECTIONS
// ──────────────────────────────────────────────

function parseApi(raw: unknown, baseDir: string): ApiConfig {
  const api = asRecord(raw, 'api');
  const protocol = optionalString(api.protocol, 'api.protocol');
  return {
    name: requiredString(api.name, 'api.name'),
    protocol: protocol === 'graphql' ? 'graphql' : 'rest',
    spec: resolveReference(requiredString(api.spec, 'api.spec'), baseDir),
    reference_url: requiredString(api.reference_url, 'api.reference_url'),
  };
}

function parseConsumers(raw: unknown): ConsumerConfig[] {
  if (isNil(raw)) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError('consumers must be a list');
  }
  return raw.map((entry, index) => {
    const consumer = asRecord(entry, `consumers[${index}]`);
    return {
      repo: requiredString(consumer.repo, `consumers[${index}].repo`),
      branch: optionalString(consumer.branch, `consumers[${index}].branch`) ?? 'main',
      language: optionalString(consumer.language, `consumers[${index}].language`) ?? 'typescript',
    };
  });
}

function parseSecurity(raw: unknown): SecurityConfig {
  const security = asRecord(raw, 'security');
  const configToken = optionalString(security.github_token, 'security.github_token');
  const token = configToken ?? process.env.GITHUB_TOKEN;
  return { github_token: token };
}

function parseRules(raw: unknown): RulesConfig {
  const rules = asRecord(raw, 'rules');
  return {
    auto_pr: asBoolean(rules.auto_pr, 'rules.auto_pr', true),
    default_reviewer: optionalString(rules.default_reviewer, 'rules.default_reviewer'),
    pr_labels: asStringList(rules.pr_labels, 'rules.pr_labels', ['dependencies', 'mantior']),
  };
}

function parseMappings(raw: unknown): MappingConfig[] {
  if (isNil(raw)) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError('mappings must be a list');
  }
  return raw.map((entry, index) => {
    const mapping = asRecord(entry, `mappings[${index}]`);
    return {
      old_path: requiredString(mapping.old_path, `mappings[${index}].old_path`),
      new_path: requiredString(mapping.new_path, `mappings[${index}].new_path`),
      transform: optionalString(mapping.transform, `mappings[${index}].transform`),
    };
  });
}

function parseNotifications(raw: unknown): NotificationsConfig {
  const notifications = asRecord(raw, 'notifications');
  return {
    slack_webhook: optionalString(notifications.slack_webhook, 'notifications.slack_webhook'),
  };
}

function parseValidation(raw: unknown): ValidationConfig | undefined {
  if (isNil(raw)) {
    return undefined;
  }
  const validation = asRecord(raw, 'validation');
  return {
    enabled: asBoolean(validation.enabled, 'validation.enabled', true),
    package_manager:
      optionalString(validation.package_manager, 'validation.package_manager') ?? 'auto',
    steps: parseValidationSteps(validation.steps),
  };
}

function parseValidationSteps(raw: unknown): ValidationStepConfig[] {
  if (isNil(raw)) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError('validation.steps must be a list');
  }
  return raw.map((entry, index) => {
    const step = asRecord(entry, `validation.steps[${index}]`);
    return {
      name: requiredString(step.name, `validation.steps[${index}].name`),
      command: requiredString(step.command, `validation.steps[${index}].command`),
      allow_network: asBoolean(
        step.allow_network,
        `validation.steps[${index}].allow_network`,
        false,
      ),
      timeout: asNumber(step.timeout, `validation.steps[${index}].timeout`, 300),
      required: asBoolean(step.required, `validation.steps[${index}].required`, true),
      parser: optionalString(step.parser, `validation.steps[${index}].parser`),
    };
  });
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (isNil(value)) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${label} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, _label: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (isNil(value)) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
}

function asStringList(value: unknown, label: string, fallback: string[]): string[] {
  if (isNil(value)) {
    return fallback;
  }
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new ConfigError(`${label} must be a list of strings`);
  }
  return value as string[];
}

function asNumber(value: unknown, label: string, fallback: number): number {
  if (isNil(value)) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive number`);
  }
  return value;
}

function isNil(value: unknown): boolean {
  return value === null || value === undefined;
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

/** Resolve relative paths against the config file location. */
function resolveReference(reference: string, baseDir: string): string {
  if (/^https?:\/\//.test(reference) || reference.startsWith('~')) {
    return reference;
  }
  // Absolute (POSIX or Windows drive letter) paths pass through untouched.
  if (reference.startsWith('/') || /^[A-Za-z]:[\\/]/.test(reference)) {
    return reference;
  }
  return `${baseDir}/${reference}`;
}

// Re-export for callers that want the logger to know the config resolved.
export function logConfigSummary(config: MantiorConfig): void {
  logger.info(
    `Loaded config: api=${config.api.name}, consumers=${config.consumers.length}, mappings=${config.mappings.length}`,
  );
}
