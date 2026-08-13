import * as vscode from 'vscode';

export interface AitConfig {
  enabled: boolean;
  targetLanguage: string;
  model: string;
  ollamaEndpoint: string;
  temperature: number;
  maxContextTokens: number;
  automaticTranslation: boolean;
  maxConcurrentTranslations: number;
  cacheLocation: string;
  decorationColor: string;
  lowConfidenceColor: string;
}

const SECTION = 'aiIdentifierTranslator';

/**
 * Thin, typed wrapper around workspace configuration. Centralizing this
 * avoids magic strings scattered across the codebase and gives every
 * consumer a single place to react to live settings changes.
 */
export class ConfigManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<AitConfig>();
  readonly onDidChangeConfig = this._onDidChange.event;

  private current: AitConfig;
  private readonly watcher: vscode.Disposable;

  constructor() {
    this.current = this.read();
    this.watcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        this.current = this.read();
        this._onDidChange.fire(this.current);
      }
    });
  }

  get(): AitConfig {
    return this.current;
  }

  private read(): AitConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
      enabled: cfg.get<boolean>('enabled', true),
      targetLanguage: cfg.get<string>('targetLanguage', 'en'),
      model: cfg.get<string>('model', 'qwen2.5:1.5b-instruct'),
      ollamaEndpoint: cfg.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434'),
      temperature: cfg.get<number>('temperature', 0.1),
      maxContextTokens: cfg.get<number>('maxContextTokens', 2048),
      automaticTranslation: cfg.get<boolean>('automaticTranslation', true),
      maxConcurrentTranslations: cfg.get<number>('maxConcurrentTranslations', 2),
      cacheLocation: cfg.get<string>('cacheLocation', ''),
      decorationColor: cfg.get<string>('decorationColor', '#6A9955'),
      lowConfidenceColor: cfg.get<string>('lowConfidenceColor', '#CC6666'),
    };
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
