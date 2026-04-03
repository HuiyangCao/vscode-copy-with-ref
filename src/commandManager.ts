import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EXTENSION_ID } from './constants';

type CommandNode = CategoryNode | CommandItemNode;

interface CategoryNode {
    kind: 'category';
    name: string;
    filePath: string;
}

interface CommandItemNode {
    kind: 'command';
    name: string;
    command: string;
    parameters?: Record<string, any>;
    parameter_refs?: string[];
    categoryName: string;
    categoryData: any;
}

interface Parameter {
    type: string;
    prompt: string;
    options?: string[];
    [key: string]: any;
}

class CommandManagerProvider implements vscode.TreeDataProvider<CommandNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<CommandNode | undefined | null | void> =
        new vscode.EventEmitter<CommandNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<CommandNode | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private extensionPath: string, private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: CommandNode): vscode.TreeItem {
        if (element.kind === 'category') {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('file-json');
            item.command = {
                command: `${EXTENSION_ID}.openCommandConfig`,
                title: 'Edit Config',
                arguments: [element.filePath],
            };
            return item;
        } else {
            const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('run');
            item.command = {
                command: `${EXTENSION_ID}.runCommand`,
                title: 'Run Command',
                arguments: [element.categoryName, element],
            };
            return item;
        }
    }

    async getChildren(element?: CommandNode): Promise<CommandNode[]> {
        if (!element) {
            // Root: list all JSON categories
            return this.getCategories();
        } else if (element.kind === 'category') {
            // Category: list commands
            try {
                const data = JSON.parse(fs.readFileSync(element.filePath, 'utf-8'));
                const commands = data.commands || [];
                return commands.map((cmd: any) => ({
                    kind: 'command',
                    name: cmd.name,
                    command: cmd.command,
                    parameters: cmd.parameters,
                    parameter_refs: cmd.parameter_refs,
                    categoryName: element.name,
                    categoryData: data,
                } as CommandItemNode));
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to read ${element.filePath}: ${e}`);
                return [];
            }
        }
        return [];
    }

    private getCategories(): CategoryNode[] {
        const configDir = path.join(this.extensionPath, 'command_config');
        if (!fs.existsSync(configDir)) {
            return [];
        }

        const files = fs.readdirSync(configDir);
        return files
            .filter(f => f.endsWith('.json') && !f.startsWith('_'))
            .map(f => ({
                kind: 'category' as const,
                name: path.basename(f, '.json'),
                filePath: path.join(configDir, f),
            }));
    }
}

async function collectParameters(
    categoryData: any,
    cmdItem: CommandItemNode,
    context: vscode.ExtensionContext,
    categoryName: string
): Promise<Record<string, string> | undefined> {
    const result: Record<string, string> = {};

    // Determine which parameters to collect
    let paramDefs: Record<string, Parameter> = {};
    const paramNames: string[] = [];

    if (cmdItem.parameter_refs && cmdItem.parameter_refs.length > 0) {
        // Use global parameter_refs
        paramNames.push(...cmdItem.parameter_refs);
        paramDefs = categoryData.parameters || {};
    } else if (cmdItem.parameters && typeof cmdItem.parameters === 'object') {
        // Use inline parameters
        paramDefs = cmdItem.parameters;
        paramNames.push(...Object.keys(cmdItem.parameters));
    }

    // Collect each parameter
    for (const paramName of paramNames) {
        const paramDef = paramDefs[paramName];
        if (!paramDef) {
            vscode.window.showWarningMessage(`Parameter '${paramName}' not found in definitions`);
            continue;
        }

        const stateKey = `cmdmgr.${categoryName}.${paramName}`;
        const lastValue = context.workspaceState.get<string>(stateKey);

        let value: string | undefined;

        if (paramDef.type === 'select' && paramDef.options) {
            // Quick pick with last value first
            const options = paramDef.options;
            const items = options.map((opt: string) => ({
                label: opt,
                picked: opt === lastValue,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: paramDef.prompt,
                ignoreFocusOut: true,
            });

            if (!selected) {
                return undefined; // User cancelled
            }
            value = selected.label;
        } else if (paramDef.type === 'string') {
            const input = await vscode.window.showInputBox({
                prompt: paramDef.prompt,
                value: lastValue,
                ignoreFocusOut: true,
            });

            if (input === undefined) {
                return undefined; // User cancelled
            }
            value = input;
        } else {
            vscode.window.showWarningMessage(
                `Unknown parameter type '${paramDef.type}' for '${paramName}'`
            );
            continue;
        }

        // Save to workspace state
        await context.workspaceState.update(stateKey, value);
        result[paramName] = value;
    }

    return result;
}

function replaceParameters(command: string, params: Record<string, string>): string {
    let result = command;
    for (const [key, value] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
}

function getOrCreateTerminal(name: string = 'Command Manager'): vscode.Terminal {
    const existing = vscode.window.terminals.find(t => t.name === name);
    if (existing) {
        return existing;
    }
    return vscode.window.createTerminal(name);
}

export function registerCommandManagerView(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // Create tree provider
    const provider = new CommandManagerProvider(context.extensionPath, context);
    const treeView = vscode.window.createTreeView(`${EXTENSION_ID}_commands`, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    disposables.push(treeView);

    // Register runCommand
    const runCommandDisposable = vscode.commands.registerCommand(
        `${EXTENSION_ID}.runCommand`,
        async (categoryName: string, cmdItem: CommandItemNode) => {
            try {
                // Collect parameters
                const params = await collectParameters(
                    cmdItem.categoryData,
                    cmdItem,
                    context,
                    categoryName
                );

                if (params === undefined) {
                    // User cancelled
                    return;
                }

                // Replace parameters in command
                const finalCmd = replaceParameters(cmdItem.command, params);

                // Get or create terminal and execute
                const terminal = getOrCreateTerminal('Command Manager');
                terminal.show(true);
                terminal.sendText(finalCmd);
            } catch (e) {
                vscode.window.showErrorMessage(`Error running command: ${e}`);
            }
        }
    );
    disposables.push(runCommandDisposable);

    // Register openCommandConfig
    const openConfigDisposable = vscode.commands.registerCommand(
        `${EXTENSION_ID}.openCommandConfig`,
        async (filePath: string) => {
            try {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to open ${filePath}: ${e}`);
            }
        }
    );
    disposables.push(openConfigDisposable);

    // Register refreshCommands
    const refreshDisposable = vscode.commands.registerCommand(`${EXTENSION_ID}.refreshCommands`, () => {
        provider.refresh();
    });
    disposables.push(refreshDisposable);

    return disposables;
}
