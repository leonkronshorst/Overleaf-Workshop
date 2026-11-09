import * as vscode from 'vscode';
import { ReplicaLinks } from '../core/replicaLinks';
import { log } from '../utils/log';
import type { RangesTracker, TrackedChange, TrackedComment } from './rangesTracker';
import type { CommentThread } from '../api/socketio';

/** An Overleaf doc's text with its tracked changes and comments, as last seen online. */
export type CachedReview = {
    docId: string,
    content: string,
    changes: TrackedChange[],
    comments: TrackedComment[],
    /** when it was seen (ms) */
    at: number,
};

/**
 * The review state of each Overleaf doc as last seen online, so that it can be shown
 * while offline: in memory, and for a local replica copy also on disk (".overleaf/review"),
 * to survive a start while offline. Comment threads (their messages) are not kept.
 */
export class ReviewCache {
    private static readonly memory = new Map<string, CachedReview>();
    /** per file on disk: what was last written, to write only changes */
    private static readonly written = new Map<string, string>();
    private static readonly timers = new Map<string, NodeJS.Timeout>();
    static writeDelayMs = 1000;

    private static diskUri(remote: vscode.Uri): vscode.Uri | undefined {
        const at = ReplicaLinks.locate(remote);
        if (!at) { return undefined; }
        const parts = at.relPath.split('/').filter(Boolean);
        parts[parts.length - 1] += '.json';
        return vscode.Uri.joinPath(at.folder, '.overleaf', 'review', ...parts);
    }

    /** The server's state of `remote`, just seen online. */
    static remember(remote: vscode.Uri, docId: string, content: string, ranges: RangesTracker) {
        const entry: CachedReview = {
            docId, content, at: Date.now(),
            changes: structuredClone(ranges.changes),
            comments: structuredClone(ranges.comments),
        };
        ReviewCache.memory.set(remote.toString(), entry);
        const disk = ReviewCache.diskUri(remote);
        if (!disk) { return; }
        const key = disk.toString();
        clearTimeout(ReviewCache.timers.get(key));
        ReviewCache.timers.set(key, setTimeout(() => {
            ReviewCache.timers.delete(key);
            const data = JSON.stringify({version: 1, ...entry, at: undefined});
            if (ReviewCache.written.get(key) === data) { return; }
            ReviewCache.written.set(key, data);
            Promise.resolve(vscode.workspace.fs.writeFile(disk, new TextEncoder().encode(
                JSON.stringify({version: 1, ...entry})))).then(undefined, (err) => {
                ReviewCache.written.delete(key);
                log('warn', `review: could not keep the changes of ${remote.path} for offline use: ${err?.message ?? err}`);
            });
        }, ReviewCache.writeDelayMs));
    }

    private static readonly threads = new Map<string, {[threadId: string]: CommentThread}>();

    /** The file of the comment threads of the project `remote` (any of its docs) is in, if in a replica. */
    private static threadsUri(remote: vscode.Uri): vscode.Uri | undefined {
        const at = ReplicaLinks.locate(remote);
        return at ? vscode.Uri.joinPath(at.folder, '.overleaf', 'review', 'threads.json') : undefined;
    }

    /**
     * The project's comment threads with their messages, just seen online, for reading them
     * offline. In a replica also on disk (".overleaf/review/threads.json"), messages with
     * their authors' names and email addresses.
     */
    static rememberThreads(remote: vscode.Uri, threads: {[threadId: string]: CommentThread}) {
        const disk = ReviewCache.threadsUri(remote);
        const key = disk?.toString() ?? remote.with({path: '/'}).toString();
        ReviewCache.threads.set(key, structuredClone(threads));
        if (!disk) { return; }
        clearTimeout(ReviewCache.timers.get(key));
        ReviewCache.timers.set(key, setTimeout(() => {
            ReviewCache.timers.delete(key);
            const data = JSON.stringify({version: 1, threads});
            if (ReviewCache.written.get(key) === data) { return; }
            ReviewCache.written.set(key, data);
            Promise.resolve(vscode.workspace.fs.writeFile(disk, new TextEncoder().encode(data))).then(undefined, (err) => {
                ReviewCache.written.delete(key);
                log('warn', `review: could not keep the comment threads for offline use: ${err?.message ?? err}`);
            });
        }, ReviewCache.writeDelayMs));
    }

    /** The comment threads of the project `remote` as last seen online. */
    static async recallThreads(remote: vscode.Uri): Promise<{[threadId: string]: CommentThread} | undefined> {
        const disk = ReviewCache.threadsUri(remote);
        const key = disk?.toString() ?? remote.with({path: '/'}).toString();
        const known = ReviewCache.threads.get(key);
        if (known) { return known; }
        if (!disk) { return undefined; }
        try {
            const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(disk)));
            if (raw?.version !== 1 || typeof raw.threads !== 'object') { return undefined; }
            ReviewCache.threads.set(key, raw.threads);
            return raw.threads;
        } catch {
            return undefined;
        }
    }

    /** What was last seen of `remote` online, from memory or from disk. */
    static async recall(remote: vscode.Uri): Promise<CachedReview | undefined> {
        const known = ReviewCache.memory.get(remote.toString());
        if (known) { return known; }
        const disk = ReviewCache.diskUri(remote);
        if (!disk) { return undefined; }
        try {
            const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(disk)));
            if (raw?.version !== 1 || typeof raw.content !== 'string') { return undefined; }
            const entry: CachedReview = {docId: raw.docId ?? '', content: raw.content, changes: raw.changes ?? [],
                                         comments: raw.comments ?? [], at: raw.at ?? 0};
            ReviewCache.memory.set(remote.toString(), entry);
            return entry;
        } catch {
            return undefined;
        }
    }
}
