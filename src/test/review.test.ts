/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and class export names */
import * as assert from 'assert';
import Module = require('module');

// The modules under test import 'vscode', which only exists inside the extension host.
function stub(): any {
    const f: any = function () { return stub(); };
    return new Proxy(f, {
        get(target, key) {
            if (key === 'then') { return undefined; }
            if (!(key in target)) { target[key] = stub(); }
            return target[key];
        },
        construct() { return stub(); },
    });
}
const withStubs = (target: any): any => new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : stub()),
});
/** a vscode.Uri, as far as the code under test looks at it */
function fakeUri(scheme: string, path: string, authority = '', query = ''): any {
    return {
        scheme, authority, path, query,
        with: (change: any) => fakeUri(change.scheme ?? scheme, change.path ?? path, change.authority ?? authority, change.query ?? query),
        toString: () => `${scheme}://${authority}${path}${query ? '?' + query : ''}`,
    };
}
const vscodeMock = withStubs({
    Disposable: class { constructor(private readonly onDispose?: () => void) {} dispose() { this.onDispose?.(); } },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    workspace: withStubs({ textDocuments: [] }),
    window: withStubs({ createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) }),
    l10n: { t: (message: string) => message },
});
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { VirtualFileSystem, textDiffOps } = require('../core/remoteFileSystemProvider');
const { EditRecorder } = require('../core/editRecorder');
const { SocketIOAPI } = require('../api/socketio');
const { GlobalStateManager } = require('../utils/globalStateManager');
const { RangesTracker } = require('../review/rangesTracker');
const { ReplicaLinks } = require('../core/replicaLinks');
const { ReviewManager } = require('../review/reviewManager');
const { ReviewCache } = require('../review/reviewCache');
const { LocalReplicaSCMProvider } = require('../scm/localReplicaSCM');
moduleAny._load = originalLoad;

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); } };

type Op = {p: number, i?: string, d?: string, c?: string, t?: string, u?: boolean};

/** what the client's and the server's ranges must agree on (timestamps differ) */
const shape = (ranges: any) => ({
    changes: ranges.changes.map((c: any) => ({id: c.id, op: c.op, user_id: c.metadata?.user_id})),
    comments: ranges.comments.map((c: any) => ({id: c.id, op: c.op})),
});

/**
 * A fake of Overleaf's real-time + document-updater services for one doc, which keeps
 * the doc's tracked changes and comments with the very RangesTracker the server uses.
 */
function setup(initialContent: string) {
    const server = {
        content: initialContent, v: 10,
        ranges: new RangesTracker([], []),
        emitted: [] as any[],
    };
    const handlers: any = {};
    const deliver = (msg: any) => setImmediate(() => handlers.onFileChanged(msg));
    const apply = (op: Op[], meta: {tc?: string, user_id: string}) => {
        for (const c of op) {
            if (c.i !== undefined) {
                server.content = server.content.slice(0, c.p) + c.i + server.content.slice(c.p);
            } else if (c.d !== undefined) {
                server.content = server.content.slice(0, c.p) + server.content.slice(c.p + c.d.length);
            }
        }
        // as document-updater's RangesManager does
        server.ranges.track_changes = meta.tc !== undefined;
        if (meta.tc) { server.ranges.setIdSeed(meta.tc); }
        for (const c of op) { server.ranges.applyOp(c, {user_id: meta.user_id, ts: new Date()}); }
        server.v += 1;
    };
    const socket = {
        isUsingAlternativeConnectionScheme: false,
        isConnected: true,
        permissionsLevel: 'owner',
        updateEventHandlers(h: any) { Object.assign(handlers, h); },
        async joinDoc() {
            return {
                docLines: server.content.split('\n'), version: server.v,
                ranges: JSON.parse(JSON.stringify({changes: server.ranges.changes, comments: server.ranges.comments})),
            };
        },
        async applyOtUpdate(docId: string, update: any) {
            server.emitted.push(update);
            const at = server.v;
            apply(update.op, {tc: update.meta?.tc, user_id: 'me'});
            deliver({doc: docId, v: at});
        },
    };
    /** another client edits through the web editor, tracked when `tc` is given */
    const collaborator = (op: Op[], tc?: string, user = 'anna') => {
        const v = server.v;
        apply(op, {tc, user_id: user});
        deliver({doc: 'doc1', v, op, meta: {source: 'web', user_id: user, ts: Date.now(), ...(tc ? {tc} : {})}});
    };

    const doc: any = { _id: 'doc1', name: 'main.tex' };
    const uri: any = { scheme: 'overleaf-workshop', toString: () => 'overleaf-workshop://test/main.tex', path: '/test/main.tex' };
    vscodeMock.workspace.textDocuments = [{ isDirty: false, uri }];
    const http: string[] = [];
    const vfs = Object.create(VirtualFileSystem.prototype);
    Object.assign(vfs, {
        socket, notify: () => {}, connections: [], userId: 'me', projectName: 'test', projectId: 'p1',
        origin: { toString: () => 'overleaf-workshop://test' }, context: {},
        root: { rootFolder: [{ docs: [doc], folders: [] }], trackChangesState: {} },
        api: {
            acceptChanges: async (_i: any, _p: string, docId: string, ids: string[]) => {
                http.push(`accept ${ids.join(',')}`);
                server.ranges.removeChangeIds(ids);
                return {type: 'success'};
            },
            sendThreadMessage: async (_i: any, _p: string, threadId: string, content: string) => {
                http.push(`message ${threadId} ${content}`);
                return {type: 'success'};
            },
        },
    });
    vfs._resolveUri = async () => ({ fileType: 'doc', fileEntity: doc });
    vfs._resolveById = () => ({ path: '/main.tex', fileEntity: doc });
    vfs.pathToUri = () => uri;
    vfs.remoteWatch();
    handlers.onConnectionAccepted('conn1');

    return {
        server, doc, vfs, uri, http, handlers, collaborator,
        open: async () => new TextDecoder().decode(await vfs.openFile(uri)),
        save: (text: string) => vfs.writeFile(uri, new TextEncoder().encode(text), false, true),
        reviewing: (on: boolean) => { vfs.root.trackChangesState = {me: on}; },
    };
}

describe('Review: tracked changes and comments', () => {
    const authenticate = GlobalStateManager.authenticate;
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => {
        GlobalStateManager.authenticate = async () => ({});
        VirtualFileSystem.ownUpdateAckTimeoutMs = 20;
    });
    after(() => {
        GlobalStateManager.authenticate = authenticate;
        VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout;
    });

    it('takes the ranges a doc has when it is opened', async () => {
        const t = setup('hello world');
        t.collaborator([{p: 6, i: 'big '}], RangesTracker.generateIdSeed());
        await t.open();
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
        assert.strictEqual(t.doc.ranges.changes[0].op.i, 'big ');
    });

    it('follows a collaborator\'s suggestions with the ids the server gives them', async () => {
        const t = setup('hello world');
        await t.open();
        t.collaborator([{p: 5, i: ' big'}], RangesTracker.generateIdSeed());
        t.collaborator([{p: 0, d: 'hello'}], RangesTracker.generateIdSeed());
        t.collaborator([{p: 0, i: 'x'}]);                      // untracked edit: just moves them
        await settle();
        assert.strictEqual(t.server.ranges.changes.length, 2);
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
    });

    it('records its own tracked saves exactly as the server does', async () => {
        const t = setup('The results show the trend');
        await t.open();
        t.reviewing(true);
        await t.save('The results clearly show a trend');
        await settle();
        assert.ok(t.server.emitted[0].meta?.tc, 'the save is sent as tracked changes');
        assert.ok(t.server.ranges.changes.length >= 2);
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
    });

    it('previews unsaved edits exactly as the server records them on saving', async () => {
        const t = setup('We see that the results show a clear trend.');
        await t.open();
        t.collaborator([{p: 0, i: 'Here '}], RangesTracker.generateIdSeed());   // an existing suggestion
        await settle();
        await t.open();                                        // the editor reloads it
        t.reviewing(true);
        const typed = 'Here We see that our results clearly show the trend.';
        // the preview, as the editor builds it while typing (ReviewManager.currentReviewDoc)
        const preview = new RangesTracker(structuredClone(t.doc.ranges.changes), structuredClone(t.doc.ranges.comments));
        preview.track_changes = true;
        preview.setIdSeed(RangesTracker.generateIdSeed());
        for (const op of textDiffOps(t.doc.remoteCache, typed)) { preview.applyOp(op, {user_id: 'me', ts: new Date()}); }
        // then the save
        await t.save(typed);
        await settle();
        const ops = (ranges: any) => ranges.changes.map((c: any) => ({op: c.op, user_id: c.metadata?.user_id}));
        assert.deepStrictEqual(ops(preview), ops(t.server.ranges), 'same suggestions, at the same places');
        assert.ok(t.server.ranges.changes.length > 2);
    });

    it('saves typed text in Reviewing mode as one suggestion per edit, as the web editor does', async () => {
        const before = 'Does it work if I change sth here ?\n\\cite{x}';
        const t = setup(before);
        await t.open();
        t.reviewing(true);
        const e = fakeEditor(t.uri, before);
        for (let k = 0; k < 8; k++) { e.edit({at: 0, remove: 1}); }     // delete "Does it " key by key
        e.type(27, '\nOk lets see if this works\nit would be great if it did'); // then type new lines
        await t.save(e.text);
        await settle();
        assert.strictEqual(t.server.content, e.text);
        assert.deepStrictEqual(t.server.ranges.changes.map((c: any) => c.op).sort((a: any, b: any) => a.p - b.p), [
            {p: 0, d: 'Does it '},
            {p: 27, i: '\nOk lets see if this works\nit would be great if it did'},
        ]);
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
    });

    it('saves a local replica copy as typed too, though it reaches Overleaf only after VS Code saved it', async () => {
        const before = 'Does it work if I change sth here ?';
        const t = setup(before);
        await t.open();
        t.reviewing(true);
        const link = ReplicaLinks.link(fakeUri('file', '/c:/Users/me/test'), fakeUri('overleaf-workshop', '', 'test'));
        try {
            const e = fakeEditor(fakeUri('file', '/c:/Users/me/test/main.tex'), before);
            e.edit({at: 8, remove: 4, insert: 'works'});           // "work" replaced by a similar word
            // VS Code saves the copy, so it is clean and its edits start afresh...
            e.document.isDirty = false;
            EditRecorder.reset(e.document);
            // ...and only then does the replica write it to the doc
            await t.save(e.text);
            await settle();
            assert.strictEqual(t.server.content, e.text);
            // as typed: the old word deleted, the new one inserted (a diff would only insert "s")
            assert.deepStrictEqual(t.server.ranges.changes.map((c: any) => c.op.d ?? c.op.i).sort(), ['work', 'works']);
            assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
        } finally {
            link.dispose();
        }
    });

    it('rejects suggestions with undo ops, restoring the text and leaving no changes behind', async () => {
        const original = 'foo bar baz';
        const t = setup(original);
        await t.open();
        // "bar" replaced by "quux" as a suggestion: an insertion next to a deletion
        t.collaborator([{p: 4, i: 'quux'}, {p: 8, d: 'bar'}], RangesTracker.generateIdSeed());
        await settle();
        assert.strictEqual(t.server.content, 'foo quux baz');
        t.reviewing(true);                                     // our reverts must not become suggestions
        await t.vfs.rejectChanges(t.uri, t.doc.ranges.changes.map((c: any) => c.id));
        await settle();
        assert.strictEqual(t.server.content, original);
        assert.deepStrictEqual(t.server.ranges.changes, [], 'the server keeps no changes');
        assert.deepStrictEqual(t.doc.ranges.changes, []);
        assert.strictEqual(t.doc.remoteCache, original);
        assert.ok(t.server.emitted[0].op.every((op: Op) => op.u === true), 'sent as undo ops');
    });

    it('rejects any mix of suggestions, also interleaved ones, back to the original text', async () => {
        // Seen live: suggestions cut into fragments (a raw character diff), with insertions
        // and deletions sharing positions; rejecting them all left the text garbled and
        // made new suggestions. Random edits like those, rejected all or in part:
        const DMP = require('diff-match-patch');
        const dmp = new DMP();
        const rawOps = (from: string, to: string) => {
            let pos = 0;
            return dmp.diff_main(from, to).flatMap(([kind, text]: [number, string]) => {
                const start = pos;
                if (kind !== -1) { pos += text.length; }
                return kind === 0 ? [] : [kind === 1 ? {p: start, i: text} : {p: start, d: text}];
            });
        };
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const words = ['Does', 'it', 'work', 'if', 'I', 'change', 'sth', 'here', '?', 'Ok', 'lets', 'see', '\n'];
        const sentence = (n: number) => Array.from({length: n}, () => words[Math.floor(rnd() * words.length)]).join(' ');
        for (let run = 0; run < 150; run++) {
            const original = sentence(8 + Math.floor(rnd() * 8));
            const t = setup(original);
            await t.open();
            let content = original;
            for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
                const edited = content.split(' ').filter(() => rnd() > 0.3)
                    .flatMap((w) => rnd() > 0.7 ? [w, sentence(1 + Math.floor(rnd() * 3))] : [w]).join(' ');
                t.collaborator(rawOps(content, edited), RangesTracker.generateIdSeed(), rnd() > 0.5 ? 'me' : 'anna');
                content = edited;
            }
            await settle();
            await t.open();
            t.reviewing(rnd() > 0.5);
            const ids = t.doc.ranges.changes.map((c: any) => c.id);
            const all = rnd() > 0.3;
            await t.vfs.rejectChanges(t.uri, all ? ids : ids.filter(() => rnd() > 0.5));
            await settle();
            const context = `run ${run}: ${JSON.stringify(original)}`;
            if (all) {
                assert.strictEqual(t.server.content, original, context);
                assert.deepStrictEqual(t.server.ranges.changes, [], context);
            }
            assert.ok(t.server.emitted.every((u: any) => u.meta?.tc === undefined), 'rejects are never tracked');
            assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges), context);
            assert.strictEqual(t.doc.remoteCache, t.server.content, context);
        }
    });

    it('accepts suggestions over HTTP and drops them from the ranges', async () => {
        const t = setup('hello world');
        await t.open();
        t.collaborator([{p: 5, i: ' big'}], RangesTracker.generateIdSeed());
        await settle();
        const id = t.doc.ranges.changes[0].id;
        await t.vfs.acceptChanges(t.uri, [id]);
        assert.deepStrictEqual(t.http, [`accept ${id}`]);
        assert.deepStrictEqual(t.doc.ranges.changes, []);
        assert.strictEqual(t.server.content, 'hello big world', 'the text stays');
        // the server's broadcast of the same accept is harmless
        t.handlers.onChangesAccepted('doc1', [id]);
        assert.deepStrictEqual(t.doc.ranges.changes, []);
    });

    it('adds a comment: first the message, then a comment op on the text', async () => {
        const t = setup('see the figure below');
        await t.open();
        const threadId = await t.vfs.addComment(t.uri, 8, 6, 'which figure?');
        await settle();
        assert.deepStrictEqual(t.http, [`message ${threadId} which figure?`]);
        assert.deepStrictEqual(t.server.emitted[0].op, [{p: 8, c: 'figure', t: threadId}]);
        assert.strictEqual(t.server.content, 'see the figure below', 'a comment does not change the text');
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
        assert.strictEqual(t.doc.ranges.comments[0].op.t, threadId);
    });

    it('keeps comments on their text while others edit around them', async () => {
        const t = setup('see the figure below');
        await t.open();
        const threadId = await t.vfs.addComment(t.uri, 8, 6, 'which figure?');
        await settle();
        t.collaborator([{p: 0, i: 'Please '}]);
        t.collaborator([{p: 15, i: 'big '}]);
        await settle();
        const comment = t.doc.ranges.comments.find((c: any) => c.op.t === threadId);
        assert.strictEqual(t.server.content.slice(comment.op.p, comment.op.p + comment.op.c.length), 'figure');
        assert.deepStrictEqual(shape(t.doc.ranges), shape(t.server.ranges));
    });

    it('keeps the loaded comment threads up to date from the server\'s events', async () => {
        const t = setup('text');
        t.vfs.threads = {t1: {messages: [{id: 'm1', content: 'first', user_id: 'anna', timestamp: 1}]}};
        t.handlers.onThreadEvent({type: 'new-comment', threadId: 't1', message: {id: 'm2', content: 'reply', user_id: 'me', timestamp: 2}});
        t.handlers.onThreadEvent({type: 'new-comment', threadId: 't1', message: {id: 'm2', content: 'reply', user_id: 'me', timestamp: 2}});
        t.handlers.onThreadEvent({type: 'edit-message', threadId: 't1', messageId: 'm1', content: 'first (edited)'});
        t.handlers.onThreadEvent({type: 'resolve-thread', threadId: 't1', user: {id: 'anna'}});
        assert.deepStrictEqual(t.vfs.threads.t1.messages.map((m: any) => m.content), ['first (edited)', 'reply']);
        assert.strictEqual(t.vfs.threads.t1.resolved, true);
        t.handlers.onThreadEvent({type: 'reopen-thread', threadId: 't1'});
        assert.strictEqual(t.vfs.threads.t1.resolved, undefined);
        t.handlers.onThreadEvent({type: 'delete-thread', threadId: 't1'});
        assert.strictEqual(t.vfs.threads.t1, undefined);
    });
});

/** An editor document whose edits go through EditRecorder, as VS Code reports them. */
function fakeEditor(uri: any, text: string) {
    const document = { uri, isDirty: false, getText: () => text };
    EditRecorder.reset(document);
    return {
        document,
        /** one change event; several changes are relative to the text before the event */
        edit(...changes: {at: number, remove?: number, insert?: string}[]) {
            const contentChanges = changes.map((c) => ({rangeOffset: c.at, rangeLength: c.remove ?? 0, text: c.insert ?? ''}));
            for (const c of [...contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
                text = text.slice(0, c.rangeOffset) + c.text + text.slice(c.rangeOffset + c.rangeLength);
            }
            document.isDirty = true;
            EditRecorder.record({document, contentChanges});
        },
        type(at: number, chars: string) {
            [...chars].forEach((ch, k) => this.edit({at: at + k, insert: ch}));
        },
        get text() { return text; },
    };
}

describe('EditRecorder: saving what was typed', () => {
    const uri: any = { scheme: 'overleaf-workshop', toString: () => 'overleaf-workshop://test/rec.tex' };

    it('turns keystrokes into whole insertions and deletions', () => {
        const e = fakeEditor(uri, 'Does it work if I change sth here ?');
        e.type(35, ' Ok lets see');                              // typed at the end
        for (let k = 0; k < 4; k++) { e.edit({at: 46 - k, remove: 1}); } // backspaced " see"
        e.type(43, ' try');
        for (let k = 0; k < 5; k++) { e.edit({at: 8, remove: 1}); }      // forward-deleted "work "
        assert.deepStrictEqual(EditRecorder.opsFor(uri, 'Does it work if I change sth here ?', e.text), [
            {p: 35, i: ' Ok lets try'},
            {p: 8, d: 'work '},
        ]);
        assert.strictEqual(e.text, 'Does it if I change sth here ? Ok lets try');
    });

    it('handles several changes in one event (multi-cursor)', () => {
        const e = fakeEditor(uri, 'a b c');
        e.edit({at: 0, insert: 'X'}, {at: 2, remove: 1, insert: 'Y'}, {at: 4, insert: 'Z'});
        const ops = EditRecorder.opsFor(uri, 'a b c', e.text)!;
        let text = 'a b c';
        for (const op of ops) {
            text = op.i !== undefined ? text.slice(0, op.p) + op.i + text.slice(op.p) : text.slice(0, op.p) + text.slice(op.p + op.d!.length);
        }
        assert.strictEqual(text, e.text);
    });

    it('keeps the first edit after a save, which VS Code reports before the document is dirty', async () => {
        const wait = EditRecorder.cleanCheckMs;
        EditRecorder.cleanCheckMs = 5;
        try {
            let text = 'saved text';
            const document = { uri, isDirty: false, isClosed: false, version: 1, getText: () => text };
            EditRecorder.reset(document);
            const change = (at: number, insert: string) => {
                text = text.slice(0, at) + insert + text.slice(at);
                document.version += 1;
                EditRecorder.record({document, contentChanges: [{rangeOffset: at, rangeLength: 0, text: insert}]});
            };
            change(5, ' new');                    // the edit arrives while still "not dirty"...
            document.isDirty = true;              // ...the dirty state a moment later
            await new Promise((r) => setTimeout(r, 20));
            assert.deepStrictEqual(EditRecorder.opsFor(uri, 'saved text', text), [{p: 5, i: ' new'}]);

            // a reload from the server: the document stays clean, so its text is the new start
            document.isDirty = false;
            text = 'saved new text (reloaded)';
            document.version += 1;
            EditRecorder.record({document, contentChanges: [{rangeOffset: 0, rangeLength: 14, text}]});
            await new Promise((r) => setTimeout(r, 20));
            assert.deepStrictEqual(EditRecorder.opsFor(uri, text, text), []);
        } finally {
            EditRecorder.cleanCheckMs = wait;
        }
    });

    it('is not used for a save from another starting point', () => {
        const e = fakeEditor(uri, 'hello');
        e.type(5, ' world');
        assert.strictEqual(EditRecorder.opsFor(uri, 'hello (changed by others)', e.text), undefined);
        assert.strictEqual(EditRecorder.opsFor(uri, 'hello', 'something else'), undefined);
    });

    it('maps local replica files to their Overleaf docs and back while linked', () => {
        const remote = fakeUri('overleaf-workshop', '/Thesis', 'www.overleaf.com', 'user=u&project=p');
        const link = ReplicaLinks.link(fakeUri('file', '/c:/Users/me/Thesis'), remote);
        const local = (path: string) => ReplicaLinks.toRemote(fakeUri('file', path))?.toString();
        try {
            assert.strictEqual(local('/c:/Users/me/Thesis/chapters/intro.tex'),
                'overleaf-workshop://www.overleaf.com/Thesis/chapters/intro.tex?user=u&project=p');
            if (process.platform === 'win32') {
                assert.ok(local('/C:/users/ME/Thesis/main.tex'), 'Windows paths are case-insensitive');
            }
            assert.strictEqual(local('/c:/Users/me/Thesis2/main.tex'), undefined, 'another folder with the same start');
            assert.strictEqual(local('/c:/Users/me/Thesis/.overleaf/settings.json'), undefined, 'the replica\'s own files');
            assert.strictEqual(ReplicaLinks.toLocal(fakeUri('overleaf-workshop', '/Thesis/main.tex', 'www.overleaf.com', 'user=u&project=p'))?.path,
                '/c:/Users/me/Thesis/main.tex');
            assert.strictEqual(ReplicaLinks.toLocal(fakeUri('overleaf-workshop', '/Thesis/main.tex', 'www.overleaf.com', 'user=u&project=other')), undefined);
        } finally {
            link.dispose();
        }
        assert.strictEqual(local('/c:/Users/me/Thesis/main.tex'), undefined, 'unlinked');
    });

    it('falls back to a diff that is not cut into fragments', () => {
        const ops = textDiffOps(' Does it  if I me  ? ', '   if I me ? \n Ok lets see ig this works \n it would be great if it did\n');
        assert.ok(ops.length <= 3, `${ops.length} ops: ${JSON.stringify(ops)}`);
    });
});

describe('Review and replayed saves without a connection', () => {
    const authenticate = GlobalStateManager.authenticate;
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => {
        GlobalStateManager.authenticate = async () => ({});
        VirtualFileSystem.ownUpdateAckTimeoutMs = 20;
    });
    after(() => {
        GlobalStateManager.authenticate = authenticate;
        VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout;
    });

    it('sends replayed edits in the mode they were made in, not the mode of now', async () => {
        const t = setup('intro\nmethods\n');
        await t.open();
        t.reviewing(false);
        const after = await t.vfs.applyEdits(t.uri, 'intro\nmethods\n', [{p: 5, i: ', offline'}], true);
        await settle();
        assert.strictEqual(after, 'intro, offline\nmethods\n');
        assert.ok(t.server.emitted[0].meta?.tc, 'tracked although the user is in Editing now');
        assert.strictEqual(t.server.ranges.changes[0].op.i, ', offline');
        t.reviewing(true);
        await t.vfs.applyEdits(t.uri, after, [{p: 0, d: 'intro'}, {p: 0, i: 'Intro'}], false);
        await settle();
        assert.strictEqual(t.server.emitted[1].meta?.tc, undefined, 'untracked although the user is in Reviewing now');
        assert.strictEqual(t.server.content, 'Intro, offline\nmethods\n');
    });

    it('refuses edits built on text Overleaf no longer has', async () => {
        const t = setup('hello world');
        await t.open();
        t.collaborator([{p: 0, i: 'well, '}]);
        await settle();
        await assert.rejects(t.vfs.applyEdits(t.uri, 'hello world', [{p: 5, i: '!'}], false), /changed on Overleaf/);
        assert.strictEqual(t.server.emitted.length, 0);
    });

    it('fails review actions at once while offline, and never does them later', async () => {
        const t = setup('hello world');
        await t.open();
        t.collaborator([{p: 5, i: ' big'}], RangesTracker.generateIdSeed());
        await settle();
        const id = t.doc.ranges.changes[0].id;
        t.vfs.offline = true;
        await assert.rejects(t.vfs.rejectChanges(t.uri, [id]), /needs a connection/);
        await assert.rejects(t.vfs.acceptChanges(t.uri, [id]), /needs a connection/);
        await assert.rejects(t.vfs.addComment(t.uri, 0, 5, 'hm'), /needs a connection/);
        await assert.rejects(t.vfs.replyToThread('t1', 'hm'), /needs a connection/);
        t.vfs.offline = false;
        await t.open();
        await t.save('hello big world!');
        await settle();
        assert.deepStrictEqual(t.http, []);
        assert.strictEqual(t.server.emitted.length, 1, 'only the save');
        assert.strictEqual(t.server.content, 'hello big world!', 'the suggestion was not rejected later');
    });

    it('does not retry a reject whose upload failed at the next save', async () => {
        const t = setup('hello world');
        await t.open();
        t.collaborator([{p: 5, i: ' big'}], RangesTracker.generateIdSeed());
        await settle();
        const id = t.doc.ranges.changes[0].id;
        const socket = (t.vfs as any).socket;
        const apply = socket.applyOtUpdate;
        socket.applyOtUpdate = async () => { throw new Error('timed out'); };
        await assert.rejects(t.vfs.rejectChanges(t.uri, [id]));
        assert.strictEqual(t.doc.unconfirmed, undefined);
        socket.applyOtUpdate = apply;
        await t.open();
        await t.save('hello big world!');
        await settle();
        assert.strictEqual(t.server.content, 'hello big world!', 'the failed reject did not come back');
        assert.strictEqual(t.server.ranges.changes.length, 1);
    });
});

describe('Switching Editing/Reviewing while offline', () => {
    const authenticate = GlobalStateManager.authenticate;
    before(() => { GlobalStateManager.authenticate = async () => ({}); });
    after(() => { GlobalStateManager.authenticate = authenticate; });

    /** a vfs whose mode is stored as on a real machine, "server" being Overleaf's */
    function offlineVfs(last: boolean, server: boolean) {
        const t = setup('text');
        const store = new Map<string, any>();
        const sent: any[] = [];
        t.vfs.context = {globalState: {get: (k: string) => store.get(k), update: async (k: string, v: any) => { store.set(k, v); }}};
        t.vfs.api.setTrackChanges = async (_i: any, _p: string, onFor: any) => { sent.push(onFor); return {type: 'success'}; };
        t.reviewing(last);
        t.vfs.rememberTracking();                  // what was known when the connection went
        const joined = t.vfs.root;
        t.vfs.offline = true;
        t.vfs.root = undefined;
        /** the connection is back, Overleaf having the mode "server" */
        const rejoin = async () => {
            t.vfs.offline = false;
            t.vfs.root = joined;
            t.reviewing(server);
            await t.vfs.settleOfflineSwitch();
        };
        return {t, sent, rejoin};
    }

    it('applies a switch made offline to the saves at once, and sends it to Overleaf on reconnect', async () => {
        const {t, sent, rejoin} = offlineVfs(true, true);
        assert.strictEqual(t.vfs.knownTracking, true);
        await t.vfs.setTrackChangesForMe(false);
        assert.strictEqual(t.vfs.knownTracking, false, 'saves from now on are kept in Editing');
        assert.deepStrictEqual(sent, [], 'nothing sent while offline');
        await rejoin();
        assert.deepStrictEqual(sent, [{me: false}], 'switched on Overleaf once back');
        assert.strictEqual(t.vfs.isTrackingChanges, false);
    });

    it('keeps a switch made elsewhere when there was none here', async () => {
        const {t, sent, rejoin} = offlineVfs(true, false);
        await rejoin();
        assert.deepStrictEqual(sent, []);
        assert.strictEqual(t.vfs.isTrackingChanges, false);
    });

    it('takes a switch to the same mode on both sides as settled', async () => {
        const {t, sent, rejoin} = offlineVfs(true, false);     // Overleaf: switched to Editing elsewhere
        await t.vfs.setTrackChangesForMe(false);                // and here too
        await rejoin();
        assert.deepStrictEqual(sent, []);
        assert.strictEqual(t.vfs.isTrackingChanges, false);
    });

    it('leaves nothing to send after switching there and back while offline', async () => {
        const {t, sent, rejoin} = offlineVfs(false, false);
        await t.vfs.setTrackChangesForMe(true);
        await t.vfs.setTrackChangesForMe(false);
        assert.strictEqual(t.vfs.knownTracking, false);
        await rejoin();
        assert.deepStrictEqual(sent, []);
    });

    it('does not switch a reviewer to Editing, offline either', async () => {
        const {t} = offlineVfs(true, true);
        t.vfs.socket.permissionsLevel = 'review';
        await assert.rejects(t.vfs.setTrackChangesForMe(false), /reviewer/);
    });
});

describe('Review view while offline', () => {
    const recall = ReviewCache.recall;
    const pendingSaves = LocalReplicaSCMProvider.pendingSaves;
    afterEach(() => {
        ReviewCache.recall = recall;
        LocalReplicaSCMProvider.pendingSaves = pendingSaves;
    });

    /** Overleaf's state as last seen: "hello world" with Anna's suggestion " big" at 5 */
    function lastSeen() {
        const server = new RangesTracker([], []);
        server.track_changes = true;
        server.setIdSeed(RangesTracker.generateIdSeed());
        server.applyOp({p: 5, i: ' big'}, {user_id: 'anna', ts: new Date()});
        return {docId: 'doc1', content: 'hello big world', changes: server.changes, comments: [], at: 1};
    }
    function offline(knownTracking: boolean) {
        const vfs: any = {isJoined: false, knownTracking, currentUserId: 'me', isTrackingChanges: false};
        const manager = Object.create(ReviewManager.prototype);
        manager.vfsm = {prefetch: async () => vfs};
        return {vfs, manager};
    }
    const remote = fakeUri('overleaf-workshop', '/test/main.tex', 'www.overleaf.com', 'user=u&project=p');
    const local = fakeUri('file', '/c:/me/test/main.tex');

    it('shows the saves kept offline on top of the last seen state, each in its own mode', async () => {
        const {vfs, manager} = offline(true);
        ReviewCache.recall = async () => lastSeen();
        LocalReplicaSCMProvider.pendingSaves = async () => ({start: 'hello big world', entries: [
            {at: 1, tracked: false, ops: [{p: 0, i: 'Oh, '}], exact: true},          // in Editing: no suggestion
            {at: 2, tracked: true, ops: [{p: 19, i: '!'}], exact: true},             // in Reviewing: a suggestion
        ]});
        const review = await manager.offlineReviewDoc(vfs, remote, local);
        assert.strictEqual(review.content, 'Oh, hello big world!');
        assert.ok(review.offline);
        const changes = review.ranges.changes.map((c: any) => [c.op.i, c.op.p, c.metadata.user_id]);
        assert.deepStrictEqual(changes, [[' big', 9, 'anna'], ['!', 19, 'me']], 'Anna\'s moved along; only the Reviewing save is a suggestion');
        assert.strictEqual(review.pending.size, 1);
    });

    it('shows decisions and comments made offline, with the ids Overleaf will give', async () => {
        const {vfs, manager} = offline(true);
        const seen = lastSeen();
        const anna = seen.changes[0].id;
        ReviewCache.recall = async () => seen;
        LocalReplicaSCMProvider.pendingSaves = async () => ({start: 'hello big world', entries: [
            {at: 1, tracked: true, seed: 'abcdefabcdefabcdef', ops: [{p: 15, i: '!'}], exact: true},
            {at: 2, kind: 'accept', ids: [anna], ops: [], exact: true},
            {at: 3, kind: 'comment', ops: [], exact: true, comment: {threadId: 't1', p: 0, c: 'hello', content: 'hm'}},
        ]});
        const review = await manager.offlineReviewDoc(vfs, remote, local);
        assert.deepStrictEqual(review.ranges.changes.map((c: any) => [c.id, c.op.i]), [['abcdefabcdefabcdef000001', '!']],
            'Anna\'s accepted; mine with the id from its seed');
        assert.deepStrictEqual(review.ranges.comments.map((c: any) => [c.op.t, c.op.c]), [['t1', 'hello']]);
        assert.strictEqual(review.localThreads.t1.messages[0].content, 'hm');
    });

    it('shows nothing for a file paused at a conflict, and nothing without a last seen state', async () => {
        const {vfs, manager} = offline(true);
        ReviewCache.recall = async () => lastSeen();
        LocalReplicaSCMProvider.pendingSaves = async () => ({start: 'hello big world', entries: [], paused: {remote: 'x'}});
        assert.strictEqual(await manager.offlineReviewDoc(vfs, remote, local), undefined);
        ReviewCache.recall = async () => undefined;
        assert.strictEqual(await manager.offlineReviewDoc(vfs, remote, local), undefined);
    });

    it('previews unsaved typing in the mode switched to offline, and keeps the old ones in place', async () => {
        for (const reviewing of [true, false]) {
            const {manager} = offline(reviewing);
            ReviewCache.recall = async () => lastSeen();
            const document: any = {uri: remote, isDirty: true, getText: () => 'hello big world, typed'};
            const review = await manager.currentReviewDoc(document);
            const typed = review.ranges.changes.filter((c: any) => c.op.i === ', typed');
            assert.strictEqual(typed.length, reviewing ? 1 : 0, reviewing ? 'Reviewing: a suggestion' : 'Editing: none');
            assert.ok(review.ranges.changes.some((c: any) => c.op.i === ' big' && c.op.p === 5));
        }
    });
});

describe('Line breaks: Overleaf keeps LF only', () => {
    const authenticate = GlobalStateManager.authenticate;
    const ackTimeout = VirtualFileSystem.ownUpdateAckTimeoutMs;
    before(() => {
        GlobalStateManager.authenticate = async () => ({});
        VirtualFileSystem.ownUpdateAckTimeoutMs = 20;
    });
    after(() => {
        GlobalStateManager.authenticate = authenticate;
        VirtualFileSystem.ownUpdateAckTimeoutMs = ackTimeout;
    });

    it('sends a save with Windows line breaks without CRs, so later ops still fit', async () => {
        const t = setup('one\ntwo\n');
        await t.open();
        await t.save('one\r\ntwo, edited\r\n');
        await settle();
        assert.strictEqual(t.server.content, 'one\ntwo, edited\n');
        assert.ok(t.server.emitted.every((u: any) => u.op.every((c: any) => !(c.i ?? '').includes('\r'))));
        await t.save('one, again\r\ntwo, edited\r\n');
        await settle();
        assert.strictEqual(t.server.content, 'one, again\ntwo, edited\n');
    });
});

describe('SocketIOAPI.joinDoc ranges', () => {
    it('decodes the texts in the ranges like the doc lines (UTF-8 packed as latin1)', async () => {
        const packed = (s: string) => Buffer.from(s, 'utf-8').toString('latin1');
        const api = Object.create(SocketIOAPI.prototype);
        api.emit = async () => [[packed('café au lait')], 3, [], {
            changes: [{id: 'c1', op: {p: 0, i: packed('café')}}, {id: 'c2', op: {p: 5, d: packed('naïve ')}}],
            comments: [{id: 't1', op: {p: 5, c: packed('au'), t: 't1'}}],
        }];
        const res = await api.joinDoc('doc1');
        assert.strictEqual(res.docLines[0], 'café au lait');
        assert.strictEqual(res.ranges.changes[0].op.i, 'café');
        assert.strictEqual(res.ranges.changes[1].op.d, 'naïve ');
        assert.strictEqual(res.ranges.comments[0].op.c, 'au');
        assert.strictEqual(res.ranges.changes[1].op.p, 5, 'positions are not encoded');
    });
});
