import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, applyBaseSettings, applySettings, applyUserKeybindings, resetSettings } from './config';
import {
    registerCopyWithRefCommand,
    registerCopyFilesToSystemCommand,
    registerAddFavoriteFolderCommand,
    registerRevealFolderCommand,
    registerCopyFileNameCommand,
    registerStageSelectedLinesCommand,
    registerDeleteModelFilesCommand,
    registerKillPythonDebugCommand,
} from './actions';
import { registerDebugConfigurationProviderAndCommand } from './debug';
import { registerCommandManagerView } from './commandManager';
import { registerSshServerView } from './sshManager';
import { registerWebExplorerView } from './webExplorer';
import { registerLogsExplorerView } from './logsExplorer';

export function activate(context: vscode.ExtensionContext) {
    const jetbrainsFlagFile = path.join(os.homedir(), '.config', 'trainning_extension', 'jetbrains_mode_enabled');
    const shouldApplyJetbrainsPreset = (() => {
        try {
            const raw = fs.readFileSync(jetbrainsFlagFile, 'utf8').trim();
            return raw !== '0';
        } catch {
            // Default to enabled for backward compatibility when flag file is absent.
            return true;
        }
    })();

    const cfg = loadConfig(context.extensionPath);
    // Base settings always apply (default after install), independent of the JetBrains toggle.
    applyBaseSettings(cfg.baseSettings);
    if (shouldApplyJetbrainsPreset) {
        applySettings(context, cfg.settings);
    } else {
        resetSettings(cfg.settings);
    }
    applyUserKeybindings(context, cfg.keybindings);

    const cmd = registerCopyWithRefCommand(context);
    const copyFilesCmd = registerCopyFilesToSystemCommand();
    const addFavoriteFolderCmd = registerAddFavoriteFolderCommand(context);
    const revealFolderCmd = registerRevealFolderCommand(context);
    const copyFileNameCmd = registerCopyFileNameCommand();
    const stageSelectedLinesCmd = registerStageSelectedLinesCommand();
    const deleteModelFilesCmd = registerDeleteModelFilesCommand(context);
    const killPythonDebugCmd = registerKillPythonDebugCommand();
    const debugProvider = registerDebugConfigurationProviderAndCommand(context);
    const cmdMgrDisposables = registerCommandManagerView(context);
    const sshDisposables = registerSshServerView(context);
    const webDisposables = registerWebExplorerView(context);
    const logsDisposables = registerLogsExplorerView(context);

    context.subscriptions.push(cmd, copyFilesCmd, addFavoriteFolderCmd, revealFolderCmd, copyFileNameCmd, stageSelectedLinesCmd, deleteModelFilesCmd, killPythonDebugCmd, debugProvider, ...cmdMgrDisposables, ...sshDisposables, ...webDisposables, ...logsDisposables);
}

export function deactivate() {}
