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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LicenseManager = void 0;
const vscode = __importStar(require("vscode"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const logger_1 = require("../logger");
/**
 * TODO before publishing: replace with your actual Gumroad product
 * permalink (the last segment of your product's Gumroad URL, e.g. for
 * https://yourname.gumroad.com/l/ai-id-translator-pro the permalink is
 * "ai-id-translator-pro") and your product's purchase page URL.
 */
const GUMROAD_PRODUCT_PERMALINK = 'REPLACE_WITH_YOUR_GUMROAD_PERMALINK';
const PURCHASE_URL = 'https://REPLACE_WITH_YOUR_GUMROAD_USERNAME.gumroad.com/l/REPLACE_WITH_YOUR_PERMALINK';
const SECRET_KEY_LICENSE = 'aiIdentifierTranslator.licenseKey';
const STATE_KEY_USAGE_TYPE = 'aiIdentifierTranslator.usageType'; // 'personal' | 'professional' | undefined
const STATE_KEY_LAST_NAG = 'aiIdentifierTranslator.lastProNagAt';
const STATE_KEY_LICENSE_VALID = 'aiIdentifierTranslator.licenseValidatedAt'; // epoch ms of last successful validation
const NAG_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // re-check the key weekly in case it was refunded
/**
 * Deliberately NOT a feature gate. Every feature in this extension works
 * identically whether or not a license is present — this module only
 * decides whether to show a goodwill reminder for users who've identified
 * themselves as using the extension professionally. This matches an
 * "honor system" licensing model (free for personal use, paid for
 * professional use) rather than a hard paywall, which fits a small local
 * tool with no ongoing hosting costs to recoup.
 */
class LicenseManager {
    constructor(context) {
        this.context = context;
    }
    /** Call once from activate(). Fire-and-forget — never blocks startup. */
    async runStartupCheck() {
        try {
            await this.maybeAskUsageType();
            const usageType = this.getUsageType();
            if (usageType !== 'professional')
                return;
            const licensed = await this.isLicensed();
            if (licensed)
                return;
            if (this.shouldNag()) {
                await this.showProNag();
            }
        }
        catch (err) {
            // Licensing must never break the actual extension functionality.
            logger_1.Logger.warn(`License check failed non-fatally: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    getUsageType() {
        return this.context.globalState.get(STATE_KEY_USAGE_TYPE);
    }
    async maybeAskUsageType() {
        if (this.getUsageType() !== undefined)
            return;
        const choice = await vscode.window.showInformationMessage('Quick question: are you using AI Identifier Translator for personal or professional/commercial work? (Free either way — this just helps with an optional Pro license reminder.)', 'Personal', 'Professional', "Don't ask again");
        if (choice === 'Personal') {
            await this.context.globalState.update(STATE_KEY_USAGE_TYPE, 'personal');
        }
        else if (choice === 'Professional') {
            await this.context.globalState.update(STATE_KEY_USAGE_TYPE, 'professional');
        }
        else if (choice === "Don't ask again") {
            await this.context.globalState.update(STATE_KEY_USAGE_TYPE, 'personal');
        }
        // If dismissed with no choice, we'll simply ask again next activation.
    }
    shouldNag() {
        const last = this.context.globalState.get(STATE_KEY_LAST_NAG, 0);
        return Date.now() - last > NAG_INTERVAL_MS;
    }
    async showProNag() {
        await this.context.globalState.update(STATE_KEY_LAST_NAG, Date.now());
        const choice = await vscode.window.showInformationMessage("You're using AI Identifier Translator professionally — if it's useful to your team, consider grabbing a Pro license to support development.", 'Get a License', 'I already have a key', 'Remind me later');
        if (choice === 'Get a License') {
            await vscode.env.openExternal(vscode.Uri.parse(PURCHASE_URL));
        }
        else if (choice === 'I already have a key') {
            await this.promptForLicenseKey();
        }
    }
    /** Wired to the `aiIdentifierTranslator.enterLicenseKey` command. */
    async promptForLicenseKey() {
        const key = await vscode.window.showInputBox({
            title: 'Enter your Pro license key',
            placeHolder: 'e.g. 3A1F2C4B-1234-5678-9ABC-DEF012345678',
            ignoreFocusOut: true,
        });
        if (!key)
            return;
        const valid = await this.verifyWithGumroad(key);
        if (valid) {
            await this.context.secrets.store(SECRET_KEY_LICENSE, key);
            await this.context.globalState.update(STATE_KEY_LICENSE_VALID, Date.now());
            vscode.window.showInformationMessage('Thanks! Your Pro license is active. 🎉');
        }
        else {
            vscode.window.showErrorMessage('That license key could not be verified. Please check it and try again.');
        }
    }
    async isLicensed() {
        const key = await this.context.secrets.get(SECRET_KEY_LICENSE);
        if (!key)
            return false;
        const lastValidated = this.context.globalState.get(STATE_KEY_LICENSE_VALID, 0);
        if (Date.now() - lastValidated < REVALIDATE_INTERVAL_MS)
            return true; // trust recent validation, avoid hammering Gumroad
        const stillValid = await this.verifyWithGumroad(key);
        if (stillValid) {
            await this.context.globalState.update(STATE_KEY_LICENSE_VALID, Date.now());
        }
        return stillValid;
    }
    async verifyWithGumroad(licenseKey) {
        if (GUMROAD_PRODUCT_PERMALINK.startsWith('REPLACE_WITH_')) {
            logger_1.Logger.warn('Gumroad product permalink not configured — cannot verify license keys yet.');
            return false;
        }
        try {
            const body = new URLSearchParams({
                product_permalink: GUMROAD_PRODUCT_PERMALINK,
                license_key: licenseKey,
            });
            const res = await (0, node_fetch_1.default)('https://api.gumroad.com/v2/licenses/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
            if (!res.ok)
                return false;
            const data = (await res.json());
            if (!data.success)
                return false;
            if (data.purchase?.refunded || data.purchase?.chargebacked)
                return false;
            return true;
        }
        catch (err) {
            logger_1.Logger.warn(`Gumroad license verification request failed: ${err instanceof Error ? err.message : String(err)}`);
            return false; // fail closed on network errors, but this never blocks extension features — only the nag/badge
        }
    }
}
exports.LicenseManager = LicenseManager;
//# sourceMappingURL=LicenseManager.js.map