import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { EXTENSION_ID } from './constants';

interface SshHostNode {
    kind: 'host';
    host: string;
    hostname?: string;
    user?: string;
    port?: string;
    latency?: number | null;
    /** 该 Host 在 ~/.ssh/config 中的行号（0-based，未注释的真实条目）。 */
    line?: number;
}

interface SshErrorNode {
    kind: 'error';
    message: string;
}

interface SyncHistoryEntry {
    local: string;
    remote: string;
    lastUsed: string;
    isDirectory: boolean;
    excludes?: string[];
}

interface ServerSyncHistory {
    uploads: SyncHistoryEntry[];
    downloads: SyncHistoryEntry[];
}

interface SyncConfig {
    servers: Record<string, ServerSyncHistory>;
    localFolderHistory?: string[];
    remoteFolderHistory?: Record<string, string[]>;
}

interface StartCommandConfig {
    _comment?: string | string[];
    servers: Record<string, {
        projects: Record<string, string>;
    }>;
}

type SshTreeNode = SshHostNode | SshErrorNode;

const SYNC_CONFIG_DIR = path.join(os.homedir(), '.config', 'trainning_extension', 'ssh_manager');
const SYNC_CONFIG_PATH = path.join(SYNC_CONFIG_DIR, 'config.json');
const START_COMMAND_CONFIG_PATH = path.join(os.homedir(), '.config', 'trainning_extension', 'start_command.json');
const MAX_HISTORY = 5;
const MAX_FOLDER_HISTORY = 5;

function getCurrentProjectName(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
        return '__default__';
    }
    return ws.name || path.basename(ws.uri.fsPath) || '__default__';
}

function loadStartCommandConfig(): StartCommandConfig {
    if (!fs.existsSync(START_COMMAND_CONFIG_PATH)) {
        return {
            _comment: [
                'How to use start_command.json:',
                '1) servers.<ssh-host-alias>.projects.<workspace-name> = "<command>"',
                '2) <ssh-host-alias> must match Host in ~/.ssh/config',
                '3) <workspace-name> is current VS Code workspace folder name',
                '4) Example:',
                '   servers.my-server.projects.vscode-copy-with-ref = "cd ~/proj && source .venv/bin/activate"',
                '5) Fallback project key: "__default__"',
            ].join('\n'),
            servers: {},
        };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(START_COMMAND_CONFIG_PATH, 'utf-8')) as StartCommandConfig;
        if (typeof raw._comment === 'string') {
            raw._comment = raw._comment.split('\n');
        }
        raw.servers = raw.servers || {};
        for (const key of Object.keys(raw.servers)) {
            raw.servers[key].projects = raw.servers[key].projects || {};
        }
        return raw;
    } catch {
        return { servers: {} };
    }
}

function saveStartCommandConfig(config: StartCommandConfig): void {
    const dir = path.dirname(START_COMMAND_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(START_COMMAND_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function ensureStartCommandTemplate(server: string, projectName: string): StartCommandConfig {
    const config = loadStartCommandConfig();
    if (!config._comment) {
        config._comment = [
            'How to use start_command.json:',
            '1) servers.<ssh-host-alias>.projects.<workspace-name> = "<command>"',
            '2) <ssh-host-alias> must match Host in ~/.ssh/config',
            '3) <workspace-name> is current VS Code workspace folder name',
            '4) Example:',
            '   servers.my-server.projects.vscode-copy-with-ref = "cd ~/proj && source .venv/bin/activate"',
            '5) Fallback project key: "__default__"',
        ];
    }
    if (!config.servers[server]) {
        config.servers[server] = { projects: {} };
    }
    if (!config.servers[server].projects[projectName]) {
        config.servers[server].projects[projectName] = 'ls';
    }
    saveStartCommandConfig(config);
    return config;
}

function getStartCommand(server: string, projectName: string): string | undefined {
    const config = loadStartCommandConfig();
    return config.servers[server]?.projects?.[projectName];
}

function loadSyncConfig(): SyncConfig {
    if (!fs.existsSync(SYNC_CONFIG_PATH)) {
        return { servers: {}, localFolderHistory: [], remoteFolderHistory: {} };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(SYNC_CONFIG_PATH, 'utf-8')) as SyncConfig;
        raw.servers = raw.servers || {};
        raw.localFolderHistory = raw.localFolderHistory || [];
        raw.remoteFolderHistory = raw.remoteFolderHistory || {};
        // Backward compatibility for old history records without excludes.
        for (const server of Object.values(raw.servers || {})) {
            for (const item of [...(server.uploads || []), ...(server.downloads || [])]) {
                if (!Array.isArray(item.excludes)) {
                    item.excludes = [];
                }
            }
        }
        return raw;
    } catch {
        return { servers: {} };
    }
}

function saveSyncConfig(config: SyncConfig): void {
    if (!fs.existsSync(SYNC_CONFIG_DIR)) {
        fs.mkdirSync(SYNC_CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function addSyncHistory(
    server: string,
    direction: 'upload' | 'download',
    local: string,
    remote: string,
    isDirectory: boolean,
    excludes: string[] = []
): void {
    const config = loadSyncConfig();
    if (!config.servers[server]) {
        config.servers[server] = { uploads: [], downloads: [] };
    }
    const list = direction === 'upload' ? config.servers[server].uploads : config.servers[server].downloads;
    const existing = list.findIndex(e => e.local === local && e.remote === remote);
    if (existing !== -1) {
        list.splice(existing, 1);
    }
    list.unshift({ local, remote, lastUsed: new Date().toISOString(), isDirectory, excludes });
    if (list.length > MAX_HISTORY) {
        list.length = MAX_HISTORY;
    }
    saveSyncConfig(config);
}

function getSyncHistory(server: string, direction: 'upload' | 'download'): SyncHistoryEntry[] {
    const config = loadSyncConfig();
    const serverHist = config.servers[server];
    if (!serverHist) return [];
    return direction === 'upload' ? serverHist.uploads : serverHist.downloads;
}

function addLocalFolderHistory(folderPath: string): void {
    if (!folderPath) return;
    const config = loadSyncConfig();
    const list = config.localFolderHistory || [];
    const idx = list.findIndex((p) => p === folderPath);
    if (idx !== -1) {
        list.splice(idx, 1);
    }
    list.unshift(folderPath);
    if (list.length > MAX_FOLDER_HISTORY) {
        list.length = MAX_FOLDER_HISTORY;
    }
    config.localFolderHistory = list;
    saveSyncConfig(config);
}

function getLocalFolderHistory(): string[] {
    const config = loadSyncConfig();
    const list = config.localFolderHistory || [];
    return list.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
}

function addRemoteFolderHistory(server: string, folderPath: string): void {
    if (!folderPath) return;
    const config = loadSyncConfig();
    config.remoteFolderHistory = config.remoteFolderHistory || {};
    const list = config.remoteFolderHistory[server] || [];
    const idx = list.findIndex((p) => p === folderPath);
    if (idx !== -1) {
        list.splice(idx, 1);
    }
    list.unshift(folderPath);
    if (list.length > MAX_FOLDER_HISTORY) {
        list.length = MAX_FOLDER_HISTORY;
    }
    config.remoteFolderHistory[server] = list;
    saveSyncConfig(config);
}

function getRemoteFolderHistory(server: string): string[] {
    const config = loadSyncConfig();
    return (config.remoteFolderHistory && config.remoteFolderHistory[server]) || [];
}

function getRemotePath(serverNode: SshHostNode, remotePath: string): string {
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = serverNode.hostname || serverNode.host;
    const port = serverNode.port ? `-P ${serverNode.port} ` : '';
    return `${user}${host}:${remotePath}`;
}

function getSshHostAddress(serverNode: SshHostNode): string {
    return serverNode.hostname || serverNode.host;
}

/**
 * 检测远程路径是否为文件夹
 */
async function isRemoteDirectory(serverNode: SshHostNode, remotePath: string): Promise<boolean> {
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
    if (serverNode.port) {
        sshArgs.push('-p', serverNode.port);
    }
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = serverNode.hostname || serverNode.host;

    return new Promise((resolve) => {
        const proc = spawn('ssh', [...sshArgs, `${user}${host}`, `test -d "${remotePath}" && echo 1 || echo 0`], {
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString(); });
        proc.on('close', () => {
            resolve(output.trim() === '1');
        });
        proc.on('error', () => resolve(false));
    });
}

function buildScpArgs(serverNode: SshHostNode): string[] {
    const args: string[] = [];
    if (serverNode.port) {
        args.push('-P', serverNode.port);
    }
    return args;
}
function parseSshConfig(configPath: string): SshHostNode[] {
    if (!fs.existsSync(configPath)) {
        throw new Error('SSH config file not found at ' + configPath);
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const lines = content.split('\n');
    const hosts: SshHostNode[] = [];
    let currentHost: SshHostNode | null = null;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        // 空行或注释行，跳过（注释掉的 Host 条目不会被记录）
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        // 检查 Host 行
        if (trimmed.toLowerCase().startsWith('host ')) {
            // 保存之前的主机
            if (currentHost && currentHost.host !== '*') {
                hosts.push(currentHost);
            }

            // 提取 Host 别名
            const hostName = trimmed.substring(5).trim();
            currentHost = {
                kind: 'host',
                host: hostName,
                line: i,
            };

            // 跳过 Host * 全局配置
            if (hostName === '*') {
                currentHost = null;
            }
            continue;
        }

        // 解析主机配置字段（缩进的行）
        if (currentHost) {
            const keyValue = trimmed.split(/\s+/);
            if (keyValue.length >= 2) {
                const key = keyValue[0].toLowerCase();
                const value = keyValue.slice(1).join(' ');

                if (key === 'hostname') {
                    currentHost.hostname = value;
                } else if (key === 'user') {
                    currentHost.user = value;
                } else if (key === 'port') {
                    currentHost.port = value;
                }
            }
        }
    }

    // 保存最后一个主机
    if (currentHost && currentHost.host !== '*') {
        hosts.push(currentHost);
    }

    return hosts;
}

class SshServerProvider implements vscode.TreeDataProvider<SshTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<SshTreeNode | undefined | void> =
        new vscode.EventEmitter<SshTreeNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SshTreeNode | undefined | void> =
        this._onDidChangeTreeData.event;

    private configPath: string;
    private parseError: string | null = null;
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private pingRunning = false;
    private disposed = false;
    private hosts: SshHostNode[] = [];

    constructor() {
        this.configPath = path.join(os.homedir(), '.ssh', 'config');
        this.setupFileWatcher();
        this.startPingTimer();
    }

    private async pingHost(host: SshHostNode): Promise<number | null> {
        const target = host.hostname || host.host;
        return new Promise((resolve) => {
            const start = Date.now();
            const proc = spawn('ping', ['-c', '1', '-W', '3', target], {
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            let output = '';
            proc.stdout.on('data', (data) => { output += data.toString(); });
            proc.on('close', (code) => {
                if (code === 0) {
                    const match = output.match(/time[=<](\d+\.?\d*)\s*ms/);
                    if (match) {
                        resolve(Math.round(parseFloat(match[1])));
                    } else {
                        resolve(Date.now() - start);
                    }
                } else {
                    resolve(null);
                }
            });
            proc.on('error', () => resolve(null));
        });
    }

    private async pingAll(): Promise<void> {
        if (this.pingRunning || this.disposed) return;
        this.pingRunning = true;
        try {
            for (const host of this.hosts) {
                if (this.disposed) return;
                host.latency = await this.pingHost(host);
            }
            if (!this.disposed) {
                this._onDidChangeTreeData.fire();
            }
        } finally {
            this.pingRunning = false;
        }
    }

    private scheduleNextPing(): void {
        if (this.disposed) return;
        this.pingTimer = setTimeout(async () => {
            this.pingTimer = null;
            await this.pingAll();
            this.scheduleNextPing();
        }, 2500);
    }

    private startPingTimer(): void {
        this.stopPingTimer();
        this.pingAll().finally(() => this.scheduleNextPing());
    }

    private stopPingTimer(): void {
        if (this.pingTimer) {
            clearTimeout(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private setupFileWatcher(): void {
        try {
            const pattern = new vscode.RelativePattern(
                path.dirname(this.configPath),
                path.basename(this.configPath)
            );
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

            this.fileWatcher.onDidChange(() => {
                this.refresh();
            });

            this.fileWatcher.onDidCreate(() => {
                this.refresh();
            });
        } catch (error) {
            console.error('Failed to setup file watcher:', error);
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
        }
        this.stopPingTimer();
        this._onDidChangeTreeData.dispose();
    }

    refresh(): void {
        this.hosts = [];
        this.parseError = null;
        try {
            this.hosts = parseSshConfig(this.configPath);
        } catch (error) {
            this.parseError = error instanceof Error ? error.message : String(error);
        }
        this._onDidChangeTreeData.fire();
        this.pingAll();
    }

    getParseError(): string | null {
        return this.parseError;
    }

    setParseError(error: string | null): void {
        this.parseError = error;
    }

    getTreeItem(element: SshTreeNode): vscode.TreeItem {
        if (element.kind === 'error') {
            const treeItem = new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
            treeItem.iconPath = new vscode.ThemeIcon('error');
            return treeItem;
        }

        const label = element.latency !== undefined && element.latency !== null
            ? `${element.host}  ${element.latency}ms`
            : element.host;
        const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        treeItem.tooltip = this.buildTooltip(element);
        treeItem.iconPath = new vscode.ThemeIcon('remote');
        treeItem.contextValue = 'sshHost';
        return treeItem;
    }

    getChildren(element?: SshTreeNode): Thenable<SshTreeNode[]> {
        if (element) {
            return Promise.resolve([]);
        }

        if (this.parseError) {
            return Promise.resolve([{
                kind: 'error',
                message: '❌ ' + this.parseError,
            }]);
        }

        if (this.hosts.length === 0) {
            try {
                this.hosts = parseSshConfig(this.configPath);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                this.parseError = errorMsg;
                return Promise.resolve([{
                    kind: 'error',
                    message: '❌ ' + errorMsg,
                }]);
            }
        }
        return Promise.resolve(this.hosts);
    }

    private buildTooltip(element: SshHostNode): string {
        const parts: string[] = [element.host];
        if (element.hostname) {
            parts.push(`Host: ${element.hostname}`);
        }
        if (element.user) {
            parts.push(`User: ${element.user}`);
        }
        if (element.port) {
            parts.push(`Port: ${element.port}`);
        }
        if (element.latency !== undefined && element.latency !== null) {
            parts.push(`Latency: ${element.latency}ms`);
        } else if (element.latency === null) {
            parts.push('Latency: unreachable');
        }
        parts.push('Right click for more actions');
        return parts.join('\n');
    }
}

/**
 * 打开 SSH config 文件
 */
async function openSshConfig() {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    const uri = vscode.Uri.file(configPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
}

/**
 * 在 SSH config 文本中搜索某个别名对应的、未注释的 Host 行，返回其行号（0-based）。
 */
function findHostLine(content: string, alias: string): number | undefined {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // 跳过空行和注释（排除注释掉的条目）
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (!trimmed.toLowerCase().startsWith('host ')) {
            continue;
        }
        const rest = trimmed.substring(5).trim();
        if (rest === alias || rest.split(/\s+/).includes(alias)) {
            return i;
        }
    }
    return undefined;
}

/**
 * 编辑单个 SSH 条目：打开 ~/.ssh/config 并跳转到该 Host 所在行。
 */
async function editSshHost(node: SshTreeNode) {
    if (!node || node.kind !== 'host') {
        return;
    }
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    const uri = vscode.Uri.file(configPath);
    const doc = await vscode.workspace.openTextDocument(uri);

    // 优先用解析时记录的行号；失效时按别名搜索（均排除注释条目）
    let line = node.line;
    if (line === undefined || line < 0 || line >= doc.lineCount) {
        line = findHostLine(doc.getText(), node.host);
    }

    const editor = await vscode.window.showTextDocument(doc);
    if (line !== undefined && line >= 0 && line < doc.lineCount) {
        const range = doc.lineAt(line).range;
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } else {
        vscode.window.showWarningMessage(`未在 ~/.ssh/config 中找到未注释的 Host: ${node.host}`);
    }
}

/**
 * SSH 连接命令：新建终端并自动执行 ssh 命令
 */
async function connectSsh(node: SshTreeNode) {
    if (!node || node.kind !== 'host') {
        return;
    }

    const sshCommand = `ssh ${node.host}`;

    // 新建带 host 名的终端并自动执行
    const terminal = vscode.window.createTerminal({
        name: node.host,
    });

    terminal.show(true);
    terminal.sendText(sshCommand, true);

    const projectName = getCurrentProjectName();
    const startupCommand = getStartCommand(node.host, projectName);
    if (startupCommand && startupCommand.trim()) {
        setTimeout(() => terminal.sendText(startupCommand, true), 600);
    }
}

async function copySshIp(node: SshTreeNode) {
    if (!node || node.kind !== 'host') {
        return;
    }
    const host = getSshHostAddress(node);
    await vscode.env.clipboard.writeText(host);
    vscode.window.showInformationMessage(`Copied host: ${host}`);
}

async function openSshStartCommandConfig(node: SshTreeNode) {
    if (!node || node.kind !== 'host') {
        return;
    }
    const projectName = getCurrentProjectName();
    ensureStartCommandTemplate(node.host, projectName);
    const uri = vscode.Uri.file(START_COMMAND_CONFIG_PATH);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Template ensured: server "${node.host}", project "${projectName}"`);
}

interface HistoryQuickPickItem extends vscode.QuickPickItem {
    entry: SyncHistoryEntry | 'browse';
}

type FolderPickItem = vscode.QuickPickItem & {
    buttons?: readonly vscode.QuickInputButton[];
    alwaysSelectFolder?: boolean;
};

function stageTitle(stage: 'source' | 'exclude' | 'target', currentPath: string): string {
    if (stage === 'source') {
        return `🟦 Source selection  |  ${currentPath}`;
    }
    if (stage === 'exclude') {
        return `🟨 Exclude selection  |  ${currentPath}`;
    }
    return `🟩 Target selection (Please choose the parent folder of target folder.)  |  ${currentPath}`;
}

/**
 * 显示同步历史选择 QuickPick，返回选中的历史条目或 null（用户选"浏览..."）
 */
function showHistoryQuickPick(
    history: SyncHistoryEntry[],
    direction: 'upload' | 'download'
): Thenable<SyncHistoryEntry | 'browse' | undefined> {
    const items: HistoryQuickPickItem[] = history.map(e => ({
        label: direction === 'upload'
            ? `$(history) ${e.isDirectory ? '$(folder)' : '$(file)'} ${e.local} → ${e.remote}`
            : `$(history) ${e.isDirectory ? '$(folder)' : '$(file)'} ${e.remote} → ${e.local}`,
        description: `Last used: ${new Date(e.lastUsed).toLocaleDateString()} | Excludes: ${(e.excludes || []).length}`,
        entry: e,
    }));

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, entry: 'browse' });
    items.push({
        label: `$(folder-opened) Browse ${direction === 'upload' ? 'local' : 'remote'}...`,
        entry: 'browse',
    });

    return vscode.window.showQuickPick(items, {
        placeHolder: `Select ${direction} history or browse...`,
    }).then(pick => pick?.entry);
}

/**
 * 本地文件浏览（QuickPick 统一风格）
 */
async function pickLocalPath(direction: 'upload' | 'download'): Promise<string | undefined> {
    let currentPath = process.env.HOME || '/';
    const selectFolderButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check'),
        tooltip: 'Select this folder directly',
    };

    while (true) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            const items: FolderPickItem[] = [];
            items.push({
                label: '$(folder-opened) Select current folder',
                description: currentPath,
                detail: currentPath,
                buttons: [selectFolderButton],
            });
            const localFolderHistory = getLocalFolderHistory();
            if (localFolderHistory.length > 0) {
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
                items.push({ label: '$(history) Recent local folders' });
                for (const folder of localFolderHistory) {
                    items.push({
                        label: `$(folder) ${path.basename(folder) || folder}`,
                        description: folder,
                        detail: folder,
                        buttons: [selectFolderButton],
                        alwaysSelectFolder: true,
                    });
                }
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            }
            if (currentPath !== '/') {
                items.push({ label: '$(arrow-up) ..', description: 'parent' });
            }

            const dirs: vscode.QuickPickItem[] = [];
            const files: vscode.QuickPickItem[] = [];
            for (const e of entries) {
                if (e.name.startsWith('.')) continue;
                const fullPath = path.join(currentPath, e.name);
                if (e.isDirectory()) {
                    dirs.push({ label: `$(folder) ${e.name}`, description: fullPath, buttons: [selectFolderButton] });
                } else if (direction === 'upload') {
                    files.push({ label: `$(file) ${e.name}`, description: fullPath });
                }
            }

            items.push(...dirs.sort((a, b) => a.label.localeCompare(b.label)));
            if (direction === 'upload') {
                items.push(...files.sort((a, b) => a.label.localeCompare(b.label)));
            }

            const quickPick = vscode.window.createQuickPick<FolderPickItem>();
            quickPick.items = items;
            quickPick.matchOnDescription = true;
            quickPick.title = stageTitle(direction === 'upload' ? 'source' : 'target', currentPath);
            quickPick.placeholder = direction === 'upload'
                ? `Select local source: ${currentPath} (Enter folder to recurse; click ✓ to select folder directly)`
                : `Select local save target: ${currentPath} (Enter folder to recurse; click ✓ to select folder directly)`;

            let pickedByButton = false;
            const pick = await new Promise<FolderPickItem | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    resolve(quickPick.selectedItems[0]);
                    quickPick.hide();
                });
                quickPick.onDidHide(() => resolve(undefined));
                quickPick.onDidTriggerItemButton((event) => {
                    pickedByButton = true;
                    if (event.item.description && event.item.label.startsWith('$(folder)')) {
                        resolve(event.item);
                        quickPick.hide();
                    }
                });
                quickPick.show();
            });

            if (!pick) return undefined;
            if (pick.description === 'parent') {
                currentPath = path.dirname(currentPath);
                continue;
            }
            if (pick.label.startsWith('$(folder-opened)')) {
                addLocalFolderHistory(currentPath);
                return currentPath;
            }
            if (pick.description && pick.label.startsWith('$(folder)')) {
                if (pick.alwaysSelectFolder) {
                    addLocalFolderHistory(pick.description);
                    return pick.description;
                }
                if (pickedByButton) {
                    addLocalFolderHistory(pick.description);
                    return pick.description;
                }
                currentPath = pick.description;
                continue;
            }
            if (pick.description) {
                return pick.description;
            }
        } catch {
            vscode.window.showErrorMessage(`Failed to read directory: ${currentPath}`);
            return undefined;
        }
    }
}

/**
 * 选择服务器上的目标路径（通过 SSH ls 列出文件）
 */
async function pickRemotePath(
    serverNode: SshHostNode,
    initialPath: string = '/'
): Promise<string | undefined> {
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
    if (serverNode.port) {
        sshArgs.push('-p', serverNode.port);
    }
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = serverNode.hostname || serverNode.host;

    let currentPath = initialPath;
    const selectFolderButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check'),
        tooltip: 'Select this folder directly',
    };

    while (true) {
        const lsCmd = `ls -la "${currentPath}" 2>/dev/null`;

        try {
            const output = await new Promise<string>((resolve, reject) => {
                const proc = spawn('ssh', [...sshArgs, `${user}${host}`, lsCmd], {
                    timeout: 10000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                let out = '';
                proc.stdout.on('data', (d) => { out += d.toString(); });
                proc.on('close', (code) => {
                    if (code === 0) resolve(out);
                    else reject(new Error(`Failed to list remote directory`));
                });
                proc.on('error', reject);
            });

            const entries: { name: string; isDir: boolean; fullPath: string }[] = [];
            for (const line of output.split('\n').slice(1)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 9) continue;
                const name = parts.slice(8).join(' ');
                if (name === '.' || name === '..') continue;
                const isDir = parts[0].startsWith('d');
                entries.push({ name, isDir, fullPath: path.posix.join(currentPath, name) });
            }

            const items: FolderPickItem[] = [];
            items.push({
                label: '$(folder-opened) Select current folder',
                description: currentPath,
                detail: currentPath,
                buttons: [selectFolderButton],
            });
            const remoteFolderHistory = getRemoteFolderHistory(serverNode.host);
            if (remoteFolderHistory.length > 0) {
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
                items.push({ label: '$(history) Recent remote folders' });
                for (const folder of remoteFolderHistory) {
                    items.push({
                        label: `$(folder) ${path.posix.basename(folder) || folder}`,
                        description: folder,
                        detail: folder,
                        buttons: [selectFolderButton],
                        alwaysSelectFolder: true,
                    });
                }
                items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            }
            if (currentPath !== '/') {
                items.push({ label: '$(arrow-up) ..', description: 'parent' });
            }
            for (const e of entries.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1))) {
                items.push({
                    label: e.isDir ? `$(folder) ${e.name}` : `$(file) ${e.name}`,
                    description: e.fullPath,
                    buttons: e.isDir ? [selectFolderButton] : undefined,
                });
            }

            const quickPick = vscode.window.createQuickPick<FolderPickItem>();
            quickPick.items = items;
            quickPick.matchOnDescription = true;
            quickPick.title = stageTitle('target', currentPath);
            quickPick.placeholder = `Remote: ${currentPath} (Enter folder to recurse; click ✓ to select folder directly)`;

            let pickedByButton = false;
            const pick = await new Promise<FolderPickItem | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    resolve(quickPick.selectedItems[0]);
                    quickPick.hide();
                });
                quickPick.onDidHide(() => resolve(undefined));
                quickPick.onDidTriggerItemButton((event) => {
                    pickedByButton = true;
                    if (event.item.description && event.item.label.startsWith('$(folder)')) {
                        resolve(event.item);
                        quickPick.hide();
                    }
                });
                quickPick.show();
            });

            if (!pick) return undefined;
            if (pick.description === 'parent') {
                currentPath = path.posix.dirname(currentPath);
                continue;
            }
            if (pick.label.startsWith('$(folder-opened)')) {
                addRemoteFolderHistory(serverNode.host, currentPath);
                return currentPath;
            }
            if (pick.description && pick.label.startsWith('$(folder)')) {
                if (pick.alwaysSelectFolder) {
                    addRemoteFolderHistory(serverNode.host, pick.description);
                    return pick.description;
                }
                if (pickedByButton) {
                    addRemoteFolderHistory(serverNode.host, pick.description);
                    return pick.description;
                }
                currentPath = pick.description;
                continue;
            }
            // 选了文件，返回文件路径
            if (pick.description) {
                return pick.description;
            }
        } catch {
            vscode.window.showErrorMessage('Failed to connect to server to list files');
            return undefined;
        }
    }
}

async function pickLocalExcludes(sourceRoot: string): Promise<string[] | undefined> {
    const excludes: string[] = [];
    let currentPath = sourceRoot;
    const selectFolderButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check'),
        tooltip: 'Exclude this folder',
    };

    while (true) {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        const items: FolderPickItem[] = [
            { label: '$(debug-step-over) Skip exclude file/folder', description: 'skip' },
            { label: '$(check) Done choosing excludes', description: 'done' },
            {
                label: '$(folder-opened) Exclude current folder',
                description: currentPath,
                detail: currentPath,
                buttons: [selectFolderButton],
            },
        ];
        if (currentPath !== sourceRoot) {
            items.push({ label: '$(arrow-up) ..', description: 'parent' });
        }
        for (const e of entries) {
            if (e.name === '.' || e.name === '..') continue;
            const fullPath = path.join(currentPath, e.name);
            if (e.isDirectory()) {
                items.push({ label: `$(folder) ${e.name}`, description: fullPath, buttons: [selectFolderButton] });
            } else {
                items.push({ label: `$(file) ${e.name}`, description: fullPath });
            }
        }

        const quickPick = vscode.window.createQuickPick<FolderPickItem>();
        quickPick.items = items;
        quickPick.matchOnDescription = true;
        quickPick.title = stageTitle('exclude', currentPath);
        quickPick.placeholder = `Exclude picker: ${currentPath} (Enter folder to recurse; click ✓ to exclude folder directly)`;

        let pickedByButton = false;
        const pick = await new Promise<FolderPickItem | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems[0]);
                quickPick.hide();
            });
            quickPick.onDidHide(() => resolve(undefined));
            quickPick.onDidTriggerItemButton((event) => {
                pickedByButton = true;
                resolve(event.item);
                quickPick.hide();
            });
            quickPick.show();
        });

        if (!pick) return undefined;
        if (pick.description === 'skip') return [];
        if (pick.description === 'done') return excludes;
        if (pick.description === 'parent') {
            currentPath = path.dirname(currentPath);
            continue;
        }
        if (pick.label.startsWith('$(folder-opened)')) {
            const relCurrent = path.relative(sourceRoot, currentPath).split(path.sep).join('/');
            if (relCurrent && !excludes.includes(relCurrent)) {
                excludes.push(relCurrent);
                vscode.window.showInformationMessage(`Added exclude: ${relCurrent}`);
            }
            continue;
        }
        if (!pick.description) {
            continue;
        }

        if (pick.label.startsWith('$(folder)') && !pickedByButton) {
            currentPath = pick.description;
            continue;
        }

        const rel = path.relative(sourceRoot, pick.description).split(path.sep).join('/');
        if (rel && !excludes.includes(rel)) {
            excludes.push(rel);
            vscode.window.showInformationMessage(`Added exclude: ${rel}`);
        }
    }
}

async function pickRemoteExcludes(serverNode: SshHostNode, sourceRoot: string): Promise<string[] | undefined> {
    const excludes: string[] = [];
    let currentPath = sourceRoot;
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
    if (serverNode.port) {
        sshArgs.push('-p', serverNode.port);
    }
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = getSshHostAddress(serverNode);
    const selectFolderButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('check'),
        tooltip: 'Exclude this folder',
    };

    while (true) {
        const lsCmd = `ls -la "${currentPath}" 2>/dev/null`;
        try {
            const output = await new Promise<string>((resolve, reject) => {
                const proc = spawn('ssh', [...sshArgs, `${user}${host}`, lsCmd], {
                    timeout: 10000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                let out = '';
                proc.stdout.on('data', (d) => { out += d.toString(); });
                proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('failed'))));
                proc.on('error', reject);
            });

            const items: FolderPickItem[] = [
                { label: '$(debug-step-over) Skip exclude file/folder', description: 'skip' },
                { label: '$(check) Done choosing excludes', description: 'done' },
                {
                    label: '$(folder-opened) Exclude current folder',
                    description: currentPath,
                    detail: currentPath,
                    buttons: [selectFolderButton],
                },
            ];
            if (currentPath !== sourceRoot) {
                items.push({ label: '$(arrow-up) ..', description: 'parent' });
            }

            for (const line of output.split('\n').slice(1)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 9) continue;
                const name = parts.slice(8).join(' ');
                if (name === '.' || name === '..') continue;
                const isDir = parts[0].startsWith('d');
                const fullPath = path.posix.join(currentPath, name);
                items.push({
                    label: isDir ? `$(folder) ${name}` : `$(file) ${name}`,
                    description: fullPath,
                    buttons: isDir ? [selectFolderButton] : undefined,
                });
            }

            const quickPick = vscode.window.createQuickPick<FolderPickItem>();
            quickPick.items = items;
            quickPick.matchOnDescription = true;
            quickPick.title = stageTitle('exclude', currentPath);
            quickPick.placeholder = `Remote excludes: ${currentPath} (Enter folder to recurse; click ✓ to exclude folder directly)`;

            let pickedByButton = false;
            const pick = await new Promise<FolderPickItem | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    resolve(quickPick.selectedItems[0]);
                    quickPick.hide();
                });
                quickPick.onDidHide(() => resolve(undefined));
                quickPick.onDidTriggerItemButton((event) => {
                    pickedByButton = true;
                    resolve(event.item);
                    quickPick.hide();
                });
                quickPick.show();
            });

            if (!pick) return undefined;
            if (pick.description === 'skip') return [];
            if (pick.description === 'done') return excludes;
            if (pick.description === 'parent') {
                currentPath = path.posix.dirname(currentPath);
                continue;
            }
            if (pick.label.startsWith('$(folder-opened)')) {
                const relCurrent = path.posix.relative(sourceRoot, currentPath);
                if (relCurrent && !excludes.includes(relCurrent)) {
                    excludes.push(relCurrent);
                    vscode.window.showInformationMessage(`Added exclude: ${relCurrent}`);
                }
                continue;
            }
            if (!pick.description) {
                continue;
            }
            if (pick.label.startsWith('$(folder)') && !pickedByButton) {
                currentPath = pick.description;
                continue;
            }

            const rel = path.posix.relative(sourceRoot, pick.description);
            if (rel && !excludes.includes(rel)) {
                excludes.push(rel);
                vscode.window.showInformationMessage(`Added exclude: ${rel}`);
            }
        } catch {
            vscode.window.showErrorMessage('Failed to load remote excludes');
            return undefined;
        }
    }
}

async function confirmRsyncCommand(cmd: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
        `Run command?\n${cmd}\n\n⚠️ If target would create duplicate nested folders, please choose target parent folder instead.`,
        { modal: true },
        'Run',
        'Cancel'
    );
    return choice === 'Run';
}

/**
 * 执行 rsync 上传
 */
async function scpUpload(
    serverNode: SshHostNode,
    localPath: string,
    remoteDir: string,
    excludes: string[] = []
): Promise<void> {
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = serverNode.hostname || serverNode.host;
    const isDir = fs.statSync(localPath).isDirectory();

    let sshOpts = '-e "ssh';
    if (serverNode.port) {
        sshOpts += ` -p ${serverNode.port}`;
    }
    sshOpts += '"';

    let src: string;
    let dst: string;
    
    if (isDir) {
        // 文件夹：目标端无脑加上源文件夹名
        const localFolderName = path.basename(localPath);
        src = `${localPath}/`;
        dst = `${user}${host}:${remoteDir}/${localFolderName}/`;
    } else {
        // 文件：源端不加 /，目标端是目录不加文件名
        src = localPath;
        dst = `${user}${host}:${remoteDir}`;
    }

    const excludeArgs = excludes.map((e) => `--exclude="${e}"`).join(' ');
    const cmd = `rsync -avz --progress --delete ${excludeArgs} ${sshOpts} "${src}" "${dst}"`.replace(/\s+/g, ' ').trim();
    if (!(await confirmRsyncCommand(cmd))) {
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Upload: ${path.basename(localPath)}`,
    });
    terminal.show(true);
    terminal.sendText(cmd, true);

    addSyncHistory(serverNode.host, 'upload', localPath, remoteDir, isDir, excludes);
    vscode.window.showInformationMessage(`Uploading ${isDir ? 'folder' : 'file'}: ${path.basename(localPath)}`);
}

/**
 * 执行 rsync 下载
 */
async function scpDownload(
    serverNode: SshHostNode,
    remotePath: string,
    localDir: string,
    excludes: string[] = []
): Promise<void> {
    const user = serverNode.user ? `${serverNode.user}@` : '';
    const host = serverNode.hostname || serverNode.host;
    const remoteFull = `${user}${host}:${remotePath}`;

    let sshOpts = '-e "ssh';
    if (serverNode.port) {
        sshOpts += ` -p ${serverNode.port}`;
    }
    sshOpts += '"';

    // 检测远程路径是文件还是文件夹
    const isDir = await isRemoteDirectory(serverNode, remotePath);
    
    let src: string;
    let dst: string;
    
    if (isDir) {
        // 文件夹：目标端无脑加上源文件夹名
        const remoteFolderName = path.posix.basename(remotePath);
        src = `${remoteFull}/`;
        dst = `${localDir}/${remoteFolderName}/`;
    } else {
        src = remoteFull;
        dst = localDir;
    }

    const excludeArgs = excludes.map((e) => `--exclude="${e}"`).join(' ');
    const cmd = `rsync -avz --progress --delete ${excludeArgs} ${sshOpts} "${src}" "${dst}"`.replace(/\s+/g, ' ').trim();
    if (!(await confirmRsyncCommand(cmd))) {
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Download: ${path.basename(remotePath)}`,
    });
    terminal.show(true);
    terminal.sendText(cmd, true);

    addSyncHistory(serverNode.host, 'download', localDir, remotePath, isDir, excludes);
    vscode.window.showInformationMessage(`Downloading ${isDir ? 'folder' : 'file'}: ${path.basename(remotePath)}`);
}

/**
 * 上传命令：选择本地 → 选择远程目标 → scp 上传
 */
async function syncUpload(node: SshTreeNode) {
    if (!node || node.kind !== 'host') return;

    const history = getSyncHistory(node.host, 'upload');
    if (history.length > 0) {
        const pick = await showHistoryQuickPick(history, 'upload');
        if (pick && pick !== 'browse') {
            await scpUpload(node, pick.local, pick.remote, pick.excludes || []);
            return;
        }
        if (pick === undefined) return;
    }

    vscode.window.showInformationMessage('🟦 Select source first');
    const localPath = await pickLocalPath('upload');
    if (!localPath) return;
    const isDir = fs.existsSync(localPath) && fs.statSync(localPath).isDirectory();
    const excludes = isDir ? (vscode.window.showInformationMessage('🟨 Select exclude items (or skip)'), await pickLocalExcludes(localPath)) : [];
    if (excludes === undefined) return;

    vscode.window.showInformationMessage('🟩 Select target folder');
    const remoteDir = await pickRemotePath(node);
    if (!remoteDir) return;

    await scpUpload(node, localPath, remoteDir, excludes);
}

/**
 * 下载命令：选择远程文件 → 选择本地目标 → scp 下载
 */
async function syncDownload(node: SshTreeNode) {
    if (!node || node.kind !== 'host') return;

    const history = getSyncHistory(node.host, 'download');
    if (history.length > 0) {
        const pick = await showHistoryQuickPick(history, 'download');
        if (pick && pick !== 'browse') {
            await scpDownload(node, pick.remote, pick.local, pick.excludes || []);
            return;
        }
        if (pick === undefined) return;
    }

    vscode.window.showInformationMessage('🟦 Select source first');
    const remotePath = await pickRemotePath(node);
    if (!remotePath) return;
    const isDir = await isRemoteDirectory(node, remotePath);
    const excludes = isDir ? (vscode.window.showInformationMessage('🟨 Select exclude items (or skip)'), await pickRemoteExcludes(node, remotePath)) : [];
    if (excludes === undefined) return;

    vscode.window.showInformationMessage('🟩 Select target folder');
    const localDir = await pickLocalPath('download');
    if (!localDir) return;

    await scpDownload(node, remotePath, localDir, excludes);
}

/**
 * 注册 SSH Server 视图
 */
export function registerSshServerView(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new SshServerProvider();
    const treeView = vscode.window.createTreeView(`${EXTENSION_ID}_ssh`, {
        treeDataProvider: provider,
        showCollapseAll: false,
    });

    const connectCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.connectSsh`, connectSsh);
    const openConfigCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.openSshConfig`, openSshConfig);
    const refreshCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.refreshSsh`, () => {
        provider.refresh();
    });
    const uploadCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.syncUpload`, syncUpload);
    const downloadCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.syncDownload`, syncDownload);
    const copyIpCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.copySshIp`, copySshIp);
    const setStartCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.setSshStartCommand`, openSshStartCommandConfig);
    const editHostCmd = vscode.commands.registerCommand(`${EXTENSION_ID}.editSshHost`, editSshHost);

    const providerDisposable = vscode.Disposable.from(
        new vscode.Disposable(() => provider.dispose())
    );

    return [treeView, connectCmd, openConfigCmd, refreshCmd, uploadCmd, downloadCmd, copyIpCmd, setStartCmd, editHostCmd, providerDisposable];
}
