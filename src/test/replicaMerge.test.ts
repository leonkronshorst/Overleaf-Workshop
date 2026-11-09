/* eslint-disable @typescript-eslint/naming-convention -- file paths as keys */
import * as assert from 'assert';
import { merge3, conflictsWithoutBase, hasConflictMarkers } from '../scm/merge3';
import { ReplicaBase } from '../scm/replicaBase';
import { reconcile, ReplicaSides } from '../scm/replicaReconcile';

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (data?: Uint8Array) => data === undefined ? undefined : new TextDecoder().decode(data);

describe('merge3: merging the local copy with Overleaf by lines', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n';

    it('takes the changes of both sides where they do not touch', () => {
        const m = merge3(base, 'ONE\ntwo\nthree\nfour\nfive\n', 'one\ntwo\nthree\nfour\nFIVE\n');
        assert.deepStrictEqual(m, {text: 'ONE\ntwo\nthree\nfour\nFIVE\n', conflicts: 0});
    });

    it('takes changes on neighbouring lines', () => {
        const m = merge3(base, 'one\nTWO\nthree\nfour\nfive\n', 'one\ntwo\nTHREE\nfour\nfive\n');
        assert.deepStrictEqual(m, {text: 'one\nTWO\nTHREE\nfour\nfive\n', conflicts: 0});
    });

    it('takes the same change made on both sides once', () => {
        const m = merge3(base, 'one\nTWO\nthree\nfour\nfive\n', 'one\nTWO\nthree\nfour\nfive\n');
        assert.deepStrictEqual(m, {text: 'one\nTWO\nthree\nfour\nfive\n', conflicts: 0});
    });

    it('puts different changes to the same lines between conflict markers, local copy first', () => {
        const m = merge3(base, 'one\nmine\nthree\nfour\nfive\n', 'one\ntheirs\nthree\nfour\nfive\n');
        assert.strictEqual(m.conflicts, 1);
        assert.strictEqual(m.text, 'one\n<<<<<<< local copy\nmine\n=======\ntheirs\n>>>>>>> Overleaf\nthree\nfour\nfive\n');
        assert.ok(hasConflictMarkers(m.text));
    });

    it('treats insertions at the same place as a conflict, and keeps the rest merged', () => {
        const m = merge3(base, 'one\nA\ntwo\nthree\nfour\nfive\nend\n', 'one\nB\ntwo\nthree\nfour\nfive\n');
        assert.strictEqual(m.conflicts, 1);
        assert.strictEqual(m.text, 'one\n<<<<<<< local copy\nA\n=======\nB\n>>>>>>> Overleaf\ntwo\nthree\nfour\nfive\nend\n');
    });

    it('copes with a last line without a line break', () => {
        const m = merge3('a\nb', 'a\nb local', 'a\nb remote');
        assert.strictEqual(m.text, 'a\n<<<<<<< local copy\nb local\n=======\nb remote\n>>>>>>> Overleaf\n');
        assert.deepStrictEqual(merge3('a\nb', 'A\nb', 'a\nb'), {text: 'A\nb', conflicts: 0});
    });

    it('without a base, marks every difference as a conflict', () => {
        const m = conflictsWithoutBase('same\nmine\nsame too\n', 'same\ntheirs\nsame too\n');
        assert.strictEqual(m.conflicts, 1);
        assert.strictEqual(m.text, 'same\n<<<<<<< local copy\nmine\n=======\ntheirs\n>>>>>>> Overleaf\nsame too\n');
    });

    it('does not mistake LaTeX for conflict markers', () => {
        assert.ok(!hasConflictMarkers('a\n=======\nb\n% <<<<<<< not at the start\n'));
    });
});

/** A local replica and its Overleaf project, in memory, with a base on "disk". */
function replica(files: {local?: {[p: string]: string}, remote?: {[p: string]: string}} = {}) {
    const local = new Map(Object.entries(files.local ?? {}).map(([p, t]) => [p, enc(t)]));
    const remote = new Map(Object.entries(files.remote ?? {}).map(([p, t]) => [p, enc(t)]));
    const disk = new Map<string, Uint8Array>();
    const io = {
        read: async (p: string) => disk.get(p),
        write: async (p: string, d: Uint8Array) => { disk.set(p, d); },
        remove: async (p: string) => { disk.delete(p); },
    };
    const kept = new Map<string, Uint8Array>();
    const sides: ReplicaSides = {
        remoteFiles: async () => [...remote.keys()],
        localFiles: async () => [...local.keys()],
        readLocal: async (p) => local.get(p),
        writeLocal: async (p, c) => { local.set(p, c); },
        deleteLocal: async (p) => { local.delete(p); },
        readRemote: async (p) => remote.get(p)!,
        writeRemote: async (p, c) => { remote.set(p, c); },
        keepCopy: async (p, c, what) => { kept.set(`${p}.${what}`, c); return `.overleaf/conflicts${p}.${what}`; },
    };
    /** a restart: the base is read again from disk */
    const newBase = () => new ReplicaBase(io);
    return {local, remote, kept, sides, newBase, sync: (base = newBase()) => reconcile(sides, base)};
}

describe('Local replica: syncing after being apart (closed or offline)', () => {
    it('downloads a new project, and remembers what was synced', async () => {
        const r = replica({remote: {'/main.tex': 'hello\n'}});
        await r.sync();
        assert.strictEqual(dec(r.local.get('/main.tex')), 'hello\n');
        const base = r.newBase();
        assert.strictEqual(dec((await base.get('/main.tex'))?.content), 'hello\n');
    });

    it('uploads what was edited offline, also after a restart in between', async () => {
        const r = replica({remote: {'/main.tex': 'a\nb\n'}});
        await r.sync();
        r.local.set('/main.tex', enc('a\nb edited offline\n'));        // VS Code closed, offline
        const report = await r.sync(r.newBase());                       // started again, online
        assert.deepStrictEqual(report.pushed, ['/main.tex']);
        assert.strictEqual(dec(r.remote.get('/main.tex')), 'a\nb edited offline\n');
    });

    it('takes Overleaf\'s changes when nothing changed here', async () => {
        const r = replica({remote: {'/main.tex': 'a\n'}});
        await r.sync();
        r.remote.set('/main.tex', enc('a\nfrom a collaborator\n'));
        const report = await r.sync(r.newBase());
        assert.deepStrictEqual(report.pulled, ['/main.tex']);
        assert.strictEqual(dec(r.local.get('/main.tex')), 'a\nfrom a collaborator\n');
    });

    it('merges changes from both sides that do not overlap, on both sides', async () => {
        const r = replica({remote: {'/main.tex': 'intro\nmethods\nresults\n'}});
        await r.sync();
        r.local.set('/main.tex', enc('intro (offline)\nmethods\nresults\n'));
        r.remote.set('/main.tex', enc('intro\nmethods\nresults (web)\n'));
        const report = await r.sync(r.newBase());
        assert.deepStrictEqual(report.merged, ['/main.tex']);
        assert.strictEqual(dec(r.local.get('/main.tex')), 'intro (offline)\nmethods\nresults (web)\n');
        assert.strictEqual(dec(r.remote.get('/main.tex')), 'intro (offline)\nmethods\nresults (web)\n');
        assert.deepStrictEqual(report.conflicts, []);
    });

    it('never overwrites an overlapping change: markers in the local file, a copy kept, Overleaf untouched', async () => {
        const r = replica({remote: {'/main.tex': 'intro\nmethods\n'}});
        await r.sync();
        r.local.set('/main.tex', enc('intro\nmy methods\n'));
        r.remote.set('/main.tex', enc('intro\ntheir methods\n'));
        const report = await r.sync(r.newBase());
        assert.strictEqual(report.conflicts.length, 1);
        assert.strictEqual(report.conflicts[0].kind, 'text');
        assert.strictEqual(dec(r.local.get('/main.tex')),
            'intro\n<<<<<<< local copy\nmy methods\n=======\ntheir methods\n>>>>>>> Overleaf\n');
        assert.strictEqual(dec(r.remote.get('/main.tex')), 'intro\ntheir methods\n', 'nothing uploaded');
        assert.strictEqual(dec(r.kept.get('/main.tex.local')), 'intro\nmy methods\n', 'the local version kept aside');
        // after another restart it is still a conflict: the markers are not uploaded
        const again = await r.sync(r.newBase());
        assert.deepStrictEqual(again.conflicts.map((c) => [c.relPath, c.earlier]), [['/main.tex', true]]);
        assert.strictEqual(dec(r.remote.get('/main.tex')), 'intro\ntheir methods\n');
    });

    it('keeps both versions of a file that cannot be merged', async () => {
        const r = replica({remote: {'/fig.png': '\x00png1'}});
        await r.sync();
        r.local.set('/fig.png', enc('\x00png-local'));
        r.remote.set('/fig.png', enc('\x00png-web'));
        const report = await r.sync(r.newBase());
        assert.deepStrictEqual(report.conflicts.map((c) => c.kind), ['binary']);
        assert.strictEqual(dec(r.local.get('/fig.png')), '\x00png-local');
        assert.strictEqual(dec(r.kept.get('/fig.png.overleaf')), '\x00png-web');
        assert.strictEqual(dec(r.remote.get('/fig.png')), '\x00png-web');
    });

    it('uploads files created offline, and follows deletions on Overleaf only for unchanged files', async () => {
        const r = replica({remote: {'/main.tex': 'm\n', '/old.tex': 'old\n', '/notes.tex': 'notes\n'}});
        await r.sync();
        r.local.set('/new.tex', enc('written offline\n'));
        r.remote.delete('/old.tex');                                   // deleted on Overleaf ...
        r.remote.delete('/notes.tex');
        r.local.set('/notes.tex', enc('notes, edited offline\n'));      // ... but edited here
        const report = await r.sync(r.newBase());
        assert.deepStrictEqual(report.created, ['/new.tex']);
        assert.strictEqual(dec(r.remote.get('/new.tex')), 'written offline\n');
        assert.deepStrictEqual(report.deleted, ['/old.tex']);
        assert.ok(!r.local.has('/old.tex'));
        assert.ok(r.kept.has('/old.tex.deleted-on-overleaf'), 'a copy is kept');
        assert.deepStrictEqual(report.conflicts.map((c) => [c.relPath, c.kind]), [['/notes.tex', 'deleted']]);
        assert.strictEqual(dec(r.local.get('/notes.tex')), 'notes, edited offline\n');
    });

    it('without a base (first sync), asks instead of guessing when the two differ', async () => {
        const r = replica({local: {'/main.tex': 'mine\n'}, remote: {'/main.tex': 'theirs\n'}});
        const report = await r.sync();
        assert.deepStrictEqual(report.conflicts.map((c) => c.kind), ['text']);
        assert.strictEqual(dec(r.remote.get('/main.tex')), 'theirs\n');
    });

    it('lets a conflict end once it is resolved and synced', async () => {
        const r = replica({remote: {'/main.tex': 'x\n'}});
        await r.sync();
        r.local.set('/main.tex', enc('mine\n'));
        r.remote.set('/main.tex', enc('theirs\n'));
        let base = r.newBase();
        await r.sync(base);
        await base.ready();
        assert.strictEqual(base.conflictOf('/main.tex'), 'text');
        // the user resolves and saves; the push records the new agreement
        r.local.set('/main.tex', enc('both\n'));
        r.remote.set('/main.tex', enc('both\n'));
        await base.set('/main.tex', enc('both\n'));
        base = r.newBase();
        const report = await r.sync(base);
        assert.deepStrictEqual(report.conflicts, []);
        assert.strictEqual(base.conflictOf('/main.tex'), undefined);
    });
});
