import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './config/ConfigManager';
import { CacheRouter } from './cache/CacheManager';
import { RepoIdentity } from './identifiers/RepoIdentity';
import { OllamaClient } from './translation/OllamaClient';
import { TranslationQueue } from './translation/TranslationQueue';
import { DecorationController } from './decorations/DecorationController';
import { Logger } from './logger';
import { LicenseManager } from './licensing/LicenseManager';

let decorationController: DecorationController | undefined;
let configManager: ConfigManager | undefined;
let cacheRouter: CacheRouter | undefined;

function resolveCacheDir(context: vscode.ExtensionContext, configuredDir: string): string {
  return configuredDir && configuredDir.length > 0
    ? configuredDir
    : path.join(context.globalStorageUri.fsPath, 'cache');
}

export function activate(context: vscode.ExtensionContext): void {
  Logger.init(context);
  Logger.info('Extension activating...');

  configManager = new ConfigManager();
  const cfg = configManager.get();
  Logger.info(
    `Config: enabled=${cfg.enabled} automaticTranslation=${cfg.automaticTranslation} model=${cfg.model} endpoint=${cfg.ollamaEndpoint}`
  );

  cacheRouter = new CacheRouter(resolveCacheDir(context, cfg.cacheLocation));
  const client = new OllamaClient(cfg.ollamaEndpoint, cfg.model, cfg.temperature);
  const queue = new TranslationQueue(cacheRouter, client, cfg.maxConcurrentTranslations);

  decorationController = new DecorationController(queue, () => configManager!.get());
  Logger.info('DecorationController ready. Waiting for visible editors...');

  const licenseManager = new LicenseManager(context);

  context.subscriptions.push(
    configManager,
    decorationController,
    cacheRouter,
    configManager.onDidChangeConfig((newCfg) => {
      client.updateSettings(newCfg.ollamaEndpoint, newCfg.model, newCfg.temperature);
      queue.setMaxConcurrent(newCfg.maxConcurrentTranslations);
      cacheRouter!.setCacheDir(resolveCacheDir(context, newCfg.cacheLocation));
    }),
    vscode.commands.registerCommand('aiIdentifierTranslator.toggle', async () => {
      const current = vscode.workspace.getConfiguration('aiIdentifierTranslator').get<boolean>('enabled', true);
      await vscode.workspace
        .getConfiguration('aiIdentifierTranslator')
        .update('enabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(
        `AI Identifier Translator: ${!current ? 'enabled' : 'disabled'}`,
        3000
      );
    }),
    vscode.commands.registerCommand('aiIdentifierTranslator.translateFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        Logger.warn('translateFile invoked with no active editor.');
        return;
      }
      Logger.info(`Manual translateFile triggered for ${editor.document.uri.fsPath}`);
      await decorationController!.rescan(editor);
    }),
    vscode.commands.registerCommand('aiIdentifierTranslator.clearCache', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a file first to identify its repository cache.');
        return;
      }
      const repoHash = RepoIdentity.hashForDocument(editor.document);
      const cache = await cacheRouter!.forRepo(repoHash);
      const removed = cache.clearRepo(repoHash);
      vscode.window.showInformationMessage(`AI Identifier Translator: cleared ${removed} cached entries.`);
      await decorationController!.rescan(editor);
    }),
    vscode.commands.registerCommand('aiIdentifierTranslator.revealOriginal', () => {
      vscode.window.showInformationMessage(
        'Move the cursor onto a translated identifier to temporarily reveal the original text.'
      );
    }),
    vscode.commands.registerCommand('aiIdentifierTranslator.enterLicenseKey', async () => {
      await licenseManager.promptForLicenseKey();
    })
  );

  // Fire-and-forget: never delays activation, never blocks any feature.
  void licenseManager.runStartupCheck();

  Logger.info('Extension activated successfully.');
}

export function deactivate(): void {
  cacheRouter?.dispose();
}
