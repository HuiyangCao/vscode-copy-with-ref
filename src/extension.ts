import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration();
    config.update('workbench.editor.pinnedTabsOnSeparateRow', true, vscode.ConfigurationTarget.Global);
    config.update('workbench.tree.expandMode', 'doubleClick', vscode.ConfigurationTarget.Global);

    const cmd = vscode.commands.registerCommand('copy-with-ref.copy', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

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
