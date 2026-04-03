import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { EXTENSION_ID } from './constants';

export function registerCopyWithRefCommand(context: vscode.ExtensionContext) {
    return vscode.commands.registerCommand(`${EXTENSION_ID}.copy`, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        let filePath = editor.document.fileName;
        if (workspaceFolders) {
            const root = workspaceFolders[0].uri.fsPath;
            filePath = path.relative(root, filePath);
        }

        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineRef = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

        const content = `@${filePath}:${lineRef}`;

        await vscode.env.clipboard.writeText(content);
        vscode.window.setStatusBarMessage(`Copied: ${filePath}:${lineRef}`, 2000);
    });
}

export function registerCopyFilesToSystemCommand() {
    return vscode.commands.registerCommand(
        `${EXTENSION_ID}.copyFilesToSystem`,
        async (uri: vscode.Uri, uris: vscode.Uri[]) => {
            const targets = uris?.length ? uris : (uri ? [uri] : []);
            if (!targets.length) return;

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
}

export function registerAddFavoriteFolderCommand(context: vscode.ExtensionContext) {
    return vscode.commands.registerCommand(
        `${EXTENSION_ID}.addFavoriteFolder`,
        async (uri: vscode.Uri) => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const root = workspaceFolders[0].uri.fsPath;
            const relPath = path.relative(root, uri.fsPath);

            const favKey = `favoriteFolders.${root}`;
            const favs: string[] = context.workspaceState.get(favKey, []);

            if (favs.includes(relPath)) {
                vscode.window.showInformationMessage(`已在收藏中: ${relPath}`);
                return;
            }

            favs.push(relPath);
            context.workspaceState.update(favKey, favs);
            vscode.window.showInformationMessage(`已收藏文件夹: ${relPath}`);
        }
    );
}

export function registerRevealFolderCommand(context: vscode.ExtensionContext) {
    return vscode.commands.registerCommand(
        `${EXTENSION_ID}.revealFolderInExplorer`,
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const root = workspaceFolders[0].uri.fsPath;
            const favKey = `favoriteFolders.${root}`;
            const favs: string[] = context.workspaceState.get(favKey, []);

            const output = await new Promise<string>((resolve, reject) => {
                const proc = spawn('find', [
                    root, '-type', 'd',
                    '-not', '-path', '*/.git/*',
                    '-not', '-path', '*/.git',
                    '-not', '-path', '*/node_modules/*',
                    '-not', '-path', '*/__pycache__/*',
                    '-not', '-path', '*/.venv/*',
                ]);
                let buf = '';
                proc.stdout.on('data', (data: Buffer) => { buf += data.toString(); });
                proc.on('close', () => resolve(buf));
                proc.on('error', reject);
            });

            const allDirs = output.trim().split('\n')
                .filter(d => d && d !== root)
                .map(d => path.relative(root, d))
                .sort();

            const favSet = new Set(favs);
            const topFavs = favs.filter(f => allDirs.includes(f)).slice(0, 10);
            const rest = allDirs.filter(d => !favSet.has(d));

            const quickPickItems: vscode.QuickPickItem[] = [];
            for (const f of topFavs) {
                quickPickItems.push({ label: `$(star-full) ${f}`, description: '收藏' });
            }
            if (topFavs.length > 0 && rest.length > 0) {
                quickPickItems.push({ label: '──────────', kind: vscode.QuickPickItemKind.Separator });
            }
            for (const d of rest) {
                quickPickItems.push({ label: d });
            }

            const selected = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: '搜索文件夹，选中后在资源管理器中展开',
            });

            if (selected && selected.kind !== vscode.QuickPickItemKind.Separator) {
                const cleanLabel = selected.label.replace(/^\$\(star-full\)\s*/, '');
                const uri = vscode.Uri.file(path.join(root, cleanLabel));
                await vscode.commands.executeCommand('revealInExplorer', uri);
            }
        }
    );
}

export function registerCopyFileNameCommand() {
    return vscode.commands.registerCommand(
        `${EXTENSION_ID}.copyFileName`,
        async (uri: vscode.Uri) => {
            if (!uri) return;
            const fileName = path.basename(uri.fsPath);
            await vscode.env.clipboard.writeText(fileName);
            vscode.window.setStatusBarMessage(`Copied: ${fileName}`, 2000);
        }
    );
}

export function registerKillPythonDebugCommand() {
    return vscode.commands.registerCommand(`${EXTENSION_ID}.killPythonDebug`, () => {
        const proc = spawn('sudo', ['pkill', '-9', '-f', 'python.*debug'], { stdio: 'ignore' });
        proc.on('close', (code) => {
            if (code === 0) {
                vscode.window.showInformationMessage('已终止所有 Python 调试进程');
            } else {
                vscode.window.showInformationMessage('没有找到 Python 调试进程，或已全部终止');
            }
        });
        proc.on('error', () => {
            vscode.window.showErrorMessage('执行 sudo pkill 失败，请确认 sudo 免密配置');
        });
        vscode.debug.stopDebugging();
    });
}
