"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const ConfigManager_1 = require("./config/ConfigManager");
const CacheManager_1 = require("./cache/CacheManager");
const RepoIdentity_1 = require("./identifiers/RepoIdentity");
const OllamaClient_1 = require("./translation/OllamaClient");
const TranslationQueue_1 = require("./translation/TranslationQueue");
const DecorationController_1 = require("./decorations/DecorationController");
const logger_1 = require("./logger");
const LicenseManager_1 = require("./licensing/LicenseManager");
let decorationController;
let configManager;
let cacheRouter;
function resolveCacheDir(context, configuredDir) {
    return configuredDir && configuredDir.length > 0
        ? configuredDir
        : path.join(context.globalStorageUri.fsPath, 'cache');
}
function activate(context) {
    logger_1.Logger.init(context);
    logger_1.Logger.info('Extension activating...');
    configManager = new ConfigManager_1.ConfigManager();
    const cfg = configManager.get();
    logger_1.Logger.info(`Config: enabled=${cfg.enabled} automaticTranslation=${cfg.automaticTranslation} model=${cfg.model} endpoint=${cfg.ollamaEndpoint}`);
    cacheRouter = new CacheManager_1.CacheRouter(resolveCacheDir(context, cfg.cacheLocation));
    const client = new OllamaClient_1.OllamaClient(cfg.ollamaEndpoint, cfg.model, cfg.temperature);
    const queue = new TranslationQueue_1.TranslationQueue(cacheRouter, client, cfg.maxConcurrentTranslations);
    decorationController = new DecorationController_1.DecorationController(queue, () => configManager.get());
    logger_1.Logger.info('DecorationController ready. Waiting for visible editors...');
    const licenseManager = new LicenseManager_1.LicenseManager(context);
    context.subscriptions.push(configManager, decorationController, cacheRouter, configManager.onDidChangeConfig((newCfg) => {
        client.updateSettings(newCfg.ollamaEndpoint, newCfg.model, newCfg.temperature);
        queue.setMaxConcurrent(newCfg.maxConcurrentTranslations);
        cacheRouter.setCacheDir(resolveCacheDir(context, newCfg.cacheLocation));
    }), vscode.commands.registerCommand('aiIdentifierTranslator.toggle', async () => {
        const current = vscode.workspace.getConfiguration('aiIdentifierTranslator').get('enabled', true);
        await vscode.workspace
            .getConfiguration('aiIdentifierTranslator')
            .update('enabled', !current, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`AI Identifier Translator: ${!current ? 'enabled' : 'disabled'}`, 3000);
    }), vscode.commands.registerCommand('aiIdentifierTranslator.translateFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            logger_1.Logger.warn('translateFile invoked with no active editor.');
            return;
        }
        logger_1.Logger.info(`Manual translateFile triggered for ${editor.document.uri.fsPath}`);
        await decorationController.rescan(editor);
    }), vscode.commands.registerCommand('aiIdentifierTranslator.clearCache', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('Open a file first to identify its repository cache.');
            return;
        }
        const repoHash = RepoIdentity_1.RepoIdentity.hashForDocument(editor.document);
        const cache = await cacheRouter.forRepo(repoHash);
        const removed = cache.clearRepo(repoHash);
        vscode.window.showInformationMessage(`AI Identifier Translator: cleared ${removed} cached entries.`);
        await decorationController.rescan(editor);
    }), vscode.commands.registerCommand('aiIdentifierTranslator.revealOriginal', () => {
        vscode.window.showInformationMessage('Move the cursor onto a translated identifier to temporarily reveal the original text.');
    }), vscode.commands.registerCommand('aiIdentifierTranslator.enterLicenseKey', async () => {
        await licenseManager.promptForLicenseKey();
    }));
    // Fire-and-forget: never delays activation, never blocks any feature.
    void licenseManager.runStartupCheck();
    logger_1.Logger.info('Extension activated successfully.');
}
function deactivate() {
    cacheRouter?.dispose();
}
//# sourceMappingURL=extension.js.map