import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_ID } from './constants';

// 打包后的 vsix 不含 node_modules，所以内置 js-yaml 的自包含 UMD 包并按相对路径加载；
// 开发态（Extension Development Host）下回退到 node_modules 的 js-yaml。
function loadYaml(): any {
    const candidates = [
        path.join(__dirname, '..', 'other_files', 'vendor', 'js-yaml.min.js'),
        'js-yaml',
    ];
    for (const c of candidates) {
        try {
            return require(c);
        } catch {
            // 尝试下一个候选路径
        }
    }
    throw new Error('无法加载 js-yaml 解析库');
}
const yaml = loadYaml();

type CommandNode = CommandItemNode | PlaceholderNode;

interface CommandItemNode {
    kind: 'command';
    name: string;
    command: string;
}

interface PlaceholderNode {
    kind: 'placeholder';
    name: string;
    actionCommand?: string;
}

class CommandManagerProvider implements vscode.TreeDataProvider<CommandNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<CommandNode | undefined | null | void> =
        new vscode.EventEmitter<CommandNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CommandNode | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private fileWatcher: vscode.FileSystemWatcher | undefined;

    /** 全局命令目录：每个工程一个 yaml 文件。 */
    get commandDir(): string {
        return path.join(process.env.HOME || '', '.config', 'trainning_extension', 'command');
    }

    /** 当前工程名 = 第一个工作区文件夹的名字。 */
    get projectName(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
        return path.basename(folders[0].uri.fsPath);
    }

    /** 当前工程对应的命令文件路径。 */
    get projectFilePath(): string | undefined {
        const name = this.projectName;
        if (!name) return undefined;
        return path.join(this.commandDir, `${name}.yaml`);
    }

    constructor() {
        try {
            if (!fs.existsSync(this.commandDir)) {
                fs.mkdirSync(this.commandDir, { recursive: true });
            }
        } catch (e) {
            console.error('[CommandManager] failed to ensure command dir:', e);
        }
        this.setupFileWatcher();
    }

    private setupFileWatcher(): void {
        try {
            const pattern = new vscode.RelativePattern(this.commandDir, '*.yaml');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(() => this.refresh());
            watcher.onDidCreate(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());
            this.fileWatcher = watcher;
        } catch (error) {
            console.error('[CommandManager] failed to setup file watcher:', error);
        }
    }

    dispose(): void {
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;
        this._onDidChangeTreeData.dispose();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** 读取当前工程的平铺命令列表。 */
    private loadCommands(): CommandItemNode[] | undefined {
        const fp = this.projectFilePath;
        if (!fp || !fs.existsSync(fp)) return undefined;
        try {
            const config = yaml.load(fs.readFileSync(fp, 'utf-8'));
            if (!Array.isArray(config)) {
                throw new Error('YAML 根节点必须是命令数组');
            }
            return config.map((item: any, index: number) => {
                if (
                    typeof item?.name !== 'string' || !item.name.trim() ||
                    typeof item?.command !== 'string' || !item.command.trim()
                ) {
                    throw new Error(`第 ${index + 1} 条命令必须包含非空的 name 和 command`);
                }
                return {
                    kind: 'command',
                    name: item.name,
                    command: item.command,
                };
            });
        } catch (e) {
            vscode.window.showErrorMessage(`解析命令配置失败 ${path.basename(fp)}: ${e}`);
            return undefined;
        }
    }

    getTreeItem(element: CommandNode): vscode.TreeItem {
        if (element.kind === 'placeholder') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('info');
            if (element.actionCommand) {
                item.command = { command: element.actionCommand, title: element.name };
            }
            return item;
        } else {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('run');
            item.tooltip = element.command;
            item.contextValue = 'command';
            item.command = {
                command: `${EXTENSION_ID}.runCommand`,
                title: 'Run Command',
                arguments: [element],
            };
            return item;
        }
    }

    async getChildren(element?: CommandNode): Promise<CommandNode[]> {
        if (!element) {
            const name = this.projectName;
            if (!name) {
                return [{ kind: 'placeholder', name: '未打开工作区文件夹' }];
            }
            const fp = this.projectFilePath!;
            if (!fs.existsSync(fp)) {
                return [{
                    kind: 'placeholder',
                    name: `点击为工程「${name}」新建命令配置`,
                    actionCommand: `${EXTENSION_ID}.newCommandConfig`,
                }];
            }

            const commands = this.loadCommands();
            if (!commands) {
                return [];
            }
            if (commands.length === 0) {
                return [{
                    kind: 'placeholder',
                    name: '配置为空，点击编辑',
                    actionCommand: `${EXTENSION_ID}.openCommandConfig`,
                }];
            }
            return commands;
        }
        return [];
    }
}

/**
 * 在 YAML 配置文本中搜索某条命令（按 name 匹配），返回其 name 行号（0-based）。
 * 跳过注释行；name 值的引号会被去掉再比较。
 */
function findCommandLine(content: string, name: string): number | undefined {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('#')) {
            continue;
        }
        const m = trimmed.match(/^-?\s*name:\s*(.*)$/);
        if (!m) {
            continue;
        }
        let val = m[1].trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (val === name) {
            return i;
        }
    }
    return undefined;
}

/**
 * 去掉 YAML 块标量带来的尾部空白，避免向终端多发送一个回车。
 */
function trimCommand(command: string): string {
    return command.replace(/\s+$/, '');
}

function getOrCreateRunTerminal(name: string): vscode.Terminal {
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal) {
        return activeTerminal;
    }

    const existingTerminal = vscode.window.terminals[0];
    if (existingTerminal) {
        return existingTerminal;
    }

    return vscode.window.createTerminal({ name });
}

function readTemplate(extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'other_files', 'template_commands.yaml');
    const minimalFallback = [
        '# 每条命令只包含 name 和 command',
        '- name: NVIDIA SMI',
        '  command: nvidia-smi',
        '',
    ].join('\n');

    let content: string;
    if (fs.existsSync(templatePath)) {
        content = fs.readFileSync(templatePath, 'utf-8');
        try {
            yaml.load(content);
        } catch (e) {
            vscode.window.showWarningMessage(
                `template_commands.yaml 不是合法 YAML (${e})，已创建默认配置。`
            );
            content = minimalFallback;
        }
    } else {
        content = minimalFallback;
    }
    if (!content.endsWith('\n')) content += '\n';
    return content;
}

export function registerCommandManagerView(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    const provider = new CommandManagerProvider();
    const treeView = vscode.window.createTreeView(`${EXTENSION_ID}_commands`, {
        treeDataProvider: provider,
    });
    disposables.push(treeView);

    // 切换工作区文件夹时刷新（换工程 -> 换命令）
    disposables.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
    );

    // 运行命令
    disposables.push(vscode.commands.registerCommand(
        `${EXTENSION_ID}.runCommand`,
        (cmdItem: CommandItemNode) => {
            try {
                const finalCmd = trimCommand(cmdItem.command);
                if (!finalCmd) {
                    return;
                }
                const terminal = getOrCreateRunTerminal(cmdItem.name?.trim() || 'Command Manager');
                terminal.show(true);
                terminal.sendText(finalCmd, true);
            } catch (e) {
                vscode.window.showErrorMessage(`Error running command: ${e}`);
            }
        }
    ));

    // 编辑当前工程命令配置
    disposables.push(vscode.commands.registerCommand(
        `${EXTENSION_ID}.openCommandConfig`,
        async () => {
            try {
                const fp = provider.projectFilePath;
                if (!fp) {
                    vscode.window.showErrorMessage('请先打开一个工程文件夹');
                    return;
                }
                if (!fs.existsSync(fp)) {
                    await vscode.commands.executeCommand(`${EXTENSION_ID}.newCommandConfig`);
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(fp);
                await vscode.window.showTextDocument(doc);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to open config file: ${e}`);
            }
        }
    ));

    // 编辑单条命令：打开工程 YAML 并跳转到该命令所在行
    disposables.push(vscode.commands.registerCommand(
        `${EXTENSION_ID}.editCommand`,
        async (cmdItem: CommandItemNode) => {
            try {
                if (!cmdItem || cmdItem.kind !== 'command') {
                    return;
                }
                const fp = provider.projectFilePath;
                if (!fp || !fs.existsSync(fp)) {
                    vscode.window.showWarningMessage('当前工程没有命令配置文件');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(fp);
                const line = findCommandLine(doc.getText(), cmdItem.name);
                const editor = await vscode.window.showTextDocument(doc);
                if (line !== undefined && line >= 0 && line < doc.lineCount) {
                    const range = doc.lineAt(line).range;
                    editor.selection = new vscode.Selection(range.start, range.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                } else {
                    vscode.window.showWarningMessage(`未在配置中找到命令：${cmdItem.name}`);
                }
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to open command config: ${e}`);
            }
        }
    ));

    // 刷新
    disposables.push(vscode.commands.registerCommand(`${EXTENSION_ID}.refreshCommands`, () => {
        provider.refresh();
    }));

    // 为当前工程新建命令配置
    disposables.push(vscode.commands.registerCommand(
        `${EXTENSION_ID}.newCommandConfig`,
        async () => {
            try {
                const fp = provider.projectFilePath;
                const projectName = provider.projectName;
                if (!fp || !projectName) {
                    vscode.window.showErrorMessage('请先打开一个工程文件夹');
                    return;
                }
                if (!fs.existsSync(provider.commandDir)) {
                    fs.mkdirSync(provider.commandDir, { recursive: true });
                }
                if (!fs.existsSync(fp)) {
                    fs.writeFileSync(fp, readTemplate(context.extensionPath), 'utf-8');
                    provider.refresh();
                    vscode.window.showInformationMessage(`已为工程「${projectName}」创建命令配置`);
                }
                const doc = await vscode.workspace.openTextDocument(fp);
                await vscode.window.showTextDocument(doc);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to create command config: ${e}`);
            }
        }
    ));

    // 删除当前工程命令配置
    disposables.push(vscode.commands.registerCommand(
        `${EXTENSION_ID}.deleteCommandConfig`,
        async () => {
            try {
                const fp = provider.projectFilePath;
                if (!fp || !fs.existsSync(fp)) {
                    vscode.window.showWarningMessage('当前工程没有命令配置文件');
                    return;
                }
                const fileName = path.basename(fp);
                const confirm = await vscode.window.showWarningMessage(
                    `删除命令配置「${fileName}」？此操作不可撤销。`,
                    { modal: true },
                    'Delete'
                );
                if (confirm !== 'Delete') {
                    return;
                }
                fs.unlinkSync(fp);
                provider.refresh();
                vscode.window.showInformationMessage(`已删除命令配置：${fileName}`);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to delete config file: ${e}`);
            }
        }
    ));

    disposables.push(new vscode.Disposable(() => provider.dispose()));

    return disposables;
}
