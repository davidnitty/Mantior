import { afterEach, jest } from '@jest/globals';
import { join } from 'node:path';

// Silence logs during tests.
jest.mock('./src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

// Mock environment.
process.env.GITHUB_TOKEN = 'test-token';
process.env.LOG_LEVEL = 'error';

declare global {
  var fixture: (filePath: string) => string;
}

// Resolve a path inside <rootDir>/__fixtures__.
global.fixture = (filePath: string): string => join(process.cwd(), '__fixtures__', filePath);

afterEach(() => {
  jest.clearAllMocks();
});
