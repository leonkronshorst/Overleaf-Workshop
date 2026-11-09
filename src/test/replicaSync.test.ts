/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import Module = require('module');
import { StaleRemoteError, applyOps } from '../scm/replicaJournal';

// The local replica sync, driven against an in-memory file system for both the local folder
// ("file") and the Overleaf project ("overleaf"), with a fake vfs behind the latter.
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
const files = new Map<string, Uint8Array>();          // "scheme:path" -> content
const messages: {kind: string, text: string, detail?: string}[] = [];
const keyOf = (uri: any) => `${uri.scheme}:${uri.path}`;
const uri = (scheme: string, path: string): any => ({scheme, path, toString: () => `${scheme}://${path}`});
const notFound = () => Object.assign(new Error('not found'), {code: 'FileNotFound'});
const message = (kind: string) => async (text: string, ...rest: any[]) => {
    messages.push({kind, text, detail: typeof rest[0] === 'object' ? rest[0]?.detail : undefined});
    return undefined;
};
const vscodeMock = new Proxy({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    l10n: { t: (text: string, args?: any) => text.replace(/\{(\w+)\}/g, (m, k) => args?.[k] !== undefined ? String(args[k]) : m) },
    FileType: { File: 1, Directory: 2 },
    ProgressLocation: { Notification: 15 },
    Uri: {
        joinPath: (base: any, ...parts: string[]) => uri(base.scheme, [base.path, ...parts].join('/').replace(/\/+/g, '/')),
        parse: (s: string) => uri('file', s),
    },
    workspace: new Proxy({
        fs: {
            readFile: async (u: any) => { const c = files.get(keyOf(u)); if (!c) { throw notFound(); } return c; },
            writeFile: async (u: any, c: Uint8Array) => { files.set(keyOf(u), c); },
            delete: async (u: any) => { files.delete(keyOf(u)); },
            createDirectory: async () => {},
            stat: async (u: any) => { if (!files.has(keyOf(u))) { throw notFound(); } return {type: 1}; },
            readDirectory: async (u: any) => {
                const prefix = keyOf(u).replace(/\/?$/, '/');
                const names = new Map<string, number>();
                for (const k of files.keys()) {
                    if (!k.startsWith(prefix)) { continue; }
                    const [name, ...more] = k.slice(prefix.length).split('/');
                    names.set(name, more.length ? 2 : 1);
                }
                return [...names.entries()];
            },
        },
        textDocuments: [],
    } as any, { get: (t, key) => (key in t ? t[key] : stub()) }),
    window: new Proxy({
        withProgress: async (_o: any, fn: () => any) => fn(),
        showInformationMessage: message('info'),
        showWarningMessage: message('warning'),
        showErrorMessage: message('error'),
        showTextDocument: async () => undefined,
    } as any, { get: (t, key) => (key in t ? t[key] : stub()) }),
} as any, { get: (t, key) => (key in t ? t[key] : stub()) });
const outDir = require('path').resolve(__dirname, '..');
/** Forget the modules other test files loaded with their own 'vscode' mocks (and ours, after). */
const forget = () => Object.keys(require.cache)
    .filter((file) => file.startsWith(outDir) && !file.includes('node_modules') && !file.endsWith('.test.js')
        && !file.endsWith('replicaBase.js') && !file.endsWith('replicaJournal.js') && !file.endsWith('merge3.js'))
    .forEach((file) => { delete require.cache[file]; });
forget();
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { LocalReplicaSCMProvider } = require('../scm/localReplicaSCM');
const { ReviewCache } = require('../review/reviewCache');
const { ReplicaLinks } = require('../core/replicaLinks');
moduleAny._load = originalLoad;
forget();

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (data?: Uint8Array) => data === undefined ? undefined : new TextDecoder().decode(data);
const tick = () => new Promise(resolve => setImmediate(resolve));

let folder = 0;
/** A local replica in /baseN of the project /projN, both holding `docs`, in sync. */
async function replica(docs: {[relPath: string]: string}) {
    const n = ++folder;
    const local = (p: string) => uri('file', `/base${n}${p}`);
    const remote = (p: string) => uri('overleaf', `/proj${n}${p}`);
    for (const [p, text] of Object.entries(docs)) {
        files.set(keyOf(local(p)), enc(text));
        files.set(keyOf(remote(p)), enc(text));
    }
    /** what reached Overleaf through the vfs, with its mode */
    const sent: {relPath: string, ops: any[], tracked: boolean}[] = [];
    const vfs = {
        isJoined: false,
        knownTracking: false as boolean | undefined,
        pathToUri: remote,
        getProjectSCMPersist: () => ({settings: {}}),
        async applyEdits(u: any, expected: string, ops: any[], tracked: boolean) {
            const now = dec(files.get(keyOf(u)))!;
            if (now !== expected) { throw new StaleRemoteError('moved'); }
            const after = applyOps(now, ops);
            files.set(keyOf(u), enc(after));
            sent.push({relPath: u.path.slice(`/proj${n}`.length), ops, tracked});
            return after;
        },
    };
    // the real thing: its base and journal live in the local folder's .overleaf, in memory here
    const scm = new LocalReplicaSCMProvider(vfs, uri('file', `/base${n}`));
    for (const [p, text] of Object.entries(docs)) { await scm.base.set(p, enc(text)); }
    for (const [p, text] of Object.entries(docs)) { scm.setBypassCache(p, enc(text)); }
    return {
        scm, vfs, sent, localUri: local,
        local: (p: string) => dec(files.get(keyOf(local(p)))),
        remote: (p: string) => dec(files.get(keyOf(remote(p)))),
        /** a collaborator edits on Overleaf */
        onOverleaf: (p: string, text: string) => files.set(keyOf(remote(p)), enc(text)),
        /** the user saves `p` in the local copy */
        save: async (p: string, text: string) => {
            files.set(keyOf(local(p)), enc(text));
            await scm.applySync('push', 'update', p, local(p), remote(p));
        },
        /** a change on Overleaf comes in through the vfs watcher */
        pull: (p: string) => scm.applySync('pull', 'update', p, remote(p), local(p)),
        /** VS Code reports the local file (again) */
        push: (p: string) => scm.applySync('push', 'update', p, local(p), remote(p)),
        /** the connection is back: the replica sync starts anew */
        reconnect: async () => { vfs.isJoined = true; await scm.overwrite(); await tick(); },
    };
}

describe('Review state kept for offline use', () => {
    it('keeps it on disk in the replica (.overleaf/review), to show it after a start while offline', async () => {
        const remote = uri('overleaf', '/projX/sub/a.tex');
        const link = ReplicaLinks.link(uri('file', '/baseX'), uri('overleaf', '/projX'));
        const delay = ReviewCache.writeDelayMs;
        ReviewCache.writeDelayMs = 0;
        try {
            ReviewCache.remember(remote, 'doc1', 'text', {changes: [{id: 'c1', op: {p: 0, i: 't'}}], comments: []});
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.ok(files.has('file:/baseX/.overleaf/review/sub/a.tex.json'), [...files.keys()].join(', '));
            (ReviewCache as any).memory.clear();               // as after a restart
            const back = await ReviewCache.recall(remote);
            assert.deepStrictEqual([back.docId, back.content, back.changes[0].id], ['doc1', 'text', 'c1']);
        } finally {
            ReviewCache.writeDelayMs = delay;
            link.dispose();
        }
    });
});

describe('Local replica: saves while not connected, replayed in order', () => {
    beforeEach(() => { messages.length = 0; });

    it('keeps offline saves with their modes and sends each in it once the connection is back', async () => {
        const r = await replica({'/main.tex': 'intro\nmethods\nresults\n'});
        r.vfs.knownTracking = true;                                  // Reviewing
        await r.save('/main.tex', 'intro\nmethods, offline\nresults\n');
        r.vfs.knownTracking = false;                                 // switched to Editing elsewhere
        await r.save('/main.tex', 'intro, fixed\nmethods, offline\nresults\n');
        assert.strictEqual(r.remote('/main.tex'), 'intro\nmethods\nresults\n', 'nothing sent while offline');
        assert.strictEqual(messages.length, 0, `no warning per save while offline: ${JSON.stringify(messages)}`);
        assert.strictEqual(r.scm.status.status, 'pending');

        r.onOverleaf('/main.tex', 'intro\nmethods\nresults (web)\n');
        await r.reconnect();
        assert.deepStrictEqual(r.sent.map((s) => s.tracked), [true, false], 'each in the mode it was saved in');
        assert.strictEqual(r.remote('/main.tex'), 'intro, fixed\nmethods, offline\nresults (web)\n');
        assert.strictEqual(r.local('/main.tex'), r.remote('/main.tex'), 'the local copy has the web change too');
        assert.deepStrictEqual(await r.scm.journal.files(), []);
        assert.strictEqual(r.scm.status.status, 'idle');
        assert.ok(messages.some((m) => m.kind === 'info' && m.text.includes('main.tex')));
    });

    it('pauses only the file in conflict; the others sync; the resolution goes up in its mode, then the later saves', async () => {
        const r = await replica({'/main.tex': 'a\nb\nc\n', '/other.tex': 'x\n'});
        r.vfs.knownTracking = true;
        await r.save('/main.tex', 'a\nb, mine\nc\n');                 // overlaps with the web edit below
        r.vfs.knownTracking = false;
        await r.save('/main.tex', 'a\nb, mine\nc, later\n');          // waits behind it
        await r.save('/other.tex', 'x\ny\n');
        r.onOverleaf('/main.tex', 'a\nb, theirs\nc\n');
        await r.reconnect();

        assert.strictEqual(r.remote('/other.tex'), 'x\ny\n', 'the other file is synced');
        assert.strictEqual(r.remote('/main.tex'), 'a\nb, theirs\nc\n', 'nothing of main.tex sent');
        assert.strictEqual(r.local('/main.tex'), 'a\n<<<<<<< local copy\nb, mine\n=======\nb, theirs\n>>>>>>> Overleaf\nc\n',
            'the state up to the save in conflict');
        assert.deepStrictEqual(r.scm.status, {status: 'need-attention', message: '1 file in conflict'});
        const dialog = messages.find((m) => m.kind === 'error');
        assert.ok(dialog?.detail?.includes('1 later save is applied after you resolve it'), dialog?.detail);
        assert.ok(dialog?.detail?.includes('all other files are synced'), dialog?.detail);

        // a change from Overleaf while in conflict does not overwrite the markers
        r.onOverleaf('/main.tex', 'a\nb, theirs\nc\nd (web)\n');
        await r.pull('/main.tex');
        assert.ok(r.local('/main.tex')!.includes('<<<<<<<'));

        // saved with the markers still in: not uploaded
        await r.save('/main.tex', r.local('/main.tex')!.replace('b, mine', 'b, mine!'));
        assert.strictEqual(r.sent.filter((s) => s.relPath === '/main.tex').length, 0);
        assert.ok(messages.some((m) => m.kind === 'warning' && m.text.includes('still has conflict markers')));

        // resolved and saved: up in Reviewing (the first save's mode), then the later save in Editing
        await r.save('/main.tex', 'a\nb, mine and theirs\nc\n');
        const main = r.sent.filter((s) => s.relPath === '/main.tex');
        assert.deepStrictEqual(main.map((s) => s.tracked), [true, false]);
        assert.strictEqual(r.remote('/main.tex'), 'a\nb, mine and theirs\nc, later\nd (web)\n');
        assert.strictEqual(r.local('/main.tex'), r.remote('/main.tex'));
        assert.strictEqual(r.scm.status.status, 'idle');
        assert.strictEqual(r.scm.base.conflictOf('/main.tex'), undefined);
    });

    it('keeps a save whose upload failed while connected, and sends it as typed later', async () => {
        const r = await replica({'/main.tex': 'one\ntwo\n'});
        r.vfs.isJoined = true;
        r.vfs.knownTracking = true;
        // the upload goes through the vfs as a file write, which fails
        const write = vscodeMock.workspace.fs.writeFile;
        vscodeMock.workspace.fs.writeFile = async (u: any, c: Uint8Array) => {
            if (u.scheme === 'overleaf') { throw new Error("'applyOtUpdate' timed out"); }
            return write(u, c);
        };
        try {
            await r.save('/main.tex', 'one\ntwo\nthree\n');
        } finally {
            vscodeMock.workspace.fs.writeFile = write;
        }
        assert.ok(messages.some((m) => m.kind === 'warning' && m.text.includes('kept and uploaded, in the mode it was made in')));
        assert.strictEqual((await r.scm.journal.get('/main.tex'))?.entries.length, 1);
        r.vfs.knownTracking = false;                                  // the mode changes before it goes up
        await r.reconnect();
        assert.deepStrictEqual(r.sent.map((s) => s.tracked), [true]);
        assert.strictEqual(r.remote('/main.tex'), 'one\ntwo\nthree\n');
    });

    it('does not take Windows line breaks for changes: offline saves of a CRLF copy merge with Overleaf', async () => {
        const r = await replica({'/main.tex': 'one\ntwo\nthree\n'});
        // the local copy has CRLF, as a file written on Windows (the base was taken from it)
        await r.save('/main.tex', 'one\r\ntwo\r\nthree\r\n');
        r.vfs.knownTracking = true;
        await r.save('/main.tex', 'one, offline\r\ntwo\r\nthree\r\n');
        r.onOverleaf('/main.tex', 'one\ntwo, web\nthree\n');
        await r.reconnect();
        assert.strictEqual(r.scm.status.status, 'idle', JSON.stringify(r.scm.status));
        assert.strictEqual(r.remote('/main.tex'), 'one, offline\ntwo, web\nthree\n');
        assert.ok(r.sent.every((s) => s.ops.every((op: any) => !(op.i ?? op.d ?? '').includes('\r'))), 'no CRs sent');
        assert.strictEqual(r.local('/main.tex'), r.remote('/main.tex'));
    });

    it('does not take its own upload of a new file (created empty, then filled) for a change on Overleaf', async () => {
        const r = await replica({'/main.tex': 'x\n'});
        r.vfs.isJoined = true;
        const write = vscodeMock.workspace.fs.writeFile;
        vscodeMock.workspace.fs.writeFile = async (u: any, c: Uint8Array) => {
            if (u.scheme === 'overleaf' && !files.has(keyOf(u))) {
                files.set(keyOf(u), enc(''));        // created empty
                await r.push('/new.tex');            // VS Code reports the new file twice: an echo, over at once
                await r.pull('/new.tex');            // the empty doc announced: the watcher pulls
                files.set(keyOf(u), c);              // then its text, announced too
                await r.pull('/new.tex');
                return;
            }
            return write(u, c);
        };
        try {
            await r.save('/new.tex', 'hello\nworld\n');
        } finally {
            vscodeMock.workspace.fs.writeFile = write;
        }
        await tick();
        assert.strictEqual(r.local('/new.tex'), 'hello\nworld\n', 'no conflict markers');
        assert.strictEqual(r.remote('/new.tex'), 'hello\nworld\n');
        assert.strictEqual(r.scm.base.conflictOf('/new.tex'), undefined);
        assert.ok(!messages.some((m) => m.kind === 'error'), 'no conflict dialog');
    });

    it('still takes a real change from Overleaf that came in during an upload', async () => {
        const r = await replica({'/main.tex': 'a\nb\n'});
        r.vfs.isJoined = true;
        const write = vscodeMock.workspace.fs.writeFile;
        vscodeMock.workspace.fs.writeFile = async (u: any, c: Uint8Array) => {
            await write(u, c);
            if (u.scheme === 'overleaf') {
                files.set(keyOf(u), enc(dec(c) + 'c (web)\n'));   // a collaborator, right after
                await r.pull('/main.tex');
            }
        };
        try {
            await r.save('/main.tex', 'A\nb\n');
        } finally {
            vscodeMock.workspace.fs.writeFile = write;
        }
        for (let i = 0; i < 5; i++) { await tick(); }
        assert.strictEqual(r.local('/main.tex'), 'A\nb\nc (web)\n');
    });

    it('sends decisions, comments and thread actions made offline once the connection is back', async () => {
        const r = await replica({'/main.tex': 'one\ntwo\n'});
        const calls: string[] = [];
        Object.assign(r.vfs, {
            getReviewDoc: async () => ({ranges: {changes: [{id: 'c1'}]}}),      // what Overleaf still has
            acceptChanges: async (_u: any, ids: string[]) => { calls.push(`accept ${ids}`); },
            postThreadMessage: async (t: string, c: string) => { calls.push(`message ${t} ${c}`); },
            placeComment: async (_u: any, _e: string, p: number, c: string, t: string) => { calls.push(`comment ${t} on "${c}"@${p}`); },
            replyToThread: async (t: string, c: string) => { calls.push(`reply ${t} ${c}`); },
            setThreadResolved: async (t: string, resolved: boolean) => { calls.push(`${resolved ? 'resolve' : 'reopen'} ${t}`); },
            forgetThreads: () => { calls.push('threads read again'); },
        });
        const file = r.localUri('/main.tex');
        assert.ok(await LocalReplicaSCMProvider.keepDecision(file, {kind: 'accept', at: 1, ids: ['c1', 'c2'], ops: [], exact: true}));
        assert.ok(await LocalReplicaSCMProvider.keepDecision(file,
            {kind: 'comment', at: 2, ops: [], exact: true, comment: {threadId: 't1', p: 0, c: 'one', content: 'hm'}}));
        const queue = LocalReplicaSCMProvider.threadQueueOf(file)!;
        await queue.add({kind: 'reply', threadId: 't1', messageId: 'local-1', content: 'on second thought', at: 3});
        await queue.add({kind: 'resolve', threadId: 't0', docId: 'doc1', at: 4});
        assert.deepStrictEqual(calls, [], 'nothing sent while offline');

        r.onOverleaf('/main.tex', 'zero\none\ntwo\n');                  // a web edit meanwhile
        await r.reconnect();
        assert.deepStrictEqual(calls, [
            'accept c1',                          // c2 is gone on Overleaf: skipped, and told
            'message t1 hm', 'comment t1 on "one"@5',
            'reply t1 on second thought', 'resolve t0',
            'threads read again',
        ]);
        assert.ok(messages.some((m) => m.kind === 'warning' && m.text.includes('1 suggestion(s) you accepted while offline')),
            JSON.stringify(messages));
        assert.deepStrictEqual(await queue.list(), []);
        assert.deepStrictEqual(await r.scm.journal.files(), []);
    });

    it('uploads as usual while connected and nothing waits', async () => {
        const r = await replica({'/main.tex': 'one\n'});
        r.vfs.isJoined = true;
        await r.save('/main.tex', 'one\ntwo\n');
        assert.strictEqual(r.remote('/main.tex'), 'one\ntwo\n');
        assert.deepStrictEqual(r.sent, [], 'a plain write, not the journal');
        assert.deepStrictEqual(await r.scm.journal.files(), []);
    });
});
