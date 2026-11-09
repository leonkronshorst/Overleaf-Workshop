/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names (user_id, resolved_at, ...) */
import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider, VirtualFileSystem, editOps, rejectOps } from '../core/remoteFileSystemProvider';
import { ReplicaLinks } from '../core/replicaLinks';
import { EventBus } from '../utils/eventBus';
import { log } from '../utils/log';
import { RangesTracker as RangesTrackerClass } from './rangesTracker';
import type { RangesTracker, TrackedChange, TrackedComment } from './rangesTracker';
import type { CommentThread, ThreadMessage } from '../api/socketio';
import { ReviewCache } from './reviewCache';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { JournalEntry, ReplicaJournal, TextOp, ThreadAction, applyOps, diffOps, toLf } from '../scm/replicaJournal';

/**
 * The offset of `position` as Overleaf counts it: in the text with LF line breaks. An
 * editor with CRLF line breaks counts one more character per line before it.
 */
function lfOffsetAt(document: vscode.TextDocument, position: vscode.Position): number {
    const offset = document.offsetAt(position);
    return document.eol === vscode.EndOfLine.CRLF ? offset - document.validatePosition(position).line : offset;
}

/** The position of the offset `offset` in the LF text (see lfOffsetAt). */
function lfPositionAt(document: vscode.TextDocument, offset: number): vscode.Position {
    if (document.eol !== vscode.EndOfLine.CRLF) { return document.positionAt(offset); }
    const lineStart = (line: number) => document.offsetAt(new vscode.Position(line, 0)) - line;
    let lo = 0, hi = document.lineCount - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStart(mid) <= offset) { lo = mid; } else { hi = mid - 1; }
    }
    return document.validatePosition(new vscode.Position(lo, offset - lineStart(lo)));
}

/** "3 min ago" */
export function since(ts?: Date | string | number): string {
    if (ts === undefined) { return ''; }
    const seconds = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) { return vscode.l10n.t('just now'); }
    if (seconds < 3600) { return vscode.l10n.t('{n} min ago', {n: Math.floor(seconds / 60)}); }
    if (seconds < 86400) { return vscode.l10n.t('{n} h ago', {n: Math.floor(seconds / 3600)}); }
    return new Date(ts).toLocaleDateString();
}

/** Shorten text for one line of a hover or a tree item. */
export function snippet(text: string, max = 60): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

interface ReviewDoc {
    vfs: VirtualFileSystem,
    /** the Overleaf file: the editor's own uri, or the original of a local replica copy */
    uri: vscode.Uri,
    docId: string,
    /** the text the ranges are positioned in */
    content: string,
    ranges: RangesTracker,
    /** ids of changes that only exist in the editor's unsaved edits (see displayReviewDoc) */
    unsaved: Set<string>,
    /** shown while offline: as last seen online, with the saves kept for upload on top */
    offline?: boolean,
    /** ids of changes made by saves kept for upload (offline) */
    pending?: Set<string>,
    /** offline in a local replica: decisions and comments are kept and sent later */
    keeps?: boolean,
    /** comment threads made offline, not sent yet */
    localThreads?: {[threadId: string]: CommentThread},
}

/** A message made offline, not sent yet: its id is local until then. */
const isLocal = (messageId?: string) => messageId?.startsWith('local-') === true;
const localId = () => `local-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A comment thread shown in an editor, and what it was made from. */
interface ShownThread {
    thread: vscode.CommentThread,
    threadId: string,
    docUri: string,
}

class ReviewComment implements vscode.Comment {
    savedBody: string | vscode.MarkdownString;
    constructor(
        public body: string | vscode.MarkdownString,
        public mode: vscode.CommentMode,
        public author: vscode.CommentAuthorInformation,
        public readonly threadId: string,
        public readonly messageId: string,
        public contextValue?: string,
        public timestamp?: Date,
        public label?: string,
    ) {
        this.savedBody = body;
    }
}

/** An Overleaf doc, or a local replica copy of one. */
function reviewable(uri: vscode.Uri | undefined): uri is vscode.Uri {
    return uri !== undefined && ReplicaLinks.toRemote(uri) !== undefined;
}

/**
 * Tracked changes and comments in the editors of Overleaf docs and of their local replica
 * copies: decorations, hovers with Accept/Reject, code actions, comment threads (VS Code's
 * Comments UI), navigation.
 */
export class ReviewManager {
    private readonly insertDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('overleafWorkshop.review.insertedTextBackground'),
        overviewRulerColor: new vscode.ThemeColor('overleafWorkshop.review.insertedTextBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    private readonly deleteDecoration = vscode.window.createTextEditorDecorationType({
        overviewRulerColor: new vscode.ThemeColor('overleafWorkshop.review.deletedTextForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    private readonly commentDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('overleafWorkshop.review.commentedTextBackground'),
        overviewRulerColor: new vscode.ThemeColor('overleafWorkshop.review.commentedTextBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    private readonly commentController = vscode.comments.createCommentController(`${ROOT_NAME}.review`, vscode.l10n.t('Overleaf comments'));
    /** shown comment threads by thread id */
    private readonly shownThreads = new Map<string, ShownThread>();
    private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
    /** what was last logged per document, to log only changes */
    private readonly lastSummary = new Map<string, string>();
    /** the review state last drawn per document, and the document version it fits */
    private readonly shown = new Map<string, {version: number, review: ReviewDoc}>();
    private changeAtCursor = false;
    private inReviewEditor = false;

    /**
     * Set the `overleaf-workshop.review.changeAtCursor` context key, which shows Accept/Reject
     * in the editor's context menu only on or next to a tracked change.
     */
    private updateCursorContext() {
        const editor = vscode.window.activeTextEditor;
        let atChange = false;
        const inReview = reviewable(editor?.document.uri);
        if (inReview !== this.inReviewEditor) {
            this.inReviewEditor = inReview;
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.review.inEditor`, inReview);
        }
        if (editor && inReview) {
            const shown = this.shown.get(editor.document.uri.toString());
            if (shown && shown.version === editor.document.version) {
                const {start, end} = editor.selection;
                atChange = this.changesAt(shown.review, lfOffsetAt(editor.document, start), lfOffsetAt(editor.document, end)).length > 0;
            }
        }
        if (atChange !== this.changeAtCursor) {
            this.changeAtCursor = atChange;
            vscode.commands.executeCommand('setContext', `${ROOT_NAME}.review.changeAtCursor`, atChange);
        }
    }

    constructor(private readonly vfsm: RemoteFileSystemProvider) {
        this.commentController.options = {
            prompt: vscode.l10n.t('Add a comment…'),
            placeHolder: vscode.l10n.t('Comment (visible to all project members)'),
        };
        this.commentController.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (!reviewable(document.uri)) { return []; }
                return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
            },
        };
    }

    // ---- reading the review state of an editor ---------------------------------------------

    private async reviewDoc(editorUri: vscode.Uri): Promise<(ReviewDoc & {base: string}) | undefined> {
        const uri = ReplicaLinks.toRemote(editorUri);
        if (!uri) { return undefined; }
        const vfs = await this.vfsm.prefetch(uri);
        if (vfs.isJoined) {
            try {
                const review = await vfs.getReviewDoc(uri);
                if (!review) { return undefined; }
                // kept for when the connection is gone
                ReviewCache.remember(uri, review.doc._id, review.content, review.ranges);
                return {vfs, uri, docId: review.doc._id, content: review.content, base: review.base, ranges: review.ranges, unsaved: new Set()};
            } catch (err) {
                if (vfs.isJoined) { throw err; }   // else: just lost the connection, shown offline
            }
        }
        return this.offlineReviewDoc(vfs, uri, editorUri);
    }

    /**
     * While offline: the changes and comments as last seen online, with the saves kept for
     * upload on top, each in the mode it was made in: what Overleaf will show once they are
     * uploaded (unless a collaborator's change gets in the way). Before, the view froze:
     * new suggestions did not show, and the old ones stayed where they were while typing.
     */
    private async offlineReviewDoc(vfs: VirtualFileSystem, uri: vscode.Uri, editorUri: vscode.Uri): Promise<(ReviewDoc & {base: string}) | undefined> {
        const cached = await ReviewCache.recall(uri);
        if (!cached) { return undefined; }
        const journal = editorUri.scheme === 'file' ? await LocalReplicaSCMProvider.pendingSaves(editorUri) : undefined;
        if (journal?.paused) { return undefined; }   // the file shows conflict markers
        const ranges = new RangesTrackerClass(structuredClone(cached.changes), structuredClone(cached.comments));
        const seen = new Set(ranges.changes.map((c) => c.id));
        let content = cached.content;
        const localThreads: {[threadId: string]: CommentThread} = {};
        const apply = (ops: TextOp[], tracked: boolean, seed?: string, at = Date.now()) => {
            ranges.track_changes = tracked;
            ranges.setIdSeed(seed ?? RangesTrackerClass.generateIdSeed());
            const metadata = {user_id: vfs.currentUserId, ts: new Date(at)};
            for (const op of ops) { ranges.applyOp(op, metadata); }
            content = applyOps(content, ops);
        };
        const decide = (entry: JournalEntry) => {
            if (entry.kind === 'accept') {
                ranges.removeChangeIds(entry.ids ?? []);
            } else if (entry.kind === 'comment' && entry.comment) {
                const {threadId, p, c, content: message} = entry.comment;
                ranges.applyOp({p, c, t: threadId} as any, {user_id: vfs.currentUserId, ts: new Date(entry.at)});
                localThreads[threadId] = {messages: [{id: `local-${threadId}`, content: message, timestamp: entry.at,
                                                      user_id: vfs.currentUserId} as ThreadMessage]};
            } else if (entry.kind === 'reject') {
                apply(entry.ops, false, undefined, entry.at);
            } else {
                apply(entry.ops, entry.tracked ?? vfs.knownTracking ?? false, entry.seed, entry.at);
            }
        };
        try {
            if (journal && journal.start === content) {
                journal.entries.forEach(decide);
            } else if (journal) {
                // kept from another starting point than last seen: as one edit, in the mode of now
                apply(diffOps(content, ReplicaJournal.end(journal)), vfs.knownTracking ?? false);
            }
        } catch {
            return undefined;
        }
        const pending = new Set(ranges.changes.filter((c) => !seen.has(c.id)).map((c) => c.id));
        const keeps = editorUri.scheme === 'file' && LocalReplicaSCMProvider.threadQueueOf(editorUri) !== undefined;
        return {vfs, uri, docId: cached.docId, content, base: content, ranges, unsaved: new Set(), offline: true, pending, keeps, localThreads};
    }

    /**
     * The review state of `document` as the editor shows it, with positions in its text:
     * the server's, or with the unsaved edits applied as a save would apply them. In
     * Reviewing mode they are tracked like on the server, so they show up as suggestions
     * while typing; otherwise they just move the existing changes and comments along.
     * Undefined while the editor shows an older version than the server's (a reload is
     * on the way), as the edits would then be measured against the wrong text.
     */
    private async currentReviewDoc(document: vscode.TextDocument): Promise<ReviewDoc | undefined> {
        const review = await this.reviewDoc(document.uri);
        if (!review) { return undefined; }
        const text = toLf(document.getText());
        if (text === review.content) { return review; }
        // (`base` is what the Overleaf editor was loaded from; a local copy has its own)
        if (!document.isDirty || (document.uri.scheme === ROOT_NAME && review.base !== review.content)) { return undefined; }
        const preview = new RangesTrackerClass(structuredClone(review.ranges.changes), structuredClone(review.ranges.comments));
        // the mode the next save goes in, also one switched to while offline
        preview.track_changes = review.vfs.knownTracking ?? review.vfs.isTrackingChanges;
        preview.setIdSeed(RangesTrackerClass.generateIdSeed());
        const metadata = {user_id: review.vfs.currentUserId, ts: new Date()};
        try {
            for (const op of editOps(review.uri, review.content, text)) { preview.applyOp(op, metadata); }
        } catch {
            return undefined;
        }
        const saved = new Set(review.ranges.changes.map((c) => c.id));
        const unsaved = new Set(preview.changes.filter((c) => !saved.has(c.id)).map((c) => c.id));
        return {...review, content: text, ranges: preview, unsaved};
    }

    /** Like currentReviewDoc, but offers to save unsaved changes first, for an action. */
    private async reviewDocForAction(document: vscode.TextDocument): Promise<ReviewDoc | undefined> {
        if (document.isDirty) {
            const save = vscode.l10n.t('Save');
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t('{name} has unsaved changes. Save them first?', {name: document.uri.path.split('/').pop() ?? ''}),
                {modal: true}, save);
            if (choice !== save || !(await document.save())) { return undefined; }
        }
        let review = await this.reviewDoc(document.uri);
        // a local copy reaches Overleaf only after it is saved: give it a moment
        for (let wait = 0; review && toLf(document.getText()) !== review.content && wait < 25; wait++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            review = await this.reviewDoc(document.uri);
        }
        if (!review) { return undefined; }
        if (toLf(document.getText()) !== review.content) {
            vscode.window.showWarningMessage(vscode.l10n.t('The document is being updated from Overleaf. Please try again in a moment.'));
            return undefined;
        }
        return review;
    }

    private range(document: vscode.TextDocument, offset: number, length: number) {
        return new vscode.Range(lfPositionAt(document, offset), lfPositionAt(document, offset + length));
    }

    // ---- decorations and comment threads ---------------------------------------------------

    /** Redraw the editors of `docUri`, or of all Overleaf docs, soon (events come in bursts). */
    scheduleRefresh(docUri?: string) {
        const key = docUri ?? '*';
        if (this.refreshTimers.has(key)) { return; }
        this.refreshTimers.set(key, setTimeout(() => {
            this.refreshTimers.delete(key);
            const editors = vscode.window.visibleTextEditors.filter((e) =>
                reviewable(e.document.uri) && (docUri === undefined || e.document.uri.toString() === docUri));
            const documents = vscode.workspace.textDocuments.filter((d) =>
                reviewable(d.uri) && (docUri === undefined || d.uri.toString() === docUri));
            documents.forEach((document) => {
                this.refreshDocument(document, editors.filter((e) => e.document === document)).catch((err) => {
                    log('warn', `review: could not show the changes of ${document.uri.path}: ${err?.message ?? err}`);
                });
            });
        }, 150));
    }

    private async refreshDocument(document: vscode.TextDocument, editors: readonly vscode.TextEditor[]) {
        const version = document.version;
        const review = await this.currentReviewDoc(document);
        // An older version than the server's (a reload is on the way), or typed on
        // meanwhile (another refresh is on the way): leave things as they are.
        if (!review || document.version !== version) { return; }
        this.shown.set(document.uri.toString(), {version, review});
        this.updateCursorContext();
        const inserts: vscode.DecorationOptions[] = [];
        const deletes: vscode.DecorationOptions[] = [];
        for (const change of review.ranges.changes) {
            if (change.op.i !== undefined) {
                inserts.push({range: this.range(document, change.op.p, change.op.i.length)});
            } else if (change.op.d !== undefined) {
                const at = lfPositionAt(document, change.op.p);
                deletes.push({
                    range: new vscode.Range(at, at),
                    renderOptions: {before: {
                        contentText: snippet(change.op.d, 40),
                        color: new vscode.ThemeColor('overleafWorkshop.review.deletedTextForeground'),
                        textDecoration: 'line-through',
                    }},
                });
            }
        }
        const threads = review.offline
            ? await this.offlineThreads(review, document.uri)
            : review.vfs.loadedThreads ?? await review.vfs.getThreads().catch(() => undefined);
        if (!review.offline && threads) { ReviewCache.rememberThreads(review.uri, threads); }
        const summary = [
            ...review.ranges.changes.map((c) => `${c.id} ${c.op.i !== undefined ? '+' : '-'}"${snippet(c.op.i ?? c.op.d ?? '', 30)}"@${c.op.p}`),
            ...review.ranges.comments.map((c) => `comment ${c.op.t}${threads?.[c.op.t]?.resolved ? ' (resolved)' : ''} on "${snippet(c.op.c, 30)}"@${c.op.p}`),
        ].join(', ');
        // Overleaf's state only: the offline picture gets fresh ids for its kept saves each time
        if (!review.offline && review.unsaved.size === 0 && !document.isDirty && this.lastSummary.get(document.uri.toString()) !== summary) {
            this.lastSummary.set(document.uri.toString(), summary);
            log('info', `review: ${document.uri.path}: ${summary || 'no tracked changes or comments'}`);
        }
        const comments: vscode.DecorationOptions[] = review.ranges.comments
            .filter((comment) => comment.op.c.length > 0 && !threads?.[comment.op.t]?.resolved)
            .map((comment) => ({range: this.range(document, comment.op.p, comment.op.c.length)}));
        editors.forEach((editor) => {
            editor.setDecorations(this.insertDecoration, inserts);
            editor.setDecorations(this.deleteDecoration, deletes);
            editor.setDecorations(this.commentDecoration, comments);
        });
        this.showThreads(document, review, threads ?? {});
    }

    /**
     * The comment threads while offline: as last seen online, with the threads and thread
     * actions made offline on top (replies, edits, resolving), as Overleaf will have them.
     */
    private async offlineThreads(review: ReviewDoc, editorUri: vscode.Uri): Promise<{[id: string]: CommentThread}> {
        const seen = review.vfs.loadedThreads ?? await ReviewCache.recallThreads(review.uri) ?? {};
        const threads: {[id: string]: CommentThread} = {...structuredClone(seen), ...structuredClone(review.localThreads ?? {})};
        const me = review.vfs.currentUserId;
        const queue = editorUri.scheme === 'file' ? LocalReplicaSCMProvider.threadQueueOf(editorUri) : undefined;
        for (const action of await queue?.list() ?? []) {
            const thread = threads[action.threadId];
            if (!thread) { continue; }
            switch (action.kind) {
                case 'reply':
                    thread.messages.push({id: action.messageId!, content: action.content ?? '', timestamp: action.at, user_id: me} as ThreadMessage);
                    break;
                case 'edit':
                    thread.messages = thread.messages.map((m) => m.id === action.messageId ? {...m, content: action.content ?? '', edited_at: action.at} as ThreadMessage : m);
                    break;
                case 'deleteMessage':
                    thread.messages = thread.messages.filter((m) => m.id !== action.messageId);
                    break;
                case 'resolve':
                    Object.assign(thread, {resolved: true, resolved_at: new Date(action.at).toISOString(), resolved_by_user_id: me});
                    break;
                case 'reopen':
                    Object.assign(thread, {resolved: undefined, resolved_at: undefined, resolved_by_user_id: undefined, resolved_by_user: undefined});
                    break;
                case 'deleteThread':
                    delete threads[action.threadId];
                    break;
            }
        }
        return threads;
    }

    private showThreads(document: vscode.TextDocument, review: ReviewDoc, threads: {[id:string]: CommentThread}) {
        const docUri = document.uri.toString();
        const present = new Set<string>();
        // Threads anchored at the same spot (typically on text deleted since) share one
        // panel in VS Code, each open one with its own reply box: say so in their header.
        const open = (c: TrackedComment) => threads[c.op.t] && !threads[c.op.t].resolved;
        const atSpot = new Map<string, number>();
        const spot = (c: TrackedComment) => `${c.op.p}:${c.op.c.length}`;
        review.ranges.comments.filter(open).forEach((c) => atSpot.set(spot(c), (atSpot.get(spot(c)) ?? 0) + 1));
        for (const comment of review.ranges.comments) {
            const threadId = comment.op.t;
            const data = threads[threadId];
            if (!data) { continue; } // e.g. its first message is still on the way
            present.add(threadId);
            const range = this.range(document, comment.op.p, comment.op.c.length);
            let shown = this.shownThreads.get(threadId);
            if (!shown || shown.docUri !== docUri) {
                shown?.thread.dispose();
                const thread = this.commentController.createCommentThread(document.uri, range, []);
                thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
                shown = {thread, threadId, docUri};
                this.shownThreads.set(threadId, shown);
            }
            this.updateThread(shown.thread, threadId, data, review.vfs, range, comment, atSpot.get(spot(comment)) ?? 1);
        }
        // threads gone from this doc (deleted, or their text deleted)
        for (const [threadId, shown] of this.shownThreads) {
            if (shown.docUri === docUri && !present.has(threadId)) {
                shown.thread.dispose();
                this.shownThreads.delete(threadId);
            }
        }
    }

    private updateThread(thread: vscode.CommentThread, threadId: string, data: CommentThread,
                         vfs: VirtualFileSystem, range: vscode.Range, comment: TrackedComment, sharing = 1) {
        thread.range = range;
        thread.label = data.resolved
            ? vscode.l10n.t('Resolved by {name}', {name: data.resolved_by_user_id ? vfs.userName(data.resolved_by_user_id) : ''})
            : comment.op.c.length === 0
                ? (sharing > 1
                    ? vscode.l10n.t('The commented text was deleted · one of {n} open threads at this spot', {n: sharing})
                    : vscode.l10n.t('The commented text was deleted'))
                : (sharing > 1 ? vscode.l10n.t('One of {n} open threads on this text', {n: sharing}) : undefined);
        thread.state = data.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        thread.contextValue = data.resolved ? 'resolved' : 'open';
        thread.canReply = !data.resolved && vfs.permissionsLevel !== 'readOnly';
        // keep a comment that is being edited as it is
        const editing = new Map(thread.comments
            .filter((c) => c.mode === vscode.CommentMode.Editing)
            .map((c) => [(c as ReviewComment).messageId, c as ReviewComment]));
        thread.comments = data.messages.map((message) => editing.get(message.id) ?? this.toComment(message, threadId, vfs));
    }

    private toComment(message: ThreadMessage, threadId: string, vfs: VirtualFileSystem) {
        const own = message.user_id === vfs.currentUserId;
        return new ReviewComment(
            new vscode.MarkdownString(message.content),
            vscode.CommentMode.Preview,
            {name: own ? vfs.userName(message.user_id) : (message.user ? [message.user.first_name, message.user.last_name].filter(Boolean).join(' ') : vfs.userName(message.user_id))},
            threadId, message.id,
            own ? 'own' : 'other',
            new Date(message.timestamp),
            isLocal(message.id) ? vscode.l10n.t('(not sent yet)') : message.edited_at ? vscode.l10n.t('(edited)') : undefined,
        );
    }

    // ---- hovers and code actions -------------------------------------------------------------

    private changesAt(review: ReviewDoc, start: number, end: number): TrackedChange[] {
        return review.ranges.changes.filter((change) => {
            if (change.op.i !== undefined) {
                return change.op.p <= end && start <= change.op.p + change.op.i.length;
            }
            // a deletion sits between two characters
            return start - 1 <= change.op.p && change.op.p <= end + 1;
        });
    }

    private changeLine(change: TrackedChange, vfs: VirtualFileSystem): string {
        const kind = change.op.i !== undefined ? vscode.l10n.t('Added') : vscode.l10n.t('Deleted');
        const who = vfs.userName(change.metadata?.user_id);
        return `**${kind}** ${vscode.l10n.t('by {name}', {name: who})} · ${since(change.metadata?.ts)}`;
    }

    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const review = await this.currentReviewDoc(document);
        if (!review) { return; }
        const offset = lfOffsetAt(document, position);
        const changes = this.changesAt(review, offset, offset);
        if (changes.length === 0) { return; }
        const canDecide = this.canDecide(review);
        const md = new vscode.MarkdownString(undefined, true);
        md.isTrusted = {enabledCommands: [`${ROOT_NAME}.review.acceptChange`, `${ROOT_NAME}.review.rejectChange`]};
        if (review.offline) {
            md.appendMarkdown(`$(cloud-offline) *${review.keeps
                ? vscode.l10n.t('Offline: as it will be on Overleaf once uploaded. Accept and Reject are kept and sent when the connection is back.')
                : vscode.l10n.t('Offline: as it will be on Overleaf once uploaded. Accept and Reject need the connection.')}*\n\n`);
        }
        for (const change of changes) {
            const unsaved = review.unsaved.has(change.id);
            const kind = change.op.i !== undefined ? vscode.l10n.t('Added') : vscode.l10n.t('Deleted');
            md.appendMarkdown(unsaved
                ? `**${kind}** · ${vscode.l10n.t('not saved yet: becomes a suggestion when you save')}\n\n`
                : review.pending?.has(change.id)
                    ? `**${kind}** · ${vscode.l10n.t('saved while offline: becomes a suggestion once uploaded')}\n\n`
                    : this.changeLine(change, review.vfs) + '\n\n');
            const text = change.op.i ?? change.op.d ?? '';
            md.appendCodeblock(snippet(text, 200), 'latex');
            if (canDecide && !unsaved) {
                const args = encodeURIComponent(JSON.stringify([document.uri.toString(), change.id]));
                md.appendMarkdown(`[$(check) ${vscode.l10n.t('Accept')}](command:${ROOT_NAME}.review.acceptChange?${args}) &nbsp; ` +
                                  `[$(close) ${vscode.l10n.t('Reject')}](command:${ROOT_NAME}.review.rejectChange?${args})\n\n`);
            }
        }
        return new vscode.Hover(md);
    }

    async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> {
        if (!reviewable(document.uri)) { return []; }
        const review = await this.currentReviewDoc(document);
        const actions: vscode.CodeAction[] = [];
        if (review && this.canDecide(review)) {
            const n = this.changesAt(review, lfOffsetAt(document, range.start), lfOffsetAt(document, range.end)).length;
            if (n > 0) {
                // no ids: the command saves unsaved edits first and then takes the changes
                // at the cursor, as unsaved changes get their ids only when saved
                const accept = new vscode.CodeAction(n === 1 ? vscode.l10n.t('Accept change') : vscode.l10n.t('Accept {n} changes', {n}), vscode.CodeActionKind.QuickFix);
                accept.command = {command: `${ROOT_NAME}.review.acceptChange`, title: accept.title};
                const reject = new vscode.CodeAction(n === 1 ? vscode.l10n.t('Reject change') : vscode.l10n.t('Reject {n} changes', {n}), vscode.CodeActionKind.QuickFix);
                reject.command = {command: `${ROOT_NAME}.review.rejectChange`, title: reject.title};
                actions.push(accept, reject);
            }
        }
        if (!range.isEmpty) {
            const comment = new vscode.CodeAction(vscode.l10n.t('Add comment'), vscode.CodeActionKind.Empty);
            comment.command = {command: `${ROOT_NAME}.review.addComment`, title: comment.title};
            actions.push(comment);
        }
        return actions;
    }

    private canAcceptOrReject(vfs: VirtualFileSystem) {
        const level = vfs.permissionsLevel;
        return level === 'owner' || level === 'readAndWrite';
    }

    /** Online with the rights, or offline in a local replica (the access may be unknown then). */
    private canDecide(review: ReviewDoc) {
        if (!review.offline) { return this.canAcceptOrReject(review.vfs); }
        const level = review.vfs.permissionsLevel;
        return review.keeps === true && (level === undefined || this.canAcceptOrReject(review.vfs));
    }

    /**
     * Accept or reject offline in a local replica: kept in the journal, in order with the
     * saves, and sent once the connection is back. A reject changes the text at once.
     */
    private async decideOffline(document: vscode.TextDocument, review: ReviewDoc, accept: boolean, changeIds: string[]) {
        const at = Date.now();
        let entry: JournalEntry;
        let after: string | undefined;
        if (accept) {
            entry = {kind: 'accept', at, ids: changeIds, ops: [], exact: true};
        } else {
            const {ops, content} = rejectOps(review.content, review.ranges.getChanges(changeIds));
            entry = {kind: 'reject', at, ids: changeIds, ops, exact: true, tracked: false};
            after = content;
        }
        if (!await LocalReplicaSCMProvider.keepDecision(document.uri, entry)) {
            throw new Error(vscode.l10n.t('This needs a connection to Overleaf.'));
        }
        if (after !== undefined) { await this.replaceText(document, review.content, after); }
        this.scheduleRefresh(document.uri.toString());
    }

    /** Make `document` (showing `before`, LF) show `after` with one edit, and save it. */
    private async replaceText(document: vscode.TextDocument, before: string, after: string) {
        let start = 0;
        while (start < before.length && start < after.length && before[start] === after[start]) { start++; }
        let end = 0;
        while (end < before.length - start && end < after.length - start
               && before[before.length - 1 - end] === after[after.length - 1 - end]) { end++; }
        const range = new vscode.Range(lfPositionAt(document, start), lfPositionAt(document, before.length - end));
        let text = after.slice(start, after.length - end);
        if (document.eol === vscode.EndOfLine.CRLF) { text = text.replace(/\n/g, '\r\n'); }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, range, text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
    }

    /** Keep a comment thread action made offline in a local replica; false if it needs the connection. */
    private async keepThreadAction(editorUri: vscode.Uri, action: ThreadAction): Promise<boolean> {
        const queue = editorUri.scheme === 'file' ? LocalReplicaSCMProvider.threadQueueOf(editorUri) : undefined;
        if (!queue) { return false; }
        await queue.add(action);
        this.scheduleRefresh();
        return true;
    }

    // ---- commands -----------------------------------------------------------------------------

    /**
     * The changes a command is about: `[uri, id | ids]` from a hover link or code action,
     * a tree item, or else the changes at the cursor / in the selection.
     */
    private async targetChanges(args: any[]): Promise<{document: vscode.TextDocument, ids: string[]} | undefined> {
        const [first, second] = args;
        if (typeof first === 'string') {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(first));
            return {document, ids: Array.isArray(second) ? second : [second]};
        }
        if (first?.change && first?.uri) { // tree item
            const document = await vscode.workspace.openTextDocument(ReplicaLinks.forEditor(first.uri));
            return {document, ids: [first.change.id]};
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || !reviewable(editor.document.uri)) { return undefined; }
        // saves unsaved edits first: changes typed meanwhile only get their ids then
        const review = await this.reviewDocForAction(editor.document);
        if (!review) { return undefined; }
        const ids = this.changesAt(review, lfOffsetAt(editor.document, editor.selection.start), lfOffsetAt(editor.document, editor.selection.end)).map((c) => c.id);
        return {document: editor.document, ids};
    }

    private async decide(accept: boolean, args: any[]) {
        const target = await this.targetChanges(args);
        if (!target) { return; }
        if (target.ids.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('There is no tracked change here.'));
            return;
        }
        await this.decideIn(target.document, accept, target.ids);
    }

    private async decideIn(document: vscode.TextDocument, accept: boolean, ids: string[] | 'all') {
        const review = await this.reviewDocForAction(document);
        if (!review) { return; }
        const changeIds = ids === 'all' ? review.ranges.changes.map((c) => c.id) : ids;
        if (changeIds.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('There are no tracked changes in this file.'));
            return;
        }
        try {
            if (review.offline && review.keeps) {
                await this.decideOffline(document, review, accept, changeIds);
            } else if (accept) {
                await review.vfs.acceptChanges(review.uri, changeIds);
            } else {
                await review.vfs.rejectChanges(review.uri, changeIds);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(accept
                ? vscode.l10n.t('Could not accept the changes: {error}', {error: err?.message ?? String(err)})
                : vscode.l10n.t('Could not reject the changes: {error}', {error: err?.message ?? String(err)}));
        }
    }

    private async decideAll(accept: boolean, arg?: any) {
        const target: vscode.Uri | undefined = arg instanceof vscode.Uri ? arg : (arg?.uri ?? vscode.window.activeTextEditor?.document.uri);
        if (!reviewable(target)) { return; }
        const uri = ReplicaLinks.forEditor(target); // a tree item names the Overleaf file
        const document = await vscode.workspace.openTextDocument(uri);
        const review = await this.reviewDoc(uri);
        const n = review?.ranges.changes.length ?? 0;
        if (n === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('There are no tracked changes in this file.'));
            return;
        }
        const yes = accept ? vscode.l10n.t('Accept all') : vscode.l10n.t('Reject all');
        const choice = await vscode.window.showWarningMessage(
            accept ? vscode.l10n.t('Accept all {n} tracked changes in {name}?', {n, name: uri.path.split('/').pop() ?? ''})
                   : vscode.l10n.t('Reject all {n} tracked changes in {name}?', {n, name: uri.path.split('/').pop() ?? ''}),
            {modal: true}, yes);
        if (choice === yes) {
            await this.decideIn(document, accept, 'all');
        }
    }

    private async toggleTrackChanges() {
        const active = vscode.window.activeTextEditor?.document.uri;
        const uri = (reviewable(active) ? ReplicaLinks.toRemote(active) : undefined)
            ?? vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === ROOT_NAME)?.uri
            ?? ReplicaLinks.anyRemote;
        if (!uri) { return; }
        const vfs = await this.vfsm.prefetch(uri);
        try {
            // offline too: the mode applies to the saves kept meanwhile at once
            await vfs.setTrackChangesForMe(!(vfs.knownTracking ?? vfs.isTrackingChanges));
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not switch track changes: {error}', {error: err?.message ?? String(err)}));
        }
    }

    /** Go to the next/previous tracked change or open comment in the active editor. */
    private async goToChange(forward: boolean) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !reviewable(editor.document.uri)) { return; }
        const review = await this.currentReviewDoc(editor.document);
        if (!review) { return; }
        const threads = review.vfs.loadedThreads ?? {};
        const offsets = [
            ...review.ranges.changes.map((c) => c.op.p),
            ...review.ranges.comments.filter((c) => !threads[c.op.t]?.resolved).map((c) => c.op.p),
        ].sort((a, b) => a - b);
        if (offsets.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('There are no tracked changes or comments in this file.'));
            return;
        }
        const here = lfOffsetAt(editor.document, editor.selection.active);
        const target = forward
            ? (offsets.find((o) => o > here) ?? offsets[0])
            : ([...offsets].reverse().find((o) => o < here) ?? offsets[offsets.length - 1]);
        const position = lfPositionAt(editor.document, target);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Open a new comment thread on the selection; its first message creates the comment. */
    private addComment() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !reviewable(editor.document.uri)) { return; }
        if (editor.selection.isEmpty) {
            vscode.window.showInformationMessage(vscode.l10n.t('Select the text to comment on first.'));
            return;
        }
        const thread = this.commentController.createCommentThread(editor.document.uri, editor.selection, []);
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    private threadIdOf(thread: vscode.CommentThread): string | undefined {
        for (const [threadId, shown] of this.shownThreads) {
            if (shown.thread === thread) { return threadId; }
        }
        return undefined;
    }

    /** Submit in a comment thread: the first message of a new thread, or a reply. */
    private async submitComment(reply: vscode.CommentReply) {
        const text = reply.text.trim();
        if (!text) { return; }
        const thread = reply.thread;
        const threadId = this.threadIdOf(thread);
        const remote = ReplicaLinks.toRemote(thread.uri);
        if (!remote) { return; }
        const vfs = await this.vfsm.prefetch(remote);
        try {
            if (threadId) {
                if (!vfs.isJoined && await this.keepThreadAction(thread.uri, {kind: 'reply', threadId, content: text, messageId: localId(), at: Date.now()})) {
                    return;
                }
                await vfs.replyToThread(threadId, text);
                return;
            }
            // a new thread: comment on its range
            const document = await vscode.workspace.openTextDocument(thread.uri);
            const review = await this.reviewDocForAction(document);
            if (!review || !thread.range) { return; }
            const start = lfOffsetAt(document, thread.range.start);
            const end = lfOffsetAt(document, thread.range.end);
            if (end <= start) {
                vscode.window.showInformationMessage(vscode.l10n.t('Select the text to comment on first.'));
                return;
            }
            if (review.offline) {
                // kept in the journal, in order with the saves; placed once the connection is back
                const kept = review.keeps && await LocalReplicaSCMProvider.keepDecision(document.uri, {
                    kind: 'comment', at: Date.now(), ops: [], exact: true,
                    comment: {threadId: RangesTrackerClass.generateId(), p: start, c: review.content.slice(start, end), content: text},
                });
                if (!kept) { throw new Error(vscode.l10n.t('This needs a connection to Overleaf.')); }
                thread.dispose();
                this.scheduleRefresh(thread.uri.toString());
                return;
            }
            await review.vfs.getThreads().catch(() => undefined);
            await review.vfs.addComment(review.uri, start, end - start, text);
            thread.dispose(); // the comment comes back as a thread of its own
            this.scheduleRefresh(thread.uri.toString());
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not add the comment: {error}', {error: err?.message ?? String(err)}));
        }
    }

    /** `target`: a comment thread in an editor, or a comment in the review tree */
    private async threadAction(target: vscode.CommentThread | {uri: vscode.Uri, comment: {op: {t: string}}},
                               action: 'resolve' | 'reopen' | 'delete') {
        const fromTree = 'comment' in target;
        const threadId = fromTree ? target.comment.op.t : this.threadIdOf(target);
        if (!threadId) { (target as vscode.CommentThread).dispose(); return; } // a new thread not yet submitted
        const remote = ReplicaLinks.toRemote(target.uri);
        if (!remote) { return; }
        const vfs = await this.vfsm.prefetch(remote);
        if (fromTree && vfs.isJoined) {
            await vfs.getReviewDoc(remote); // its ranges tell which doc the thread is in
        }
        try {
            if (action === 'delete') {
                const yes = vscode.l10n.t('Delete');
                const choice = await vscode.window.showWarningMessage(
                    vscode.l10n.t('Delete this comment thread for everyone?'), {modal: true}, yes);
                if (choice !== yes) { return; }
            }
            if (!vfs.isJoined) {
                const editorUri = ReplicaLinks.forEditor(remote);
                const docId = (await this.reviewDoc(editorUri))?.docId;
                const kind = action === 'delete' ? 'deleteThread' : action;
                if (await this.keepThreadAction(editorUri, {kind, threadId, docId, at: Date.now()})) { return; }
            }
            if (action === 'delete') {
                await vfs.deleteThread(threadId);
            } else {
                await vfs.setThreadResolved(threadId, action === 'resolve');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not update the comment: {error}', {error: err?.message ?? String(err)}));
        }
    }

    private async commentAction(comment: ReviewComment, action: 'edit' | 'save' | 'cancel' | 'delete') {
        const shown = this.shownThreads.get(comment.threadId);
        if (!shown) { return; }
        const thread = shown.thread;
        const remote = ReplicaLinks.toRemote(thread.uri);
        if (!remote) { return; }
        const vfs = await this.vfsm.prefetch(remote);
        const replace = (mode: vscode.CommentMode, body?: string | vscode.MarkdownString) => {
            thread.comments = thread.comments.map((c) => {
                const rc = c as ReviewComment;
                if (rc.messageId !== comment.messageId) { return c; }
                rc.mode = mode;
                if (body !== undefined) { rc.body = body; }
                return rc;
            });
        };
        try {
            switch (action) {
                case 'edit':
                    replace(vscode.CommentMode.Editing, typeof comment.body === 'string' ? comment.body : comment.body.value);
                    break;
                case 'cancel':
                    replace(vscode.CommentMode.Preview, comment.savedBody);
                    break;
                case 'save': {
                    const content = typeof comment.body === 'string' ? comment.body : comment.body.value;
                    if (vfs.isJoined || !await this.keepThreadAction(thread.uri,
                        {kind: 'edit', threadId: comment.threadId, messageId: comment.messageId, content, at: Date.now()})) {
                        await vfs.editThreadMessage(comment.threadId, comment.messageId, content);
                    }
                    comment.savedBody = new vscode.MarkdownString(content);
                    replace(vscode.CommentMode.Preview, comment.savedBody);
                    break;
                }
                case 'delete': {
                    const yes = vscode.l10n.t('Delete');
                    const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Delete your message?'), {modal: true}, yes);
                    if (choice === yes && (vfs.isJoined || !await this.keepThreadAction(thread.uri,
                        {kind: 'deleteMessage', threadId: comment.threadId, messageId: comment.messageId, at: Date.now()}))) {
                        await vfs.deleteOwnThreadMessage(comment.threadId, comment.messageId);
                    }
                    break;
                }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not update the comment: {error}', {error: err?.message ?? String(err)}));
        }
    }

    get triggers(): vscode.Disposable[] {
        // local replica copies are files; the providers skip files that are not
        const selector: vscode.DocumentSelector = [{scheme: ROOT_NAME}, {scheme: 'file'}];
        return [
            this.insertDecoration, this.deleteDecoration, this.commentDecoration, this.commentController,
            {dispose: () => this.refreshTimers.forEach((t) => clearTimeout(t))},
            EventBus.on('reviewChangedEvent', () => this.scheduleRefresh()),
            ReplicaLinks.onDidChange(() => { this.scheduleRefresh(); this.updateCursorContext(); }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRefresh()),
            vscode.workspace.onDidOpenTextDocument((d) => { if (reviewable(d.uri)) { this.scheduleRefresh(d.uri.toString()); } }),
            // typing (shown as it will be saved), a reload from the server, or a save
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.contentChanges.length > 0 && reviewable(e.document.uri)) { this.scheduleRefresh(e.document.uri.toString()); }
            }),
            vscode.window.onDidChangeTextEditorSelection(() => this.updateCursorContext()),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateCursorContext()),
            vscode.workspace.onDidCloseTextDocument((d) => this.shown.delete(d.uri.toString())),
            vscode.workspace.onDidSaveTextDocument((d) => { if (reviewable(d.uri)) { this.scheduleRefresh(d.uri.toString()); } }),
            vscode.languages.registerHoverProvider(selector, {provideHover: (d, p) => this.provideHover(d, p)}),
            vscode.languages.registerCodeActionsProvider(selector, {provideCodeActions: (d, r) => this.provideCodeActions(d, r)}),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.toggleTrackChanges`, () => this.toggleTrackChanges()),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.acceptChange`, (...args) => this.decide(true, args)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.rejectChange`, (...args) => this.decide(false, args)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.acceptAllChanges`, (arg) => this.decideAll(true, arg)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.rejectAllChanges`, (arg) => this.decideAll(false, arg)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.nextChange`, () => this.goToChange(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.previousChange`, () => this.goToChange(false)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.addComment`, () => this.addComment()),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.submitComment`, (reply: vscode.CommentReply) => this.submitComment(reply)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.resolveThread`, (target) => this.threadAction(target, 'resolve')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.reopenThread`, (target) => this.threadAction(target, 'reopen')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.deleteThread`, (target) => this.threadAction(target, 'delete')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.editComment`, (comment: ReviewComment) => this.commentAction(comment, 'edit')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.saveComment`, (comment: ReviewComment) => this.commentAction(comment, 'save')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.cancelEditComment`, (comment: ReviewComment) => this.commentAction(comment, 'cancel')),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.deleteComment`, (comment: ReviewComment) => this.commentAction(comment, 'delete')),
        ];
    }
}
