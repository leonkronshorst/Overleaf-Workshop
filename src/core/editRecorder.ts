import * as vscode from 'vscode';
import { log } from '../utils/log';
import { ReplicaLinks } from './replicaLinks';
import { lfOps, toLf } from '../scm/replicaJournal';

export type EditOp = {p: number, i?: string, d?: string};

/** Edits that turn `base` into `text`. */
type Segment = {base: string, text: string, ops: EditOp[]};

/** Where two texts first differ, for the log. */
function describeDifference(a: string, b: string): string {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) { k++; }
    return `lengths ${a.length}/${b.length}, first difference at ${k}: ${JSON.stringify(a.slice(k, k + 20))} vs ${JSON.stringify(b.slice(k, k + 20))}`;
}

/**
 * Records the edits made in the editors of Overleaf docs since they were last clean
 * (opened, saved or reloaded), as ShareJS ops, as the web editor sends them while typing.
 * Editors of local replica copies count too: their saves reach the doc as well.
 *
 * A save could just diff the old and the new text, but a diff does not know what was
 * typed: next to existing text it matches stray letters and cuts a typed sentence into
 * fragments, which in Reviewing mode become dozens of tiny suggestions. With the real
 * edits, what was typed is one insertion and what was deleted one deletion.
 */
export class EditRecorder {
    /**
     * Per editor document: the Overleaf doc it is (or is a copy of), the edits since it was
     * last clean, and those up to its last save. A local copy is sent to Overleaf only after
     * VS Code has saved it, when its edits have already started afresh.
     */
    private static readonly docs = new Map<string, Segment & {remote: string, saved?: Segment}>();

    /** Start afresh from the document's current text. */
    static reset(document: vscode.TextDocument) {
        const key = document.uri.toString();
        const remote = ReplicaLinks.toRemote(document.uri)?.toString();
        if (remote === undefined) { EditRecorder.docs.delete(key); return; }
        const old = EditRecorder.docs.get(key);
        const saved = old && old.ops.length > 0 ? {base: old.base, text: old.text, ops: old.ops} : old?.saved;
        const text = document.getText();
        EditRecorder.docs.set(key, {remote, base: text, text, ops: [], saved});
    }

    /** How long to wait for VS Code to tell whether an edit made the document dirty. */
    static cleanCheckMs = 150;

    /**
     * A change event: an edit, or the document reloaded (from the server, or reverted).
     *
     * VS Code reports an edit before the document counts as dirty, and its dirty state in
     * a separate, later event. So an edit while the document is "not dirty" is either the
     * first edit since it was clean or a reload, and only the dirty state a moment later
     * tells which. Resetting right away lost the first edit after every save, and every
     * save then fell back to diffing (seen live: replacements flipped with the wording).
     */
    static record(event: vscode.TextDocumentChangeEvent) {
        const document = event.document;
        const key = document.uri.toString();
        const entry = EditRecorder.docs.get(key);
        if (!entry) {
            // opened before we listened: from here on
            EditRecorder.reset(document);
            return;
        }
        if (!document.isDirty) {
            const version = document.version;
            setTimeout(() => {
                // still clean and nothing typed since: a reload, the new text is the start
                if (!document.isDirty && document.version === version && !document.isClosed) {
                    EditRecorder.reset(document);
                }
            }, EditRecorder.cleanCheckMs);
        }
        // The changes of one event are all relative to the text before it and do not
        // overlap: from the last one backwards, each leaves the earlier positions intact.
        const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
        let text = entry.text;
        for (const change of changes) {
            const p = change.rangeOffset;
            if (change.rangeLength > 0) {
                EditRecorder.push(entry.ops, {p, d: text.slice(p, p + change.rangeLength)});
            }
            if (change.text.length > 0) {
                EditRecorder.push(entry.ops, {p, i: change.text});
            }
            text = text.slice(0, p) + change.text + text.slice(p + change.rangeLength);
        }
        entry.text = text;
        if (text !== document.getText()) {
            // out of step (should not happen): fall back to diffing on save
            log('warn', `edits: ${document.uri.path}: recorded edits out of step (${describeDifference(text, document.getText())})`);
            EditRecorder.docs.delete(key);
        }
    }

    /** Append `op`, merging it into the previous one when it continues it (typing, backspacing). */
    private static push(ops: EditOp[], op: EditOp) {
        const last = ops[ops.length - 1];
        if (last?.i !== undefined && op.i !== undefined && op.p === last.p + last.i.length) {
            last.i += op.i;                                       // typing on
            return;
        }
        if (last?.i !== undefined && op.d !== undefined && op.p >= last.p && op.p + op.d.length === last.p + last.i.length) {
            last.i = last.i.slice(0, op.p - last.p);              // backspacing what was just typed
            if (last.i === '') { ops.pop(); }
            return;
        }
        if (last?.d !== undefined && op.d !== undefined) {
            if (op.p === last.p) { last.d += op.d; return; }      // deleting forwards
            if (op.p + op.d.length === last.p) {                  // backspacing
                last.p = op.p;
                last.d = op.d + last.d;
                return;
            }
        }
        ops.push(op);
    }

    /** The recorded edit segments for the Overleaf file `uri`, from all its editors. */
    private static segments(uri: vscode.Uri | string) {
        const remote = uri.toString();
        return [...EditRecorder.docs.values()]
            .filter((entry) => entry.remote === remote)
            .flatMap((entry) => entry.saved ? [entry, entry.saved] : [entry]);
    }

    /** The ops recorded for the Overleaf file `uri` if they turn exactly `from` into `to`. */
    static opsFor(uri: vscode.Uri | string, from: string, to: string): EditOp[] | undefined {
        const segments = EditRecorder.segments(uri);
        const segment = segments.find((s) => s.base === from && s.text === to);
        if (segment) { return segment.ops.map((op) => ({...op})); }
        // A document with Windows line breaks: Overleaf keeps LF only, so its text and the
        // ops sent are without the CRs.
        for (const s of segments) {
            if (s.base.includes('\r') && toLf(s.base) === from && toLf(s.text) === to) {
                const ops = lfOps(s.base, s.ops);
                if (ops) { return ops; }
            }
        }
        return undefined;
    }

    /** Why the recorded ops cannot be used for `uri` from `from` to `to`; undefined if they can. */
    static why(uri: vscode.Uri | string, from: string, to: string): string | undefined {
        if (EditRecorder.opsFor(uri, from, to)) { return undefined; }
        const segments = EditRecorder.segments(uri);
        if (segments.length === 0) {
            const recorded = [...new Set([...EditRecorder.docs.values()].map((e) => e.remote))];
            return `no edits recorded for ${uri.toString()} (recorded: ${recorded.join(', ') || 'none'})`;
        }
        const s = segments.find((s) => s.base === from) ?? segments[0];
        return s.base !== from
            ? `the edits start from other text (${describeDifference(s.base, from)})`
            : `the edits lead to other text (${describeDifference(s.text, to)})`;
    }

    static get triggers(): vscode.Disposable[] {
        const ours = (document: vscode.TextDocument) => ReplicaLinks.toRemote(document.uri) !== undefined;
        vscode.workspace.textDocuments.filter(ours).forEach((d) => EditRecorder.reset(d));
        return [
            // a local replica linked or unlinked: start or stop recording its open copies
            ReplicaLinks.onDidChange(() => {
                for (const d of vscode.workspace.textDocuments) {
                    const recorded = EditRecorder.docs.has(d.uri.toString());
                    if (ours(d) !== recorded) { EditRecorder.reset(d); }
                }
            }),
            vscode.workspace.onDidOpenTextDocument((d) => { if (ours(d)) { EditRecorder.reset(d); } }),
            vscode.workspace.onDidCloseTextDocument((d) => { EditRecorder.docs.delete(d.uri.toString()); }),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!EditRecorder.docs.has(e.document.uri.toString()) && !ours(e.document)) { return; }
                if (e.contentChanges.length > 0) {
                    EditRecorder.record(e);
                } else if (!e.document.isDirty) {
                    // only the dirty state changed, to clean: saved, or undone to the saved text
                    EditRecorder.reset(e.document);
                }
            }),
            vscode.workspace.onDidSaveTextDocument((d) => { if (ours(d)) { EditRecorder.reset(d); } }),
        ];
    }
}
