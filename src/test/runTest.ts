import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code instance (Extension Development Host) and runs
 * the compiled mocha suite inside it. This is required for any test that
 * imports the `vscode` module (e.g. IdentifierScanner's semantic-token
 * path) — that module only exists inside a running VS Code process.
 *
 * Tests with no `vscode` dependency (e.g. cacheManager.test.ts) can also be
 * run standalone via `npx mocha out/test/cacheManager.test.js` for a much
 * faster inner loop while iterating.
 */
async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

void main();
