import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { ReplicaLinks } from '../core/replicaLinks';
import { EventBus } from '../utils/eventBus';
import { log } from '../utils/log';
import type { CommentThread, DocRanges } from '../api/socketio';
import { since, snippet } from './reviewManager';

type Change = NonNullable<DocRanges['changes']>[number];
type Comment = NonNullable<DocRanges['comments']>[number];

class FileNode extends vscode.TreeItem {
    constructor(public readonly uri: vscode.Uri, path: string, public readonly children: vscode.TreeItem[],
                changes: number, comments: number) {
        super(path.replace(/^\//, ''), vscode.TreeItemCollapsibleState.Expanded);
        this.resourceUri = uri;
        this.description = [
            changes ? vscode.l10n.t('{n} changes', {n: changes}) : '',
            comments ? vscode.l10n.t('{n} comments', {n: comments}) : '',
        ].filter(Boolean).join(' · ');
        this.contextValue = changes ? 'reviewFileWithChanges' : 'reviewFile';
    }
}

class ChangeNode extends vscode.TreeItem {
    constructor(public readonly uri: vscode.Uri, public readonly change: Change, vfs: VirtualFileSystem, line?: number) {
        super(snippet(change.op.i ?? change.op.d ?? '', 50) || ' ', vscode.TreeItemCollapsibleState.None);
        const added = change.op.i !== undefined;
        this.iconPath = new vscode.ThemeIcon(added ? 'diff-added' : 'diff-removed',
            new vscode.ThemeColor(added ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.deletedResourceForeground'));
        this.description = [line !== undefined ? vscode.l10n.t('line {n}', {n: line}) : '',
                            vfs.userName(change.metadata?.user_id), since(change.metadata?.ts)].filter(Boolean).join(' · ');
        this.tooltip = `${added ? vscode.l10n.t('Added') : vscode.l10n.t('Deleted')}: ${change.op.i ?? change.op.d}`;
        this.contextValue = 'reviewChange';
        this.command = {command: `${ROOT_NAME}.review.reveal`, title: '', arguments: [uri, change.op.p]};
    }
}

class CommentNode extends vscode.TreeItem {
    constructor(public readonly uri: vscode.Uri, public readonly comment: Comment, thread: CommentThread,
                vfs: VirtualFileSystem, line?: number) {
        const first = thread.messages[0];
        super(snippet(first?.content ?? '', 50) || ' ', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(thread.resolved ? 'pass' : (thread.messages.length > 1 ? 'comment-discussion' : 'comment'));
        const replies = thread.messages.length - 1;
        this.description = [line !== undefined ? vscode.l10n.t('line {n}', {n: line}) : '',
                            vfs.userName(first?.user_id),
                            replies > 0 ? vscode.l10n.t('{n} replies', {n: replies}) : '',
                            thread.resolved ? vscode.l10n.t('resolved') : ''].filter(Boolean).join(' · ');
        this.tooltip = new vscode.MarkdownString(
            `> ${snippet(comment.op.c, 200)}\n\n` +
            thread.messages.map((m) => `**${vfs.userName(m.user_id)}**: ${m.content}`).join('\n\n'));
        this.contextValue = thread.resolved ? 'reviewCommentResolved' : 'reviewComment';
        this.command = {command: `${ROOT_NAME}.review.reveal`, title: '', arguments: [uri, comment.op.p]};
    }
}

/** "Overleaf Review": every file's tracked changes and comments, like the web editor's overview. */
export class ReviewTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private view?: vscode.TreeView<vscode.TreeItem>;
    /** ranges of the docs that are not open, from the last overview request */
    private projectRanges = new Map<string, DocRanges>();
    private fetched = false;
    private refreshTimer?: NodeJS.Timeout;
    private showResolved = false;

    constructor(private readonly vfsm: RemoteFileSystemProvider) {}

    private async vfs(): Promise<VirtualFileSystem | undefined> {
        // the Overleaf folder, or the project of the local replica the window works on
        const uri = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === ROOT_NAME)?.uri ?? ReplicaLinks.anyRemote;
        return uri ? this.vfsm.prefetch(uri) : undefined;
    }

    /** Re-read the overview from the server (the ranges of docs not open may be stale). */
    async reload() {
        const vfs = await this.vfs();
        if (!vfs) { return; }
        try {
            const ranges = await vfs.getProjectRanges();
            this.projectRanges = new Map(ranges.map(({docId, ranges}) => [docId, ranges]));
            this.fetched = true;
        } catch (err: any) {
            log('warn', `review: could not load the project's changes: ${err?.message ?? err}`);
        }
        this.emitter.fire(undefined);
    }

    private scheduleRefresh() {
        if (this.refreshTimer) { return; }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.emitter.fire(undefined);
        }, 500);
    }

    getTreeItem(element: vscode.TreeItem) { return element; }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof FileNode) { return element.children; }
        if (element) { return []; }
        const vfs = await this.vfs();
        if (!vfs) { return []; }
        if (!this.fetched) {
            await this.reload();
            if (!this.fetched) { return []; }
        }
        const threads = await vfs.getThreads().catch(() => ({} as {[id:string]: CommentThread}));
        const files: FileNode[] = [];
        let total = 0;
        for (const {doc, path} of vfs.allDocs()) {
            // an open doc's own ranges are up to date; the overview's may lag behind
            const local = vfs.peekReviewDoc(doc._id);
            const ranges: DocRanges = local
                ? {changes: local.ranges.changes as Change[], comments: local.ranges.comments as Comment[]}
                : (this.projectRanges.get(doc._id) ?? {});
            const lineOf = (offset: number) => local ? local.content.slice(0, offset).split('\n').length : undefined;
            const uri = vfs.pathToUri(...path.split('/').filter(Boolean));
            const changes = (ranges.changes ?? []).slice().sort((a, b) => a.op.p - b.op.p);
            const comments = (ranges.comments ?? [])
                .filter((c) => threads[c.op.t] && (this.showResolved || !threads[c.op.t].resolved))
                .sort((a, b) => a.op.p - b.op.p);
            if (changes.length === 0 && comments.length === 0) { continue; }
            const children: vscode.TreeItem[] = [
                ...changes.map((c) => new ChangeNode(uri, c, vfs, lineOf(c.op.p))),
                ...comments.map((c) => new CommentNode(uri, c, threads[c.op.t], vfs, lineOf(c.op.p))),
            ].sort((a, b) => ((a as any).change ?? (a as any).comment).op.p - ((b as any).change ?? (b as any).comment).op.p);
            const openComments = comments.filter((c) => !threads[c.op.t].resolved).length;
            total += changes.length + openComments;
            files.push(new FileNode(uri, path, children, changes.length, openComments));
        }
        if (this.view) {
            this.view.badge = total > 0 ? {value: total, tooltip: vscode.l10n.t('{n} open suggestions and comments', {n: total})} : undefined;
            this.view.message = files.length === 0 ? vscode.l10n.t('No tracked changes or comments.') : undefined;
        }
        return files;
    }

    private async reveal(uri: vscode.Uri, offset: number) {
        const document = await vscode.workspace.openTextDocument(ReplicaLinks.forEditor(uri));
        const editor = await vscode.window.showTextDocument(document);
        const position = document.positionAt(offset);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    get triggers(): vscode.Disposable[] {
        this.view = vscode.window.createTreeView(`${ROOT_NAME}.review`, {treeDataProvider: this, showCollapseAll: true});
        return [
            this.view, this.emitter,
            {dispose: () => this.refreshTimer && clearTimeout(this.refreshTimer)},
            EventBus.on('reviewChangedEvent', () => this.scheduleRefresh()),
            ReplicaLinks.onDidChange(() => this.scheduleRefresh()),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.refresh`, () => this.reload()),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.toggleResolved`, () => {
                this.showResolved = !this.showResolved;
                this.emitter.fire(undefined);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.reveal`, (uri: vscode.Uri, offset: number) => this.reveal(uri, offset)),
        ];
    }
}
