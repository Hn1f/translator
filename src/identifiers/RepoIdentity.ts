import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

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
export class RepoIdentity {
  private static cache = new Map<string, string>();

  static hashForDocument(document: vscode.TextDocument): string {
    const folder = this.findRepoRoot(document.uri);
    const cached = this.cache.get(folder);
    if (cached) return cached;

    const hash = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 16);
    this.cache.set(folder, hash);
    return hash;
  }

  /** Walk up from the file looking for a `.git` directory; fall back to the workspace folder. */
  private static findRepoRoot(uri: vscode.Uri): string {
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
