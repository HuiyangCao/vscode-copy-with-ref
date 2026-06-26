import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ExtConfig {
    baseSettings: Record<string, unknown>;
    settings: Record<string, unknown>;
    keybindings: Record<string, unknown>[];
}

export function loadConfig(extensionPath: string): ExtConfig {
    const configPath = path.join(extensionPath, 'src', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
}

export function applyUserKeybindings(context: vscode.ExtensionContext, keybindings: Record<string, unknown>[]) {
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

export function applyBaseSettings(settings: Record<string, unknown>) {
    const config = vscode.workspace.getConfiguration();

    for (const [key, value] of Object.entries(settings)) {
        config.update(key, value, vscode.ConfigurationTarget.Global);
    }
}

export function applySettings(context: vscode.ExtensionContext, settings: Record<string, unknown>) {
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

export function resetSettings(settings: Record<string, unknown>) {
    const config = vscode.workspace.getConfiguration();

    for (const key of Object.keys(settings)) {
        config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
}
