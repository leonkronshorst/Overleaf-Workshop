import * as DiffMatchPatch from 'diff-match-patch';
import { BaseIO } from './replicaBase';
import { merge3 } from './merge3';

/**
 * A ShareJS text op component, as the vfs sends them: positions after the ones before.
 * `u`: an undo op, as a reject sends them (it removes the tracked change it reverts).
 */
export type TextOp = {p: number, i?: string, d?: string, u?: boolean};

/**
 * One step made while not connected, in the order made: a save (the edits it made to the
 * text the steps before it left, in the mode it was made in), or a review decision.
 */
export type JournalEntry = {
    /** when it was made (ms) */
    at: number,
    /**
     * 'save' (or none): edits. 'reject': the undo edits that reject the changes `ids`
     * (untracked). 'accept': accept the changes `ids` (no edits). 'comment': a new comment
     * thread (no edits).
     */
    kind?: 'save' | 'reject' | 'accept' | 'comment',
    /** Reviewing (true) or Editing (false); undefined if the mode was not known then */
    tracked?: boolean,
    ops: TextOp[],
    /** the ops are the edits as typed, not a diff of the texts */
    exact: boolean,
    /** not saved in the editor (another program changed the file): mode unknown */
    external?: boolean,
    /**
     * For a tracked save: the seed Overleaf builds the ids of its suggestions from. Sent
     * with it, so they have the same ids offline as on Overleaf: a suggestion made offline
     * can be accepted or rejected offline too.
     */
    seed?: string,
    /** accept, reject: the tracked changes decided on */
    ids?: string[],
    /** comment: the new thread, on the text `c` at `p`, with its first message */
    comment?: {threadId: string, p: number, c: string, content: string, posted?: boolean},
};

/** The pending saves of one file, kept in ".overleaf/pending". */
export type FileJournal = {
    /** the text the first entry's ops apply to: what Overleaf had when it was last in sync */
    start: string,
    entries: JournalEntry[],
    /**
     * Replaying stopped at the first entry: its edits overlap with changes made on Overleaf.
     * The local file shows them between conflict markers; `remote` is Overleaf's text they
     * were merged with, so the user's resolution can be sent as the edits that lead there.
     */
    paused?: {remote: string},
};

export function applyOps(text: string, ops: TextOp[]): string {
    for (const op of ops) {
        if (op.i !== undefined) {
            text = text.slice(0, op.p) + op.i + text.slice(op.p);
        } else if (op.d !== undefined) {
            if (text.slice(op.p, op.p + op.d.length) !== op.d) {
                throw new Error(`op does not fit: ${JSON.stringify(op).slice(0, 80)}`);
            }
            text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
        }
    }
    return text;
}

/** `text` with Windows line breaks as Overleaf keeps them: LF only. */
export function toLf(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

/**
 * `ops` made on the CRLF text `text`, as they apply to `toLf(text)`: positions without the
 * CRs before them, texts without CRs. Undefined if they do not translate (e.g. an op that
 * splits a CRLF).
 */
export function lfOps(text: string, ops: TextOp[]): TextOp[] | undefined {
    if (!text.includes('\r') && !ops.some((op) => (op.i ?? op.d ?? '').includes('\r'))) { return ops.map((op) => ({...op})); }
    const out: TextOp[] = [];
    let crlf = text;
    let lf = toLf(text);
    try {
        for (const op of ops) {
            const before = crlf.slice(0, op.p);
            const p = op.p - (before.length - toLf(before).length);
            const next = applyOps(crlf, [op]);
            const nextLf = toLf(next);
            const converted: TextOp = op.i !== undefined ? {p, i: toLf(op.i)} : {p, d: toLf(op.d ?? '')};
            if ((converted.i ?? converted.d) !== '') {
                if (applyOps(lf, [converted]) !== nextLf) { return undefined; }
                out.push(converted);
            } else if (nextLf !== lf) {
                return undefined;
            }
            crlf = next;
            lf = nextLf;
        }
    } catch {
        return undefined;
    }
    return out;
}

/** The ops turning `from` into `to`, cleaned up to whole words (see textDiffOps in the vfs). */
export function diffOps(from: string, to: string): TextOp[] {
    if (from === to) { return []; }
    const dmp = new DiffMatchPatch();
    const diff = dmp.diff_main(from, to);
    dmp.diff_cleanupSemantic(diff);
    const ops: TextOp[] = [];
    let p = 0;
    for (const [kind, text] of diff) {
        if (kind === 0) { p += text.length; }
        else if (kind === 1) { ops.push({p, i: text}); p += text.length; }
        else { ops.push({p, d: text}); }
    }
    return ops;
}

// ---- ShareJS text transform (port of sharejs' text type, used by Overleaf) ----------------

function transformPosition(pos: number, c: TextOp, insertAfter: boolean): number {
    if (c.i !== undefined) {
        return c.p < pos || (c.p === pos && insertAfter) ? pos + c.i.length : pos;
    }
    const d = c.d ?? '';
    if (pos <= c.p) { return pos; }
    if (pos <= c.p + d.length) { return c.p; }
    return pos - d.length;
}

function push(dest: TextOp[], c: TextOp) {
    if (c.i === '' || c.d === '') { return; }
    dest.push(c);
}

function transformComponent(dest: TextOp[], c: TextOp, other: TextOp, side: 'left'|'right') {
    // an undo op stays one when moved
    const out: TextOp[] = [];
    transformText(out, c, other, side);
    for (const op of out) { dest.push(c.u ? {...op, u: true} : op); }
}

function transformText(dest: TextOp[], c: TextOp, other: TextOp, side: 'left'|'right') {
    if (c.i !== undefined) {
        push(dest, {p: transformPosition(c.p, other, side === 'right'), i: c.i});
        return;
    }
    const d = c.d ?? '';
    if (other.i !== undefined) {
        let s = d;
        if (c.p < other.p) {
            push(dest, {p: c.p, d: s.slice(0, other.p - c.p)});
            s = s.slice(other.p - c.p);
        }
        if (s !== '') { push(dest, {p: c.p + other.i.length, d: s}); }
        return;
    }
    const od = other.d ?? '';
    if (c.p >= other.p + od.length) {
        push(dest, {p: c.p - od.length, d});
    } else if (c.p + d.length <= other.p) {
        push(dest, {p: c.p, d});
    } else {
        let nd = '';
        if (c.p < other.p) { nd = d.slice(0, other.p - c.p); }
        if (c.p + d.length > other.p + od.length) { nd += d.slice(other.p + od.length - c.p); }
        const from = Math.max(c.p, other.p);
        const to = Math.min(c.p + d.length, other.p + od.length);
        if (d.slice(from - c.p, to - c.p) !== od.slice(from - other.p, to - other.p)) {
            throw new Error('delete ops delete different text in the same region');
        }
        if (nd !== '') { push(dest, {p: transformPosition(c.p, other, false), d: nd}); }
    }
}

/** Both op lists, each transformed to apply after the other (ShareJS transformX). */
function transformX(left: TextOp[], right: TextOp[]): [TextOp[], TextOp[]] {
    const newRight: TextOp[] = [];
    for (let rc of right as (TextOp | undefined)[]) {
        const newLeft: TextOp[] = [];
        let k = 0;
        while (k < left.length && rc) {
            const next: TextOp[] = [];
            transformComponent(newLeft, left[k], rc, 'left');
            transformComponent(next, rc, left[k], 'right');
            k++;
            if (next.length === 1) {
                rc = next[0];
            } else if (next.length === 0) {
                newLeft.push(...left.slice(k));
                rc = undefined;
            } else {
                const [l, r] = transformX(left.slice(k), next);
                newLeft.push(...l);
                newRight.push(...r);
                rc = undefined;
            }
        }
        if (rc) { newRight.push(rc); }
        left = newLeft;
    }
    return [left, newRight];
}

/** `ops`, made on the same text as `against`, transformed to apply after `against`. */
export function transformOps(ops: TextOp[], against: TextOp[]): TextOp[] {
    return transformX(ops.map((o) => ({...o})), against.map((o) => ({...o})))[0];
}

// ---- One step of the replay ---------------------------------------------------------------

export type StepResult =
    /** `ops` turn Overleaf's text into the merge of both; `exact` if they are the edits as typed */
    | {kind: 'send', ops: TextOp[], exact: boolean, result: string}
    /** Overleaf already has these edits (e.g. an upload whose answer was lost) */
    | {kind: 'nothing'}
    /** the edits overlap with Overleaf's changes: `text` shows both between markers */
    | {kind: 'conflict', text: string, conflicts: number};

/**
 * Bring the edits `ops`, which turn `start` into `target`, onto Overleaf's text `remote`.
 * Where Overleaf has not changed since `start`, they go as they are; otherwise they are
 * moved across Overleaf's changes as long as those touch other lines, as `merge3` decides.
 */
export function replayStep(start: string, target: string, ops: TextOp[], remote: string): StepResult {
    if (remote === start) {
        return ops.length ? {kind: 'send', ops, exact: true, result: target} : {kind: 'nothing'};
    }
    const merge = merge3(start, target, remote);
    if (merge.conflicts > 0) {
        return {kind: 'conflict', text: merge.text, conflicts: merge.conflicts};
    }
    if (merge.text === remote) { return {kind: 'nothing'}; }
    try {
        const moved = transformOps(ops, diffOps(start, remote));
        if (applyOps(remote, moved) === merge.text) {
            return {kind: 'send', ops: moved, exact: true, result: merge.text};
        }
    } catch {
        // does not fit: send the merge as a diff
    }
    return {kind: 'send', ops: diffOps(remote, merge.text), exact: false, result: merge.text};
}

// ---- The journal on disk --------------------------------------------------------------------

/**
 * The saves of a local replica that have not reached Overleaf yet, per file, in the order
 * they were made, each with its mode. When the connection is back they are sent one by one,
 * each as it was typed and in its own mode, as if they had been made online.
 */
export class ReplicaJournal {
    private index?: {[relPath: string]: true};
    private saving: Promise<void> = Promise.resolve();

    constructor(private readonly io: BaseIO) {}

    private async load() {
        if (!this.index) {
            const raw = await this.io.read('index.json').catch(() => undefined);
            let files = {};
            try {
                files = raw ? JSON.parse(new TextDecoder().decode(raw)).files ?? {} : {};
            } catch { /* unreadable: no journal */ }
            this.index ??= files;
        }
        return this.index!;
    }

    private saveIndex() {
        this.saving = this.saving.then(() => this.io.write('index.json',
            new TextEncoder().encode(JSON.stringify({version: 1, files: this.index}, null, 1))));
        return this.saving;
    }

    /** Load the index (needed before `has`). */
    async ready() { await this.load(); }

    /** Whether `relPath` has pending saves; once `ready`. */
    has(relPath: string): boolean {
        return this.index?.[relPath] === true;
    }

    async files(): Promise<string[]> {
        return Object.keys(await this.load());
    }

    async get(relPath: string): Promise<FileJournal | undefined> {
        if (!(await this.load())[relPath]) { return undefined; }
        const raw = await this.io.read('files' + relPath + '.json').catch(() => undefined);
        if (!raw) { return undefined; }
        try {
            const journal = JSON.parse(new TextDecoder().decode(raw));
            return journal?.version === 1 ? {start: journal.start, entries: journal.entries ?? [], paused: journal.paused} : undefined;
        } catch {
            return undefined;
        }
    }

    async set(relPath: string, journal: FileJournal | undefined) {
        const index = await this.load();
        if (!journal || (journal.entries.length === 0 && !journal.paused)) {
            if (!index[relPath]) { return; }
            delete index[relPath];
            await this.io.remove('files' + relPath + '.json').catch(() => {});
            await this.saveIndex();
            return;
        }
        await this.io.write('files' + relPath + '.json',
            new TextEncoder().encode(JSON.stringify({version: 1, ...journal})));
        if (!index[relPath]) {
            index[relPath] = true;
            await this.saveIndex();
        }
    }

    /** The text after all pending saves of `journal`. */
    static end(journal: FileJournal): string {
        return journal.entries.reduce((text, e) => applyOps(text, e.ops), journal.start);
    }

    /**
     * Add a save of `relPath` that turned the text into `to`. `start` is Overleaf's last
     * synced text, for a file without pending saves; `recorded(from, to)` gives the edits
     * as typed, if they lead exactly from `from` to `to`.
     */
    async append(relPath: string, start: string, to: string, tracked: boolean | undefined,
                 recorded: (from: string, to: string) => TextOp[] | undefined, at = Date.now(), external = false,
                 seed?: string) {
        const journal = await this.get(relPath) ?? {start, entries: []};
        const from = ReplicaJournal.end(journal);
        if (from === to) { return journal; }
        const typed = external ? undefined : recorded(from, to);
        let ops = typed;
        if (!ops || (() => { try { return applyOps(from, ops) !== to; } catch { return true; } })()) {
            ops = diffOps(from, to);
        }
        journal.entries.push({at, tracked, ops, exact: ops === typed, ...(external ? {external} : {}),
                              ...(tracked && seed ? {seed} : {})});
        await this.set(relPath, journal);
        return journal;
    }

    /** Add a review decision or a new comment (see JournalEntry) after the steps before. */
    async appendAction(relPath: string, start: string, entry: JournalEntry) {
        const journal = await this.get(relPath) ?? {start, entries: []};
        if (entry.ops.length > 0) { applyOps(ReplicaJournal.end(journal), entry.ops); } // must fit
        journal.entries.push(entry);
        await this.set(relPath, journal);
        return journal;
    }
}

// ---- Comment thread actions -------------------------------------------------------------

/** A change to a comment thread made while not connected; none of them touches the text. */
export type ThreadAction = {
    kind: 'reply' | 'edit' | 'deleteMessage' | 'resolve' | 'reopen' | 'deleteThread',
    threadId: string,
    at: number,
    /** reply: a local id ("local-…") until it is sent; edit, deleteMessage: the message */
    messageId?: string,
    content?: string,
    /** resolve, reopen, deleteThread: the doc the thread is in */
    docId?: string,
};

/**
 * The comment thread actions of a local replica made while not connected, in order, in
 * ".overleaf/pending/threads.json". Sent once the saves are (a reply may be to a thread
 * created offline). Editing or deleting a reply that was not sent yet changes the queue.
 */
export class ThreadQueue {
    private actions?: ThreadAction[];

    constructor(private readonly io: BaseIO) {}

    async list(): Promise<ThreadAction[]> {
        if (!this.actions) {
            const raw = await this.io.read('threads.json').catch(() => undefined);
            let actions: ThreadAction[] = [];
            try { actions = raw ? JSON.parse(new TextDecoder().decode(raw)).actions ?? [] : []; } catch { /* none */ }
            this.actions ??= actions;
        }
        return this.actions!;
    }

    async set(actions: ThreadAction[]) {
        this.actions = actions;
        if (actions.length === 0) {
            await this.io.remove('threads.json').catch(() => {});
        } else {
            await this.io.write('threads.json', new TextEncoder().encode(JSON.stringify({version: 1, actions})));
        }
    }

    async add(action: ThreadAction) {
        const actions = [...await this.list()];
        const queued = action.messageId?.startsWith('local-')
            ? actions.findIndex((a) => a.kind === 'reply' && a.messageId === action.messageId) : -1;
        if (queued >= 0 && action.kind === 'edit') {
            actions[queued] = {...actions[queued], content: action.content};
        } else if (queued >= 0 && action.kind === 'deleteMessage') {
            actions.splice(queued, 1);
        } else {
            actions.push(action);
        }
        await this.set(actions);
    }
}

/** What sending the thread actions needs of Overleaf; a request it refuses throws a RefusedError. */
export interface ThreadContext {
    reply(threadId: string, content: string): Promise<void>;
    edit(threadId: string, messageId: string, content: string): Promise<void>;
    deleteMessage(threadId: string, messageId: string): Promise<void>;
    resolve(threadId: string, resolved: boolean, docId?: string): Promise<void>;
    deleteThread(threadId: string, docId?: string): Promise<void>;
}

/** Overleaf refused a request (the thread or message is gone, ...): skipped, not retried. */
export class RefusedError extends Error {}

/**
 * Send the queued thread actions in order. One Overleaf refuses (its thread was deleted
 * meanwhile, ...) is skipped and returned; a lost connection stops, keeping the rest.
 */
export async function replayThreads(queue: ThreadQueue, ctx: ThreadContext): Promise<{sent: number, skipped: ThreadAction[]}> {
    let sent = 0;
    const skipped: ThreadAction[] = [];
    for (;;) {
        const [action, ...rest] = await queue.list();
        if (!action) { break; }
        try {
            switch (action.kind) {
                case 'reply': await ctx.reply(action.threadId, action.content ?? ''); break;
                case 'edit': await ctx.edit(action.threadId, action.messageId!, action.content ?? ''); break;
                case 'deleteMessage': await ctx.deleteMessage(action.threadId, action.messageId!); break;
                case 'resolve': await ctx.resolve(action.threadId, true, action.docId); break;
                case 'reopen': await ctx.resolve(action.threadId, false, action.docId); break;
                case 'deleteThread': await ctx.deleteThread(action.threadId, action.docId); break;
            }
            sent++;
        } catch (err) {
            if (!(err instanceof RefusedError)) { throw err; }
            skipped.push(action);
        }
        await queue.set(rest);
    }
    return {sent, skipped};
}

// ---- Replaying a file's journal -----------------------------------------------------------

/** Overleaf's text changed between reading it and sending edits based on it. */
export class StaleRemoteError extends Error {}

/** What a replay needs of the local copy and of Overleaf, for one file. */
export interface ReplayContext {
    /** Overleaf's current text; undefined if the file is no longer on Overleaf */
    readRemote(relPath: string): Promise<string | undefined>;
    /**
     * Send `ops` to Overleaf, built on its text `expected`, tracked or not; resolves with
     * Overleaf's text after. Throws a StaleRemoteError if Overleaf no longer has `expected`.
     */
    send(relPath: string, expected: string, ops: TextOp[], tracked: boolean, seed?: string): Promise<string>;
    /** accept the changes `ids` on Overleaf; resolves with those it does not have (any more) */
    accept(relPath: string, ids: string[]): Promise<string[]>;
    /** post the first message of the new comment thread `threadId` */
    postMessage(threadId: string, content: string): Promise<void>;
    /**
     * Comment on `c` at `p` of Overleaf's text `expected` with the thread `threadId`.
     * Throws a StaleRemoteError if Overleaf no longer has `expected`.
     */
    placeComment(relPath: string, expected: string, p: number, c: string, threadId: string): Promise<void>;
    /** a decision made offline that cannot be carried out any more: tell the user */
    skipped(relPath: string, what: 'accept' | 'comment', count: number, detail?: string): void;
    readLocal(relPath: string): Promise<string | undefined>;
    writeLocal(relPath: string, text: string): Promise<void>;
    /** keep `text` aside (in ".overleaf/conflicts"); returns where */
    keepCopy(relPath: string, text: string, what: string): Promise<string>;
    /** the mode now, for saves whose mode is not known */
    currentTracking(): boolean;
    /** both sides hold `text` now: the base of later merges */
    synced(relPath: string, text: string): Promise<void>;
    /** mark the file as in conflict (`remote` is Overleaf's text), or as resolved */
    setConflict(relPath: string, remote: string | undefined): Promise<void>;
    hasMarkers(text: string): boolean;
    log(message: string): void;
}

export type ReplayOutcome =
    /** all pending saves are on Overleaf; `sent` of them needed sending */
    | {kind: 'done', sent: number}
    /** stopped at a save that overlaps with Overleaf's changes */
    | {kind: 'paused', remaining: number, markers: number, copy?: string, earlier?: boolean}
    /** the file was deleted on Overleaf: the user decides */
    | {kind: 'gone'}
    /** nothing pending */
    | {kind: 'none'};

const label = (tracked: boolean) => tracked ? 'Reviewing' : 'Editing';

/**
 * Send the pending saves of `relPath` to Overleaf in order, each in its own mode, as long
 * as they do not overlap with what changed on Overleaf meanwhile. At the first save that
 * does, the file is paused: it shows that save's edits and Overleaf's between conflict
 * markers, and replaying goes on only once the user has saved a resolution
 * (`resolution`: the text saved without markers). Later saves wait in the journal.
 */
export async function replayFile(journal: ReplicaJournal, ctx: ReplayContext, relPath: string,
                                 resolution?: string): Promise<ReplayOutcome> {
    let j = await journal.get(relPath);
    if (!j) { return {kind: 'none'}; }
    let sent = 0;

    /** what the local file should hold once the pending saves are sent: anything else is newer */
    let expectedLocal: string;
    if (j.paused) {
        if (resolution === undefined) {
            // resolved while we were not watching (saved without markers before a restart)
            const local = await ctx.readLocal(relPath);
            if (local === undefined || ctx.hasMarkers(local)) {
                return {kind: 'paused', remaining: j.entries.length - 1, markers: 0, earlier: true};
            }
            resolution = local;
        }
        const entry = j.entries[0];
        const tracked = entry?.kind === 'reject' ? false : entry?.tracked ?? ctx.currentTracking();
        const outcome = await sendStep(j.paused.remote, resolution, diffOps(j.paused.remote, resolution), tracked, Math.max(j.entries.length, 1), false);
        if (outcome !== 'sent' && outcome !== 'nothing') { return outcome; }
        if (outcome === 'sent') { sent++; }
        ctx.log(`${relPath}: conflict resolved, sent in ${label(tracked)} mode`);
        if (entry) {
            j.start = applyOps(j.start, entry.ops);
            j.entries.shift();
        }
        j.paused = undefined;
        await ctx.setConflict(relPath, undefined);
        await journal.set(relPath, j);
        expectedLocal = resolution;
    } else {
        // changed by another program since the last save: that goes last, in the mode of now
        const local = await ctx.readLocal(relPath);
        const end = ReplicaJournal.end(j);
        if (local !== undefined && local !== end && !ctx.hasMarkers(local)) {
            ctx.log(`${relPath}: changed outside the editor since its last save: sent last, in the current mode`);
            j = await journal.append(relPath, j.start, local, undefined, () => undefined, Date.now(), true);
        }
        expectedLocal = ReplicaJournal.end(j);
    }

    for (;;) {
        while (j.entries.length > 0) {
            const entry = j.entries[0];
            if (entry.kind === 'accept' || entry.kind === 'comment') {
                const outcome = await decisionStep(entry);
                if (outcome) { return outcome; }
                j.entries.shift();
                await journal.set(relPath, j);
                continue;
            }
            const target = applyOps(j.start, entry.ops);
            const tracked = entry.kind === 'reject' ? false : entry.tracked ?? ctx.currentTracking();
            const outcome = await sendStep(j.start, target, entry.ops, tracked, j.entries.length, entry.exact, entry.seed);
            if (outcome !== 'sent' && outcome !== 'nothing') { return outcome; }
            if (outcome === 'sent') { sent++; }
            j.start = target;
            j.entries.shift();
            await journal.set(relPath, j);
        }
        // Saved again meanwhile: that save was made on what the file showed, so it goes the
        // same way (and the local file is not overwritten under it).
        const local = await ctx.readLocal(relPath);
        if (local !== undefined && local !== expectedLocal && !ctx.hasMarkers(local)) {
            await journal.set(relPath, undefined);
            j = await journal.append(relPath, expectedLocal, local, undefined, () => undefined);
            expectedLocal = local;
            continue;
        }
        break;
    }

    // all on Overleaf: the local copy takes Overleaf's text, which may hold others' changes too
    const remote = await ctx.readRemote(relPath);
    if (remote === undefined) { return {kind: 'gone'}; }
    const local = await ctx.readLocal(relPath);
    if (local !== remote) { await ctx.writeLocal(relPath, remote); }
    await ctx.synced(relPath, remote);
    await journal.set(relPath, undefined);
    // a change on Overleaf that came in meanwhile was held back for the journal: take it now
    const again = await ctx.readRemote(relPath);
    if (again !== undefined && again !== remote && await ctx.readLocal(relPath) === remote) {
        await ctx.writeLocal(relPath, again);
        await ctx.synced(relPath, again);
    }
    return {kind: 'done', sent};

    /**
     * Carry out an accept or a new comment made offline, on the text the steps before it
     * left (`j.start`), moved to where Overleaf has it now. What Overleaf no longer has
     * (accepted, rejected or edited meanwhile; the commented text changed) is skipped.
     */
    async function decisionStep(entry: JournalEntry): Promise<ReplayOutcome | undefined> {
        if (entry.kind === 'accept') {
            const missing = await ctx.accept(relPath, entry.ids ?? []);
            if (missing.length > 0) { ctx.skipped(relPath, 'accept', missing.length); }
            ctx.log(`${relPath}: accepted ${(entry.ids?.length ?? 0) - missing.length} suggestion(s) as decided offline`);
            return undefined;
        }
        const comment = entry.comment!;
        for (let attempt = 0; ; attempt++) {
            const remote = await ctx.readRemote(relPath);
            if (remote === undefined) { return {kind: 'gone'}; }
            // moved across Overleaf's changes; text inserted right where it starts goes before it
            let p = comment.p;
            if (remote !== j!.start) {
                for (const op of diffOps(j!.start, remote)) { p = transformPosition(p, op, true); }
            }
            if (p < 0 || remote.slice(p, p + comment.c.length) !== comment.c) {
                ctx.skipped(relPath, 'comment', 1, comment.content);
                return undefined;
            }
            if (!comment.posted) {
                await ctx.postMessage(comment.threadId, comment.content);
                comment.posted = true;
                await journal.set(relPath, j!);
            }
            try {
                await ctx.placeComment(relPath, remote, p, comment.c, comment.threadId);
                ctx.log(`${relPath}: placed a comment made offline`);
                return undefined;
            } catch (err) {
                if (err instanceof StaleRemoteError && attempt < 5) { continue; }
                throw err;
            }
        }
    }

    /** Bring the edits `ops` (from `start` to `target`) onto Overleaf, retrying if it moves meanwhile. */
    async function sendStep(start: string, target: string, ops: TextOp[], tracked: boolean, remaining: number, typed: boolean,
                            seed?: string): Promise<'sent' | 'nothing' | ReplayOutcome> {
        for (let attempt = 0; ; attempt++) {
            const remote = await ctx.readRemote(relPath);
            if (remote === undefined) { return {kind: 'gone'}; }
            const step = replayStep(start, target, ops, remote);
            if (step.kind === 'nothing') { return 'nothing'; }
            if (step.kind === 'conflict') {
                const local = await ctx.readLocal(relPath);
                const copy = local !== undefined ? await ctx.keepCopy(relPath, local, 'local') : undefined;
                j!.paused = {remote};
                await journal.set(relPath, j!);
                await ctx.setConflict(relPath, remote);
                await ctx.writeLocal(relPath, step.text);
                ctx.log(`${relPath}: a pending save overlaps with changes on Overleaf: paused (${remaining - 1} more after it)`);
                return {kind: 'paused', remaining: remaining - 1, markers: step.conflicts, copy};
            }
            try {
                await ctx.send(relPath, remote, step.ops, tracked, seed);
                ctx.log(`${relPath}: sent a pending save, ${step.ops.length} ops ${step.exact && typed ? 'as typed' : 'from a diff'}, ${label(tracked)} mode`);
                return 'sent';
            } catch (err) {
                if (err instanceof StaleRemoteError && attempt < 5) { continue; }
                throw err;
            }
        }
    }
}
