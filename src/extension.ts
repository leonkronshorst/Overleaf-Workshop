import * as vscode from 'vscode';
import { ROOT_NAME, ELEGANT_NAME } from './consts';

import { RemoteFileSystemProvider, VirtualFileSystem } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';
import { ReviewManager } from './review/reviewManager';
import { EditRecorder } from './core/editRecorder';
import { ReviewTreeProvider } from './review/reviewTree';

export function activate(context: vscode.ExtensionContext) {
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );
    // the edits made in Overleaf docs, sent on save as typed (see EditRecorder)
    context.subscriptions.push( ...EditRecorder.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    // Register: [review] tracked changes and comments in the editor, and the review overview
    const reviewManager = new ReviewManager(remoteFileSystemProvider);
    context.subscriptions.push( ...reviewManager.triggers );
    const reviewTreeProvider = new ReviewTreeProvider(remoteFileSystemProvider);
    context.subscriptions.push( ...reviewTreeProvider.triggers );

    // activate vfs for local replica
    LocalReplicaSCMProvider.readSettings()
    .then(async setting => {
        if (setting?.uri) {
            const uri = vscode.Uri.parse(setting.uri);
            if (uri.scheme===ROOT_NAME) {
                // activate vfs
                const vfs = (await (await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri))) as VirtualFileSystem;
                // saves before the project is joined (e.g. started offline) wait in the journal
                const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
                if (folder) {
                    context.subscriptions.push(LocalReplicaSCMProvider.journalWhileNotConnected(context, vfs, folder));
                }
                await vfs.init();
                vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
                // activate compile & preview
                if (setting?.enableCompileNPreview) {
                    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, true);
                }
            }
        }
    });
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
}