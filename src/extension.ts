import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

interface ExtConfig {
    settings: Record<string, unknown>;
    keybindings: Record<string, unknown>[];
}

function loadConfig(extensionPath: string): ExtConfig {
    const configPath = path.join(extensionPath, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
}

function applyUserKeybindings(context: vscode.ExtensionContext, keybindings: Record<string, unknown>[]) {
    const userDir = path.resolve(context.globalStorageUri.fsPath, '..', '..');
    const kbPath = path.join(userDir, 'keybindings.json');

    let raw = '';
    try { raw = fs.readFileSync(kbPath, 'utf8'); } catch { }

    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');
    let existing: Record<string, unknown>[] = [];
    try { existing = JSON.parse(stripped || '[]'); } catch { existing = []; }

    const identity = (e: Record<string, unknown>) => `${e.key}|${e.command}`;

    const existingMap = new Map<string, { index: number; entry: Record<string, unknown> }>();
    existing.forEach((e, i) => existingMap.set(identity(e), { index: i, entry: e }));

    let changed = false;
    for (const desired of keybindings) {
        const id = identity(desired);
        const found = existingMap.get(id);
        if (found) {
            if (JSON.stringify(found.entry) !== JSON.stringify(desired)) {
                existing[found.index] = desired;
                changed = true;
            }
        } else {
            existing.push(desired);
            changed = true;
        }
    }

    if (!changed) return;

    const lines = existing.map(e => `    ${JSON.stringify(e)}`).join(',\n');
    fs.writeFileSync(kbPath, `[\n${lines}\n]\n`);
}

function applySettings(context: vscode.ExtensionContext, settings: Record<string, unknown>) {
    const config = vscode.workspace.getConfiguration();

    for (const [key, value] of Object.entries(settings)) {
        config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');

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
            '如果字体显示不正常，请先安装 JetBrains Mono 字体。Ubuntu 用户可运行：sudo apt install fonts-jetbrains-mono',
            '官方下载页',
            '知道了'
        ).then(action => {
            if (action === '官方下载页') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.jetbrains.com/lp/mono/#how-to-install'));
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    const cfg = loadConfig(context.extensionPath);
    applySettings(context, cfg.settings);
    applyUserKeybindings(context, cfg.keybindings);

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

    const revealFolderCmd = vscode.commands.registerCommand(
        'copy-with-ref.revealFolderInExplorer',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const root = workspaceFolders[0].uri.fsPath;

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

            const dirs = output.trim().split('\n')
                .filter(d => d && d !== root)
                .map(d => path.relative(root, d))
                .sort();

            const selected = await vscode.window.showQuickPick(dirs, {
                placeHolder: '搜索文件夹，选中后在资源管理器中展开',
            });

            if (selected) {
                const uri = vscode.Uri.file(path.join(root, selected));
                await vscode.commands.executeCommand('revealInExplorer', uri);
            }
        }
    );

    const copyFileNameCmd = vscode.commands.registerCommand(
        'copy-with-ref.copyFileName',
        async (uri: vscode.Uri) => {
            if (!uri) return;
            const fileName = path.basename(uri.fsPath);
            await vscode.env.clipboard.writeText(fileName);
            vscode.window.setStatusBarMessage(`Copied: ${fileName}`, 2000);
        }
    );

    const killPythonDebugCmd = vscode.commands.registerCommand('copy-with-ref.killPythonDebug', () => {
        const proc = spawn('sudo', ['pkill', '-9', '-f', 'python.*debug'], { stdio: 'ignore' });
        proc.on('close', (code) => {
            if (code === 0) {
                vscode.window.showInformationMessage('已终止所有 Python 调试进程');
            } else {
                // pkill 返回 1 表示没有匹配进程，也算正常
                vscode.window.showInformationMessage('没有找到 Python 调试进程，或已全部终止');
            }
        });
        proc.on('error', () => {
            vscode.window.showErrorMessage('执行 sudo pkill 失败，请确认 sudo 免密配置');
        });
        // 同时停止 VS Code 内的调试会话
        vscode.debug.stopDebugging();
    });

    // Debug 参数输入拦截：launch 配置中含 ${input:} 变量时，由我们接管输入
    // 用户 ESC 取消输入则取消调试，而不是用空参数继续执行
    const debugProvider = vscode.debug.registerDebugConfigurationProvider('*', {
        async resolveDebugConfiguration(
            _folder: vscode.WorkspaceFolder | undefined,
            config: vscode.DebugConfiguration,
        ): Promise<vscode.DebugConfiguration | undefined> {
            if (!config.args || !Array.isArray(config.args)) return config;

            // 检查 args 中是否有 ${input:xxx} 变量
            const inputPattern = /\$\{input:([^}]+)\}/;
            const resolvedArgs: string[] = [];
            const configName = config.name || 'default';

            for (const arg of config.args as string[]) {
                const match = typeof arg === 'string' ? arg.match(inputPattern) : null;
                if (match) {
                    const inputName = match[1];
                    // 查找 launch.json 中对应的 input 定义
                    const inputDef = findInputDefinition(inputName);
                    const value = await promptForInput(context, configName, inputDef, inputName);
                    if (value === undefined) {
                        // 用户按了 ESC，取消调试
                        return undefined;
                    }
                    resolvedArgs.push(arg.replace(inputPattern, value));
                } else {
                    resolvedArgs.push(arg);
                }
            }

            config.args = resolvedArgs;
            return config;
        }
    }, vscode.DebugConfigurationProviderTriggerKind.Initial);

    context.subscriptions.push(cmd, copyFilesCmd, revealFolderCmd, copyFileNameCmd, killPythonDebugCmd, debugProvider);
}

// 从 .vscode/launch.json 的 inputs 数组中查找对应定义
function findInputDefinition(inputId: string): { type: string; description?: string; options?: string[]; default?: string } | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;

    const launchPath = path.join(folders[0].uri.fsPath, '.vscode', 'launch.json');
    try {
        const raw = fs.readFileSync(launchPath, 'utf8');
        const stripped = raw.replace(/\/\/.*$/gm, '').replace(/,\s*([\]}])/g, '$1');
        const launch = JSON.parse(stripped);
        const inputs: any[] = launch.inputs || [];
        return inputs.find((i: any) => i.id === inputId);
    } catch {
        return undefined;
    }
}

// 根据 input 定义弹出输入框或选择框，并记住上次的值（按启动项+参数名区分）
async function promptForInput(
    context: vscode.ExtensionContext,
    configName: string,
    inputDef: { type: string; description?: string; options?: string[]; default?: string } | undefined,
    inputName: string
): Promise<string | undefined> {
    const stateKey = `debugInput.${configName}.${inputName}`;
    const lastValue = context.workspaceState.get<string>(stateKey);

    if (inputDef?.type === 'pickString' && inputDef.options?.length) {
        // 将上次选择的选项排到第一位
        let options = [...inputDef.options];
        if (lastValue && options.includes(lastValue)) {
            options = [lastValue, ...options.filter(o => o !== lastValue)];
        }
        const value = await vscode.window.showQuickPick(options, {
            placeHolder: inputDef.description || `选择参数: ${inputName}`,
            ignoreFocusOut: true,
        });
        if (value !== undefined) {
            context.workspaceState.update(stateKey, value);
        }
        return value;
    }

    const value = await vscode.window.showInputBox({
        prompt: inputDef?.description || `输入参数: ${inputName}`,
        value: lastValue ?? inputDef?.default ?? '',
        ignoreFocusOut: true,
    });
    if (value !== undefined) {
        context.workspaceState.update(stateKey, value);
    }
    return value;
}

export function deactivate() {}
