import * as vscode from 'vscode';

/**
 * Minimal wrapper around a VS Code OutputChannel so the rest of the
 * codebase can log without threading a channel reference through every
 * constructor. Call `Logger.init()` once from `activate()`.
 *
 * View these logs via: View -> Output -> select "AI Identifier Translator"
 * from the dropdown in the Output panel.
 */
export class Logger {
  private static channel: vscode.OutputChannel | undefined;

  static init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('AI Identifier Translator');
    context.subscriptions.push(this.channel);
  }

  static info(message: string): void {
    this.write('INFO', message);
  }

  static warn(message: string): void {
    this.write('WARN', message);
  }

  static error(message: string): void {
    this.write('ERROR', message);
  }

  private static write(level: string, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    if (this.channel) {
      this.channel.appendLine(line);
    } else {
      // Fallback so nothing is silently lost if logging happens before init().
      console.log(line);
    }
  }
}
