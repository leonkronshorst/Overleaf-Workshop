/* eslint-disable @typescript-eslint/naming-convention -- file paths as keys */
import * as assert from 'assert';
import { RefusedError, ReplicaJournal, ReplayContext, StaleRemoteError, TextOp, ThreadQueue, applyOps, diffOps, lfOps, replayFile, replayStep, replayThreads, toLf, transformOps } from '../scm/replicaJournal';
import { hasConflictMarkers, merge3 } from '../scm/merge3';

/** A local file and its Overleaf doc, in memory, with the journal on "disk". */
function setup(text: string, {tracking = false} = {}) {
    const disk = new Map<string, Uint8Array>();
    const io = {
        read: async (p: string) => disk.get(p),
        write: async (p: string, d: Uint8Array) => { disk.set(p, d); },
        remove: async (p: string) => { disk.delete(p); },
    };
    const state = {
        local: text as string | undefined,
        remote: text as string | undefined,
        base: text,
        tracking,
        conflict: undefined as string | undefined,
        /** every update sent to Overleaf, with its mode */
        sent: [] as {ops: TextOp[], tracked: boolean, seed?: string}[],
        /** the ids of the tracked changes Overleaf has; and what was accepted, commented, skipped */
        changeIds: [] as string[],
        accepted: [] as string[],
        messages: [] as string[],
        comments: [] as {p: number, c: string, threadId: string}[],
        skipped: [] as string[],
        kept: [] as string[],
        /** make the next send fail like a lost connection (after applying it, if `applied`) */
        failNext: undefined as undefined | {applied: boolean},
        /** called before each read of Overleaf's text: a collaborator may edit meanwhile */
        beforeRead: undefined as undefined | (() => void),
    };
    const ctx: ReplayContext = {
        readRemote: async () => { state.beforeRead?.(); return state.remote; },
        send: async (_p, expected, ops, tracked, seed) => {
            if (state.remote !== expected) { throw new StaleRemoteError('moved'); }
            const fail = state.failNext;
            state.failNext = undefined;
            if (fail && !fail.applied) { throw new Error('connection lost'); }
            state.remote = applyOps(state.remote!, ops);
            state.sent.push({ops, tracked, ...(seed ? {seed} : {})});
            if (fail) { throw new Error('connection lost after applying'); }
            return state.remote;
        },
        readLocal: async () => state.local,
        writeLocal: async (_p, t) => { state.local = t; },
        keepCopy: async (_p, t, what) => { state.kept.push(t); return `.overleaf/conflicts/main.tex.${what}`; },
        currentTracking: () => state.tracking,
        synced: async (_p, t) => { state.base = t; },
        setConflict: async (_p, remote) => { state.conflict = remote; },
        hasMarkers: hasConflictMarkers,
        log: () => {},
        accept: async (_p, ids) => {
            const missing = ids.filter((id) => !state.changeIds.includes(id));
            state.accepted.push(...ids.filter((id) => state.changeIds.includes(id)));
            return missing;
        },
        postMessage: async (threadId, content) => { state.messages.push(`${threadId}: ${content}`); },
        placeComment: async (_p, expected, p, c, threadId) => {
            if (state.remote !== expected) { throw new StaleRemoteError('moved'); }
            state.comments.push({p, c, threadId});
        },
        skipped: (_p, what, n, detail) => { state.skipped.push(`${what} ${n}${detail ? ' ' + detail : ''}`); },
    };
    const newJournal = () => new ReplicaJournal(io);
    let journal = newJournal();
    /** a save in the editor while not connected; `typed` are the edits as recorded */
    const save = async (to: string, tracked: boolean | undefined, typed?: TextOp[]) => {
        state.local = to;
        await journal.append('/main.tex', state.base, to, tracked, () => typed);
    };
    return {
        state, ctx, save,
        get journal() { return journal; },
        restart: () => { journal = newJournal(); },
        replay: (resolution?: string) => replayFile(journal, ctx, '/main.tex', resolution),
    };
}

describe('Replica journal: saves made while not connected', () => {
    it('applies, diffs and transforms ShareJS text ops', () => {
        assert.strictEqual(applyOps('hello world', [{p: 5, i: ' big'}, {p: 0, d: 'hello'}]), ' big world');
        const ops = diffOps('the cat sat', 'the black cat sat down');
        assert.strictEqual(applyOps('the cat sat', ops), 'the black cat sat down');
        // an insert at 4, moved across a deletion before it and an insertion after it
        const moved = transformOps([{p: 4, i: 'black '}], [{p: 0, d: 'the '}, {p: 3, i: '!'}]);
        assert.strictEqual(applyOps(applyOps('the cat sat', [{p: 0, d: 'the '}, {p: 3, i: '!'}]), moved), 'black cat! sat');
    });

    it('moves edits across changes on other lines, as typed, and stops where they overlap', () => {
        const start = 'one\ntwo\nthree\n';
        const typed: TextOp[] = [{p: 4, d: 'two'}, {p: 4, i: 'TWO'}];
        const target = applyOps(start, typed);
        const sent = replayStep(start, target, typed, 'zero\none\ntwo\nthree, edited\n');
        assert.strictEqual(sent.kind, 'send');
        if (sent.kind === 'send') {
            assert.ok(sent.exact, 'still the edits as typed');
            assert.deepStrictEqual(sent.ops, [{p: 9, d: 'two'}, {p: 9, i: 'TWO'}]);
            assert.strictEqual(applyOps('zero\none\ntwo\nthree, edited\n', sent.ops), 'zero\none\nTWO\nthree, edited\n');
        }
        assert.strictEqual(replayStep(start, target, typed, 'one\ntwo, theirs\nthree\n').kind, 'conflict');
        assert.deepStrictEqual(replayStep(start, target, typed, target), {kind: 'nothing'}, 'already on Overleaf');
    });

    it('always sends ops that lead exactly to the merge (random edits on separate lines)', () => {
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const word = () => ['alpha', 'beta', 'gamma', 'x', '', 'delta epsilon'][Math.floor(rnd() * 6)];
        for (let run = 0; run < 2000; run++) {
            const lines = Array.from({length: 8}, (_, i) => `line ${i} ${word()}`);
            const start = lines.join('\n') + '\n';
            // the local save changes even lines, Overleaf odd ones: never the same line
            const edit = (parity: number) => lines.map((l, i) => i % 2 === parity && rnd() < 0.4 ? (rnd() < 0.2 ? '' : l + ' ' + word()) : l)
                .filter((l, i) => !(i % 2 === parity && rnd() < 0.1)).join('\n') + '\n';
            const target = edit(0);
            const remote = edit(1);
            const typed = diffOps(start, target);
            const step = replayStep(start, target, typed, remote);
            if (step.kind === 'send') {
                assert.strictEqual(applyOps(remote, step.ops), step.result, `run ${run}`);
            } else if (step.kind === 'nothing') {
                assert.strictEqual(merge3(start, target, remote).text, remote, `run ${run}: nothing missing on Overleaf`);
            }
        }
    });

    it('sends the saves in order, each in the mode it was made in, as typed', async () => {
        const t = setup('intro\nmethods\nresults\n', {tracking: true});
        await t.save('intro, fixed\nmethods\nresults\n', false, [{p: 5, i: ', fixed'}]);             // in Editing
        await t.save('intro, fixed\nmethods (new)\nresults\n', true, [{p: 20, i: ' (new)'}]);         // in Reviewing
        await t.save('intro, fixed\nmethods (new)\n', true, [{p: 27, d: 'results\n'}]);
        const outcome = await t.replay();
        assert.deepStrictEqual(outcome, {kind: 'done', sent: 3});
        assert.deepStrictEqual(t.state.sent, [
            {ops: [{p: 5, i: ', fixed'}], tracked: false},
            {ops: [{p: 20, i: ' (new)'}], tracked: true},
            {ops: [{p: 27, d: 'results\n'}], tracked: true},
        ]);
        assert.strictEqual(t.state.remote, 'intro, fixed\nmethods (new)\n');
        assert.strictEqual(t.state.base, t.state.remote);
        assert.deepStrictEqual(await t.journal.files(), [], 'the journal is gone once sent');
    });

    it('keeps the journal across a restart, and uses the edits as typed only where they fit', async () => {
        const t = setup('a\nb\n');
        await t.save('a\nb, typed\n', true, [{p: 3, i: ', typed'}]);
        await t.save('a\nb, typed\nc\n', undefined, [{p: 99, i: 'does not fit'}]);
        t.restart();
        const journal = await t.journal.get('/main.tex');
        assert.deepStrictEqual(journal?.entries.map((e) => [e.tracked, e.exact]), [[true, true], [undefined, false]]);
        // a mode not known when saved: the mode of now
        t.state.tracking = false;
        await t.replay();
        assert.deepStrictEqual(t.state.sent.map((s) => s.tracked), [true, false]);
        assert.strictEqual(t.state.remote, 'a\nb, typed\nc\n');
    });

    it('merges with changes on Overleaf in other places, and gives the local file the result', async () => {
        const t = setup('intro\nmethods\nresults\n');
        await t.save('intro\nmethods, offline\nresults\n', true, [{p: 13, i: ', offline'}]);
        t.state.remote = 'Title\nintro\nmethods\nresults (web)\n';
        const outcome = await t.replay();
        assert.deepStrictEqual(outcome, {kind: 'done', sent: 1});
        assert.deepStrictEqual(t.state.sent, [{ops: [{p: 19, i: ', offline'}], tracked: true}]);
        assert.strictEqual(t.state.remote, 'Title\nintro\nmethods, offline\nresults (web)\n');
        assert.strictEqual(t.state.local, t.state.remote);
    });

    it('pauses at the first save that overlaps, showing that save only; later saves follow the resolution', async () => {
        const t = setup('intro\nmethods\nresults\n');
        await t.save('intro, mine\nmethods\nresults\n', false);                  // 1: fine
        await t.save('intro, mine\nmy methods\nresults\n', true);                // 2: overlaps
        await t.save('intro, mine\nmy methods\nresults, mine\n', true);          // 3: waits
        t.state.remote = 'intro\ntheir methods\nresults\n';
        const paused = await t.replay();
        assert.deepStrictEqual(paused, {kind: 'paused', remaining: 1, markers: 1, copy: '.overleaf/conflicts/main.tex.local'});
        assert.strictEqual(t.state.sent.length, 1, 'save 1 went up');
        assert.strictEqual(t.state.remote, 'intro, mine\ntheir methods\nresults\n');
        assert.strictEqual(t.state.local,
            'intro, mine\n<<<<<<< local copy\nmy methods\n=======\ntheir methods\n>>>>>>> Overleaf\nresults\n',
            'the state up to save 2: save 3 is not in it yet');
        assert.deepStrictEqual(t.state.kept, ['intro, mine\nmy methods\nresults, mine\n'], 'the local version as it was');
        assert.strictEqual(t.state.conflict, t.state.remote);
        // a replay before the user resolves sends nothing
        assert.deepStrictEqual(await t.replay(), {kind: 'paused', remaining: 1, markers: 0, earlier: true});
        assert.strictEqual(t.state.sent.length, 1);

        // the user resolves (both methods) and saves: sent in save 2's mode, then save 3
        t.state.local = 'intro, mine\nmy methods and their methods\nresults\n';
        const done = await t.replay(t.state.local);
        assert.deepStrictEqual(done, {kind: 'done', sent: 2}, 'the resolution and save 3');
        assert.deepStrictEqual(t.state.sent.map((s) => s.tracked), [false, true, true]);
        assert.strictEqual(t.state.remote, 'intro, mine\nmy methods and their methods\nresults, mine\n');
        assert.strictEqual(t.state.local, t.state.remote);
        assert.strictEqual(t.state.conflict, undefined);
    });

    it('stops again when a later save overlaps with the resolution', async () => {
        const t = setup('a\nb\nc\n');
        await t.save('a\nB1\nc\n', true);
        await t.save('a\nB2\nc\n', false);
        t.state.remote = 'a\nb (web)\nc\n';
        assert.strictEqual((await t.replay()).kind, 'paused');
        t.state.local = 'a\nb resolved\nc\n';
        const again = await t.replay(t.state.local);
        assert.deepStrictEqual({kind: again.kind, remaining: (again as any).remaining}, {kind: 'paused', remaining: 0});
        assert.strictEqual(t.state.remote, 'a\nb resolved\nc\n');
        assert.ok(hasConflictMarkers(t.state.local!));
        t.state.local = 'a\nB2 resolved\nc\n';
        assert.deepStrictEqual(await t.replay(t.state.local), {kind: 'done', sent: 1});
        assert.deepStrictEqual(t.state.sent.map((s) => s.tracked), [true, false]);
        assert.strictEqual(t.state.remote, 'a\nB2 resolved\nc\n');
    });

    it('takes a resolution saved before a restart (no markers left) as the resolution', async () => {
        const t = setup('x\n');
        await t.save('mine\n', true);
        t.state.remote = 'theirs\n';
        await t.replay();
        t.state.local = 'both\n';
        t.restart();
        assert.deepStrictEqual(await t.replay(), {kind: 'done', sent: 1});
        assert.deepStrictEqual(t.state.sent, [{ops: diffOps('theirs\n', 'both\n'), tracked: true}]);
    });

    it('sends what another program changed last, in the mode of now', async () => {
        const t = setup('a\n', {tracking: true});
        await t.save('a\nb\n', false);
        t.state.local = 'a\nb\nc by a script\n';
        await t.replay();
        assert.deepStrictEqual(t.state.sent.map((s) => s.tracked), [false, true]);
        assert.strictEqual(t.state.remote, 'a\nb\nc by a script\n');
    });

    it('resumes after the connection drops during the replay, sending nothing twice', async () => {
        const t = setup('a\nb\nc\n');
        await t.save('A\nb\nc\n', false);
        await t.save('A\nB\nc\n', true);
        await t.save('A\nB\nC\n', true);
        t.state.failNext = {applied: false};
        await assert.rejects(t.replay());
        assert.strictEqual(t.state.remote, 'a\nb\nc\n');
        // the second save reaches Overleaf, but its answer is lost
        let n = 0;
        const send = t.ctx.send;
        t.ctx.send = async (...args) => { if (++n === 2) { t.state.failNext = {applied: true}; } return send(...args); };
        await assert.rejects(t.replay());
        t.ctx.send = send;
        assert.strictEqual(t.state.remote, 'A\nB\nc\n');
        t.restart();
        assert.deepStrictEqual(await t.replay(), {kind: 'done', sent: 1});
        assert.strictEqual(t.state.remote, 'A\nB\nC\n');
        assert.deepStrictEqual(t.state.sent.map((s) => s.ops.length > 0), [true, true, true], 'each save once');
    });

    it('retries a step when Overleaf moves between reading and sending', async () => {
        const t = setup('a\nb\n');
        await t.save('a\nb\nmine\n', true);
        let reads = 0;
        const send = t.ctx.send;
        t.ctx.send = async (...args) => {
            if (reads++ === 0) { t.state.remote = 'theirs\na\nb\n'; }   // a collaborator, just then
            return send(...args);
        };
        assert.deepStrictEqual(await t.replay(), {kind: 'done', sent: 1});
        assert.strictEqual(t.state.remote, 'theirs\na\nb\nmine\n');
    });

    it('does not overwrite a save made while the replay ran: it is sent too', async () => {
        const t = setup('a\nb\n');
        await t.save('a\nb\nfirst\n', false);
        const send = t.ctx.send;
        t.ctx.send = async (...args) => {
            const after = await send(...args);
            if (t.state.sent.length === 1) { t.state.local = 'a\nb\nfirst\nsecond\n'; } // saved meanwhile
            return after;
        };
        t.state.remote = 'web\na\nb\n';
        assert.deepStrictEqual(await t.replay(), {kind: 'done', sent: 2});
        assert.strictEqual(t.state.remote, 'web\na\nb\nfirst\nsecond\n', 'neither the save nor the web change lost');
        assert.strictEqual(t.state.local, t.state.remote);
    });

    it('translates edits made on Windows line breaks to the LF text Overleaf has', () => {
        const crlf = 'one\r\ntwo\r\nthree\r\n';
        const ops: TextOp[] = [{p: 5, i: 'TWO '}, {p: 12, d: '\r\nthree'}, {p: 0, i: 'zero\r\n'}];
        const translated = lfOps(crlf, ops)!;
        assert.ok(translated, 'translates');
        assert.strictEqual(applyOps(toLf(crlf), translated), toLf(applyOps(crlf, ops)));
        assert.ok(translated.every((op) => !(op.i ?? op.d ?? '').includes('\r')));
        assert.strictEqual(lfOps(crlf, [{p: 4, i: 'x'}]), undefined, 'an insert between CR and LF does not translate');
    });

    it('keeps decisions in order with the saves: a tracked save with its seed, then accepting it, a reject untracked', async () => {
        const t = setup('one\ntwo\n');
        await t.journal.append('/main.tex', t.state.base, 'one\ntwo\nthree\n', true, () => undefined, 1, false, 'seed-a');
        await t.journal.appendAction('/main.tex', t.state.base, {kind: 'accept', at: 2, ids: ['seed-a000001', 'gone-on-overleaf'], ops: [], exact: true});
        await t.journal.appendAction('/main.tex', t.state.base,
            {kind: 'reject', at: 3, ids: ['x'], ops: [{p: 4, d: 'two\n', u: true}], exact: true, tracked: false});
        t.state.local = 'one\nthree\n';
        t.state.changeIds = ['seed-a000001'];               // what the save made on Overleaf
        t.state.remote = 'zero\none\ntwo\n';               // and a web edit meanwhile, elsewhere
        assert.deepStrictEqual(await t.replay(), {kind: 'done', sent: 2});
        assert.deepStrictEqual(t.state.sent.map((s) => [s.tracked, s.seed]), [[true, 'seed-a'], [false, undefined]]);
        assert.ok(t.state.sent[1].ops.every((op) => op.u), 'the reject stays undo ops when moved');
        assert.deepStrictEqual(t.state.accepted, ['seed-a000001']);
        assert.deepStrictEqual(t.state.skipped, ['accept 1'], 'the one Overleaf no longer has is skipped and told');
        assert.strictEqual(t.state.remote, 'zero\none\nthree\n');
    });

    it('places a comment made offline where its text is now, or skips it if the text changed', async () => {
        const t = setup('see the figure below\n');
        await t.journal.appendAction('/main.tex', t.state.base,
            {kind: 'comment', at: 1, ops: [], exact: true, comment: {threadId: 't1', p: 8, c: 'figure', content: 'which one?'}});
        t.state.remote = 'Please see the figure below\n';
        await t.replay();
        assert.deepStrictEqual(t.state.messages, ['t1: which one?']);
        assert.deepStrictEqual(t.state.comments, [{p: 15, c: 'figure', threadId: 't1'}]);

        const u = setup('see the figure below\n');
        await u.journal.appendAction('/main.tex', u.state.base,
            {kind: 'comment', at: 1, ops: [], exact: true, comment: {threadId: 't2', p: 8, c: 'figure', content: 'which one?'}});
        u.state.remote = 'see the table below\n';
        await u.replay();
        assert.deepStrictEqual(u.state.messages, [], 'no orphan thread posted');
        assert.deepStrictEqual(u.state.skipped, ['comment 1 which one?'], 'skipped, and the text is told');
    });

    it('queues comment thread actions; an unsent reply is edited or dropped in the queue', async () => {
        const disk = new Map<string, Uint8Array>();
        const io = {read: async (p: string) => disk.get(p), write: async (p: string, d: Uint8Array) => { disk.set(p, d); },
                    remove: async (p: string) => { disk.delete(p); }};
        const queue = new ThreadQueue(io);
        await queue.add({kind: 'reply', threadId: 't1', messageId: 'local-1', content: 'first', at: 1});
        await queue.add({kind: 'edit', threadId: 't1', messageId: 'local-1', content: 'first, edited', at: 2});
        await queue.add({kind: 'reply', threadId: 't1', messageId: 'local-2', content: 'oops', at: 3});
        await queue.add({kind: 'deleteMessage', threadId: 't1', messageId: 'local-2', at: 4});
        await queue.add({kind: 'resolve', threadId: 't9', docId: 'd', at: 5});
        await queue.add({kind: 'edit', threadId: 't1', messageId: 'm7', content: 'older message', at: 6});
        const again = new ThreadQueue(io);                  // after a restart
        assert.deepStrictEqual((await again.list()).map((a) => [a.kind, a.content]),
            [['reply', 'first, edited'], ['resolve', undefined], ['edit', 'older message']]);
        const done: string[] = [];
        const ctx = {
            reply: async (t: string, c: string) => { done.push(`reply ${t} ${c}`); },
            edit: async (t: string, m: string, c: string) => { done.push(`edit ${m} ${c}`); },
            deleteMessage: async () => {},
            resolve: async (t: string) => { throw new RefusedError(`404: ${t} not found`); },
            deleteThread: async () => {},
        };
        const result = await replayThreads(again, ctx);
        assert.deepStrictEqual(done, ['reply t1 first, edited', 'edit m7 older message']);
        assert.deepStrictEqual([result.sent, result.skipped.map((a) => a.threadId)], [2, ['t9']]);
        assert.deepStrictEqual(await again.list(), []);
        // a lost connection stops, keeping the rest
        await again.add({kind: 'reply', threadId: 't1', messageId: 'local-3', content: 'later', at: 7});
        await assert.rejects(replayThreads(again, {...ctx, reply: async () => { throw new Error('fetch failed'); }}));
        assert.strictEqual((await again.list()).length, 1);
    });

    it('reports a file deleted on Overleaf, keeping its saves', async () => {
        const t = setup('a\n');
        await t.save('a\nb\n', true);
        t.state.remote = undefined;
        assert.deepStrictEqual(await t.replay(), {kind: 'gone'});
        assert.strictEqual((await t.journal.get('/main.tex'))?.entries.length, 1);
    });
});
