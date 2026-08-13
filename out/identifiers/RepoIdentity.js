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
exports.RepoIdentity = void 0;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
/**
 * Resolves a stable, offline-safe hash identifying "which repository" a
 * document belongs to, so the same identifier can be translated differently
 * in two unrelated projects (requirement: repository isolation).
 *
 * We deliberately hash the absolute top-level folder path rather than the
 * git remote URL:
 *  - works for repos with no remote (local-only projects)
 *  - works fully offline
 *  - stable across renames of the remote, forks, etc. is NOT guaranteed,
 *    but that's an acceptable trade-off called out in ARCHITECTURE.md.
 */
class RepoIdentity {
    static hashForDocument(document) {
        const folder = this.findRepoRoot(document.uri);
        const cached = this.cache.get(folder);
        if (cached)
            return cached;
        const hash = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16);
        this.cache.set(folder, hash);
        return hash;
    }
    /** Walk up from the file looking for a `.git` directory; fall back to the workspace folder. */
    static findRepoRoot(uri) {
        let dir = path.dirname(uri.fsPath);
        const root = path.parse(dir).root;
        while (dir !== root) {
            if (fs.existsSync(path.join(dir, '.git'))) {
                return dir;
            }
            dir = path.dirname(dir);
        }
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        return wsFolder ? wsFolder.uri.fsPath : path.dirname(uri.fsPath);
    }
}
exports.RepoIdentity = RepoIdentity;
RepoIdentity.cache = new Map();
//# sourceMappingURL=RepoIdentity.js.map