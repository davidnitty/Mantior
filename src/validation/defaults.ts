import type { ValidationStepConfig } from '../config/loader';

/**
 * Sensible default validation pipeline, used when mantior.yaml has no
 * `validation.steps`. Steps whose npm script the consumer doesn't define
 * (`type-check`, `build`) are skipped gracefully by the runner.
 */
export const DEFAULT_VALIDATION_STEPS: ValidationStepConfig[] = [
  {
    name: 'Install',
    command: '{pm} install',
    allow_network: true,
    timeout: 300,
    required: false,
  },
  {
    name: 'Type Check',
    command: '{pm} run type-check',
    allow_network: false,
    timeout: 120,
    required: true,
  },
  {
    name: 'Test',
    command: '{pm} test',
    allow_network: false,
    timeout: 600,
    required: true,
    parser: 'jest',
  },
  {
    name: 'Build',
    command: '{pm} run build',
    allow_network: false,
    timeout: 300,
    required: false,
  },
];
