import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

const FONT = 'JetBrains Mono, monospace';
const FONT_SIZE = 14;

function applySettings(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration();

    // UI behavior
    config.update('workbench.editor.pinnedTabsOnSeparateRow', true, vscode.ConfigurationTarget.Global);
    config.update('workbench.tree.expandMode', 'doubleClick', vscode.ConfigurationTarget.Global);
    config.update('explorer.compactFolders', false, vscode.ConfigurationTarget.Global);

    // JetBrains style
    config.update('workbench.colorTheme', 'JetBrains Darcula Theme', vscode.ConfigurationTarget.Global);
    config.update('editor.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('editor.fontSize', FONT_SIZE, vscode.ConfigurationTarget.Global);
    config.update('editor.fontLigatures', true, vscode.ConfigurationTarget.Global);
    config.update('terminal.integrated.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('terminal.integrated.fontSize', FONT_SIZE, vscode.ConfigurationTarget.Global);
    config.update('debug.console.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('debug.console.fontSize', FONT_SIZE, vscode.ConfigurationTarget.Global);
    config.update('notebook.outputFontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('notebook.outputFontSize', FONT_SIZE, vscode.ConfigurationTarget.Global);
    config.update('chat.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('chat.fontSize', FONT_SIZE, vscode.ConfigurationTarget.Global);
    config.update('editor.codeLensFontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('editor.inlayHints.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('editor.inlineSuggest.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('scm.inputFontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('notebook.markup.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('notebook.output.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('markdown.preview.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('gitlens.currentLine.fontFamily', FONT, vscode.ConfigurationTarget.Global);
    config.update('gitlens.blame.fontFamily', FONT, vscode.ConfigurationTarget.Global);

    // Notify if theme/font extension missing (only once per install)
    const notified = context.globalState.get<boolean>('jetbrainsNotified');
    if (!notified) {
        context.globalState.update('jetbrainsNotified', true);

        const hasTheme = vscode.extensions.all.some(e =>
            e.id.toLowerCase().includes('darcula') || e.id.toLowerCase().includes('jetbrains')
        );
        if (!hasTheme) {
            vscode.window.showWarningMessage(
                'JetBrains Darcula Theme 未安装，主题设置暂不生效。',
                '去应用商店安装'
            ).then(action => {
                if (action) {
                    vscode.commands.executeCommand('workbench.extensions.search', 'JetBrains Darcula Theme');
                }
            });
        }

        vscode.window.showInformationMessage(
            '如果字体显示不正常，请先安装 JetBrains Mono 字体：https://www.jetbrains.com/lp/mono/',
            '知道了'
        );
    }
}

export function activate(context: vscode.ExtensionContext) {
    applySettings(context);

    const cmd = vscode.commands.registerCommand('copy-with-ref.copy', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;

        // Get relative path from workspace root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let filePath = editor.document.fileName;
        if (workspaceFolders) {
            const root = workspaceFolders[0].uri.fsPath;
            filePath = path.relative(root, filePath);
        }

        // 1-based line numbers
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineRef = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

        const content = `@${filePath}:${lineRef}`;

        await vscode.env.clipboard.writeText(content);
        vscode.window.setStatusBarMessage(`Copied: ${filePath}:${lineRef}`, 2000);
    });

    const openFileCmd = vscode.commands.registerCommand(
        'copy-with-ref.openFileFromScm',
        async (resourceState: vscode.SourceControlResourceState) => {
            const uri = resourceState?.resourceUri;
            if (uri) {
                await vscode.window.showTextDocument(uri);
            }
        }
    );

    const copyFilesCmd = vscode.commands.registerCommand(
        'copy-with-ref.copyFilesToSystem',
        async (uri: vscode.Uri, uris: vscode.Uri[]) => {
            const targets = uris?.length ? uris : (uri ? [uri] : []);
            if (!targets.length) return;

            // GNOME file manager clipboard format
            const content = 'copy\n' + targets.map(u => u.toString()).join('\n');

            const xclip = spawn('xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files']);
            xclip.on('error', () => {
                vscode.window.showErrorMessage('Copy to system clipboard failed: xclip not found. Run: sudo apt install xclip');
            });
            xclip.stdin.write(content);
            xclip.stdin.end();
            xclip.on('close', (code) => {
                if (code === 0) {
                    vscode.window.setStatusBarMessage(`Copied ${targets.length} file(s) to system clipboard`, 2000);
                }
            });
        }
    );

    context.subscriptions.push(cmd, openFileCmd, copyFilesCmd);
}

export function deactivate() {}
