import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { EXTENSION_ID } from './constants';

// ──────────────────────────── Types ────────────────────────────

/** 顶层分组节点，如 rsl_rl/g1_tracking */
interface TaskGroupNode {
    kind: 'taskGroup';
    label: string;
    children: RunFolderNode[];
}

/** 单次训练运行文件夹，如 2026-04-20_11-49-29 */
interface RunFolderNode {
    kind: 'runFolder';
    /** 文件夹名（即日期时间串） */
    name: string;
    /** 文件夹绝对路径 */
    folderPath: string;
    /** 从文件夹名解析的时间戳 */
    parsedTime: number;
    /** 文件夹内的可展示文件/子文件夹 */
    children: RunChildNode[];
}

/** 运行文件夹内的子文件夹，如 params/git */
interface RunDirectoryNode {
    kind: 'runDirectory';
    name: string;
    fullPath: string;
    children: RunChildNode[];
    parent: RunFolderNode | RunDirectoryNode;
}

/** 运行文件夹内的具体文件（神经网络模型文件，如 pt/onnx/torchscript） */
interface RunFileNode {
    kind: 'runFile';
    name: string;
    fullPath: string;
    size: number;
    /** 所属文件夹引用，用于 getParent */
    parent: RunFolderNode | RunDirectoryNode;
}

type RunChildNode = RunDirectoryNode | RunFileNode;
type LogsNode = TaskGroupNode | RunFolderNode | RunDirectoryNode | RunFileNode;

// ──────────────────── Logs directory discovery ─────────────────

/** 在工作区各项目内查找名为 `log`/`logs` 目录的最大深度（直接子目录为第 1 层）。 */
const LOGS_DIR_SEARCH_DEPTH = 2;
/** 在每个 logs 目录内递归查找运行文件夹的最大深度。 */
const RUN_SCAN_DEPTH = 4;
/** 自动扫描间隔（毫秒）。 */
const AUTO_SCAN_INTERVAL_MS = 5000;

/**
 * 在所有工作区项目内自动发现 `log` / `logs` 目录，最多向下 LOGS_DIR_SEARCH_DEPTH 层。
 * 不依赖任何用户设置，避免因 workspace key 不匹配而扫不到。
 */
function discoverLogsRoots(): string[] {
    const roots: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        findLogsDirs(folder.uri.fsPath, 1, roots);
    }
    return [...new Set(roots)];
}

function findLogsDirs(dir: string, depth: number, out: string[]): void {
    if (depth > LOGS_DIR_SEARCH_DEPTH) return;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes('log')) {
            out.push(full); // 名称包含 "log" 即视为 logs 根，不再深入其内部寻找别的
            continue;
        }
        findLogsDirs(full, depth + 1, out);
    }
}

// ──────────────────────── File scanning ────────────────────────

/**
 * 从字符串中解析 `2026-04-20_13-11-53` 格式的日期时间。
 */
function parseTimeFromName(name: string): number {
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return 0;
    return new Date(
        parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
        parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
    ).getTime();
}

/** 常见神经网络模型文件扩展名（小写，含点）。 */
const MODEL_FILE_EXTENSIONS = new Set([
    '.pt', '.pth',                                  // PyTorch 权重 / TorchScript
    '.onnx',                                        // ONNX
    '.ts', '.torchscript', '.jit', '.ptc', '.pt2', // TorchScript / 编译产物
    '.safetensors', '.ckpt', '.bin',               // 通用权重
    '.pb', '.h5', '.keras', '.tflite',             // TensorFlow / Keras
    '.engine', '.plan', '.trt',                    // TensorRT
    '.gguf', '.mlmodel',                           // llama.cpp / CoreML
]);

/** 判断文件是否为常见神经网络模型文件。 */
function isModelFile(name: string): boolean {
    return MODEL_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function createFileNode(
    parent: RunFolderNode | RunDirectoryNode,
    filePath: string,
    name: string,
): RunFileNode | null {
    try {
        const stat = fs.statSync(filePath);
        return {
            kind: 'runFile',
            name,
            fullPath: filePath,
            size: stat.size,
            parent,
        };
    } catch {
        return null;
    }
}

function sortRunChildren(children: RunChildNode[]): RunChildNode[] {
    return children.sort((a, b) => {
        if (a.kind !== b.kind) {
            return a.kind === 'runDirectory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function buildRunChildren(
    dirPath: string,
    parent: RunFolderNode | RunDirectoryNode,
    depth: number = 0,
    maxDepth: number = 20,
): RunChildNode[] {
    if (depth > maxDepth) return [];

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return [];
    }

    const children: RunChildNode[] = [];

    for (const e of entries) {
        const fullPath = path.join(dirPath, e.name);

        if (e.isDirectory()) {
            const dirNode: RunDirectoryNode = {
                kind: 'runDirectory',
                name: e.name,
                fullPath,
                children: [],
                parent,
            };
            dirNode.children = buildRunChildren(fullPath, dirNode, depth + 1, maxDepth);
            // 剪掉不含任何模型文件的空目录，保持视图整洁
            if (dirNode.children.length > 0) children.push(dirNode);
            continue;
        }

        if (!e.isFile()) continue;

        // 只保留常见神经网络模型文件；.pt 不再按序号过滤，全部展示
        if (!isModelFile(e.name)) continue;

        const fileNode = createFileNode(parent, fullPath, e.name);
        if (fileNode) children.push(fileNode);
    }

    return sortRunChildren(children);
}

/**
 * 判断一个目录是否为「训练运行文件夹」。
 * 条件：文件夹名匹配日期格式 YYYY-MM-DD_HH-MM-SS，
 *       且（顶层）包含至少一个神经网络模型文件。
 */
function isRunFolder(dirName: string, entries: fs.Dirent[]): boolean {
    if (!parseTimeFromName(dirName)) return false;
    return entries.some(e => e.isFile() && isModelFile(e.name));
}

/**
 * 在单个 logs 根目录内递归查找训练运行文件夹（含 .onnx 或 model_*.pt），
 * 按任务路径分组（不做任何日期过滤）。
 *
 * 目录结构:
 *   logs / <任意层级任务路径> / <日期文件夹> / {*.onnx, model_*.pt, ...}
 *
 * 返回 groupKey（相对 logs 根的父路径）→ 运行文件夹列表。
 */
function scanLogsRoot(directory: string, maxDepth: number = RUN_SCAN_DEPTH): Map<string, RunFolderNode[]> {
    const groupMap = new Map<string, RunFolderNode[]>();

    function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        const folderName = path.basename(dir);

        if (isRunFolder(folderName, entries)) {
            // 当前 dir 是运行文件夹
            const parsedTime = parseTimeFromName(folderName);

            // 分组 key = 相对于 logs 根目录的父路径
            const relToRoot = path.relative(directory, dir);
            const parts = relToRoot.split(path.sep);
            const groupKey = parts.length > 1
                ? parts.slice(0, parts.length - 1).join('/')
                : '(root)';

            // 构建 RunFolderNode
            const runFolder: RunFolderNode = {
                kind: 'runFolder',
                name: folderName,
                folderPath: dir,
                parsedTime,
                children: [],
            };
            runFolder.children = buildRunChildren(dir, runFolder);

            const list = groupMap.get(groupKey) ?? [];
            list.push(runFolder);
            groupMap.set(groupKey, list);
            return; // 不再往下递归
        }

        // 不是 run folder，继续递归子目录
        for (const e of entries) {
            if (e.isDirectory()) {
                walk(path.join(dir, e.name), depth + 1);
            }
        }
    }

    walk(directory, 0);
    return groupMap;
}

/**
 * 扫描所有自动发现的 logs 根目录，合并为分组列表。
 * 存在多个 logs 根时，分组标签前缀其所在项目名以避免冲突。
 */
function scanAllLogs(): TaskGroupNode[] {
    const roots = discoverLogsRoots();
    const rootNames = labelRoots(roots);
    const merged = new Map<string, RunFolderNode[]>();

    for (const root of roots) {
        const rootName = rootNames.get(root)!;
        for (const [key, runs] of scanLogsRoot(root)) {
            // logs 文件夹名作为顶层分组，其下接任务路径
            const label = key === '(root)' ? rootName : `${rootName}/${key}`;
            const list = merged.get(label) ?? [];
            list.push(...runs);
            merged.set(label, list);
        }
    }

    const result: TaskGroupNode[] = [];
    for (const [label, runs] of merged) {
        // 每个分组内按文件名时间降序（最新在前）
        runs.sort((a, b) => b.parsedTime - a.parsedTime);
        result.push({ kind: 'taskGroup', label, children: runs });
    }
    result.sort((a, b) => a.label.localeCompare(b.label));
    return result;
}

/**
 * 为每个 logs 根计算一个顶层显示名（其文件夹名）。
 * 若多个根的文件夹名相同，则用「父目录名/文件夹名」消歧。
 */
function labelRoots(roots: string[]): Map<string, string> {
    const counts = new Map<string, number>();
    for (const r of roots) {
        const b = path.basename(r);
        counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const out = new Map<string, string>();
    for (const r of roots) {
        const b = path.basename(r);
        out.set(r, counts.get(b)! > 1 ? `${path.basename(path.dirname(r))}/${b}` : b);
    }
    return out;
}

/** 为扫描结果生成一个签名，用于检测自动扫描时内容是否变化。 */
function signatureOf(groups: TaskGroupNode[]): string {
    const parts: string[] = [];
    const visit = (n: LogsNode) => {
        if (n.kind === 'runFile') {
            parts.push(`f:${n.fullPath}:${n.size}`);
        } else if (n.kind === 'runDirectory') {
            parts.push(`d:${n.fullPath}`);
            n.children.forEach(visit);
        } else if (n.kind === 'runFolder') {
            parts.push(`r:${n.folderPath}`);
            n.children.forEach(visit);
        } else {
            parts.push(`g:${n.label}`);
            n.children.forEach(visit);
        }
    };
    groups.forEach(visit);
    return parts.join('|');
}

// ──────────────────────── TreeDataProvider ──────────────────────

class LogsExplorerProvider implements vscode.TreeDataProvider<LogsNode> {
    private _onDidChange = new vscode.EventEmitter<LogsNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private groups: TaskGroupNode[] = [];
    private signature = '';
    private autoScanTimer?: ReturnType<typeof setInterval>;

    constructor() {
        this.rescan();
        // 每 AUTO_SCAN_INTERVAL_MS 自动扫描一次，仅在内容变化时刷新视图，
        // 避免无谓地重置树的展开状态。
        this.autoScanTimer = setInterval(() => {
            const before = this.signature;
            this.rescan();
            if (this.signature !== before) {
                this._onDidChange.fire();
            }
        }, AUTO_SCAN_INTERVAL_MS);
    }

    refresh(): void {
        this.rescan();
        this._onDidChange.fire();
    }

    dispose(): void {
        if (this.autoScanTimer) {
            clearInterval(this.autoScanTimer);
            this.autoScanTimer = undefined;
        }
        this._onDidChange.dispose();
    }

    private rescan(): void {
        this.groups = scanAllLogs();
        this.signature = signatureOf(this.groups);
    }

    // ──── TreeDataProvider API ────

    getTreeItem(element: LogsNode): vscode.TreeItem {
        if (element.kind === 'taskGroup') {
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
            item.iconPath = new vscode.ThemeIcon('folder-library');
            item.contextValue = 'taskGroup';
            item.description = `${element.children.length} runs`;
            return item;
        }

        if (element.kind === 'runFolder') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'runFolder';
            item.tooltip = element.folderPath;
            item.resourceUri = vscode.Uri.file(element.folderPath);
            const folderCount = element.children.filter(c => c.kind === 'runDirectory').length;
            const fileCount = element.children.filter(c => c.kind === 'runFile').length;
            item.description = `${folderCount} folders  ${fileCount} files`;
            return item;
        }

        if (element.kind === 'runDirectory') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.contextValue = 'runDirectory';
            item.tooltip = element.fullPath;
            item.resourceUri = vscode.Uri.file(element.fullPath);
            item.iconPath = new vscode.ThemeIcon('folder');
            return item;
        }

        // runFile
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'runFile';
        item.description = formatSize(element.size);
        item.tooltip = element.fullPath;
        item.resourceUri = vscode.Uri.file(element.fullPath);
        item.command = {
            command: 'vscode.open',
            title: 'Open',
            arguments: [vscode.Uri.file(element.fullPath)],
        };
        if (element.name.endsWith('.onnx')) {
            item.iconPath = new vscode.ThemeIcon('file-binary');
        } else {
            item.iconPath = new vscode.ThemeIcon('file');
        }
        return item;
    }

    getChildren(element?: LogsNode): LogsNode[] {
        if (!element) {
            return this.groups;
        }
        if (element.kind === 'taskGroup') {
            return element.children;
        }
        if (element.kind === 'runFolder') {
            return element.children;
        }
        if (element.kind === 'runDirectory') {
            return element.children;
        }
        return [];
    }

    getParent(element: LogsNode): LogsNode | undefined {
        if (element.kind === 'runFile') {
            return element.parent;
        }
        if (element.kind === 'runDirectory') {
            return element.parent;
        }
        if (element.kind === 'runFolder') {
            return this.groups.find(g => g.children.includes(element));
        }
        return undefined;
    }
}

// ──────────────────────── Helpers ──────────────────────────────

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 从一组节点中收集可复制的资源路径。
 * 文件/文件夹节点按资源本身复制，taskGroup 展开为其下的 runFolder。
 */
function collectResourcePaths(nodes: LogsNode[]): string[] {
    const paths: string[] = [];
    for (const n of nodes) {
        if (n.kind === 'runFile') {
            paths.push(n.fullPath);
        } else if (n.kind === 'runDirectory') {
            paths.push(n.fullPath);
        } else if (n.kind === 'runFolder') {
            paths.push(n.folderPath);
        } else if (n.kind === 'taskGroup') {
            for (const run of n.children) {
                paths.push(run.folderPath);
            }
        }
    }
    return [...new Set(paths)]; // 去重
}

function collectComparableFilePaths(nodes: LogsNode[]): string[] {
    const paths: string[] = [];

    function visit(node: LogsNode): void {
        if (node.kind === 'runFile') {
            paths.push(node.fullPath);
        } else if (node.kind === 'runDirectory' || node.kind === 'runFolder') {
            for (const child of node.children) visit(child);
        } else if (node.kind === 'taskGroup') {
            for (const run of node.children) visit(run);
        }
    }

    for (const node of nodes) visit(node);
    return [...new Set(paths)];
}

// ──────────────────── Command handlers ─────────────────────────

/**
 * 复制选中文件到系统剪贴板（GNOME 格式），
 * 支持 Ctrl/Shift 多选，可在文件管理器中 Ctrl+V 粘贴。
 */
async function cmdCopyOnnxFiles(
    treeView: vscode.TreeView<LogsNode>,
    _clickedNode: LogsNode | undefined,
    _selectedNodes: LogsNode[] | undefined,
) {
    let nodes: LogsNode[] = _selectedNodes?.length ? _selectedNodes : [];
    if (!nodes.length) nodes = [...treeView.selection];
    if (!nodes.length && _clickedNode) nodes = [_clickedNode];

    const filePaths = collectResourcePaths(nodes);
    if (!filePaths.length) {
        vscode.window.showWarningMessage('没有选中任何文件或文件夹');
        return;
    }

    const content = 'copy\n' + filePaths.map(p => vscode.Uri.file(p).toString()).join('\n');
    const xclip = spawn('xclip', ['-selection', 'clipboard', '-t', 'x-special/gnome-copied-files']);
    xclip.on('error', () => {
        vscode.window.showErrorMessage('复制失败: 未找到 xclip。请运行: sudo apt install xclip');
    });
    xclip.stdin.on('error', () => { /* avoid uncaught EPIPE when xclip missing */ });
    xclip.stdin.write(content);
    xclip.stdin.end();
    xclip.on('close', (code) => {
        if (code === 0) {
            vscode.window.setStatusBarMessage(`已复制 ${filePaths.length} 个文件到剪贴板`, 3000);
        }
    });
}

async function cmdCopyOnnxFilePath(
    treeView: vscode.TreeView<LogsNode>,
    _clickedNode: LogsNode | undefined,
    _selectedNodes: LogsNode[] | undefined,
) {
    let nodes: LogsNode[] = _selectedNodes?.length ? _selectedNodes : [];
    if (!nodes.length) nodes = [...treeView.selection];
    if (!nodes.length && _clickedNode) nodes = [_clickedNode];

    const paths = collectResourcePaths(nodes);
    if (!paths.length) return;
    await vscode.env.clipboard.writeText(paths.join('\n'));
    vscode.window.setStatusBarMessage(`已复制 ${paths.length} 条路径`, 2000);
}

async function cmdCopyRelativeLogPath(
    treeView: vscode.TreeView<LogsNode>,
    _clickedNode: LogsNode | undefined,
    _selectedNodes: LogsNode[] | undefined,
) {
    let nodes: LogsNode[] = _selectedNodes?.length ? _selectedNodes : [];
    if (!nodes.length) nodes = [...treeView.selection];
    if (!nodes.length && _clickedNode) nodes = [_clickedNode];

    const paths = collectResourcePaths(nodes);
    if (!paths.length) return;

    const relativePaths = paths.map(p => vscode.workspace.asRelativePath(p, false) || '.');
    await vscode.env.clipboard.writeText(relativePaths.join('\n'));
    vscode.window.setStatusBarMessage(`已复制 ${relativePaths.length} 条相对路径`, 2000);
}

async function cmdCopyLogFileName(
    treeView: vscode.TreeView<LogsNode>,
    _clickedNode: LogsNode | undefined,
    _selectedNodes: LogsNode[] | undefined,
) {
    let nodes: LogsNode[] = _selectedNodes?.length ? _selectedNodes : [];
    if (!nodes.length) nodes = [...treeView.selection];
    if (!nodes.length && _clickedNode) nodes = [_clickedNode];

    const paths = collectResourcePaths(nodes);
    if (!paths.length) return;
    const names = paths.map(p => path.basename(p));
    await vscode.env.clipboard.writeText(names.join('\n'));
    vscode.window.setStatusBarMessage(`已复制 ${names.length} 个名称`, 2000);
}

async function cmdCompareSelectedLogFiles(
    treeView: vscode.TreeView<LogsNode>,
    _clickedNode: LogsNode | undefined,
    _selectedNodes: LogsNode[] | undefined,
) {
    let nodes: LogsNode[] = _selectedNodes?.length ? _selectedNodes : [];
    if (!nodes.length) nodes = [...treeView.selection];
    if (!nodes.length && _clickedNode) nodes = [_clickedNode];

    const paths = collectComparableFilePaths(nodes);
    if (paths.length !== 2) {
        vscode.window.showWarningMessage(`请选择 2 个文件进行比较；当前选中 ${paths.length} 个文件`);
        return;
    }

    const left = vscode.Uri.file(paths[0]);
    const right = vscode.Uri.file(paths[1]);
    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(paths[0])} <-> ${path.basename(paths[1])}`,
    );
}

async function cmdRevealOnnx(node: LogsNode | undefined) {
    if (!node) return;
    if (node.kind === 'runFile' || node.kind === 'runDirectory') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.fullPath));
    } else if (node.kind === 'runFolder') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.folderPath));
    }
}

// ──────────────────── Registration ─────────────────────────────

export function registerLogsExplorerView(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new LogsExplorerProvider();

    const treeView = vscode.window.createTreeView(`${EXTENSION_ID}_logs`, {
        treeDataProvider: provider,
        canSelectMany: true,
        showCollapseAll: true,
    });

    // 工作区文件夹变化时自动重新发现 logs 目录
    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        provider.refresh();
    });

    const disposables: vscode.Disposable[] = [
        treeView,
        folderWatcher,
        new vscode.Disposable(() => provider.dispose()),

        vscode.commands.registerCommand(`${EXTENSION_ID}.refreshLogs`, () =>
            provider.refresh(),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.copyOnnxFiles`,
            (clickedNode?: LogsNode, selectedNodes?: LogsNode[]) =>
                cmdCopyOnnxFiles(treeView, clickedNode, selectedNodes),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.copyOnnxFilePath`,
            (clickedNode?: LogsNode, selectedNodes?: LogsNode[]) =>
                cmdCopyOnnxFilePath(treeView, clickedNode, selectedNodes),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.copyRelativeLogPath`,
            (clickedNode?: LogsNode, selectedNodes?: LogsNode[]) =>
                cmdCopyRelativeLogPath(treeView, clickedNode, selectedNodes),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.copyLogFileName`,
            (clickedNode?: LogsNode, selectedNodes?: LogsNode[]) =>
                cmdCopyLogFileName(treeView, clickedNode, selectedNodes),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.compareSelectedLogFiles`,
            (clickedNode?: LogsNode, selectedNodes?: LogsNode[]) =>
                cmdCompareSelectedLogFiles(treeView, clickedNode, selectedNodes),
        ),

        vscode.commands.registerCommand(
            `${EXTENSION_ID}.revealOnnxInExplorer`,
            (node?: LogsNode) => cmdRevealOnnx(node),
        ),
    ];

    return disposables;
}
