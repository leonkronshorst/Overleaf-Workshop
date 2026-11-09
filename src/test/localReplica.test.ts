/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' export names */
import * as assert from 'assert';
import Module = require('module');

// The module under test imports 'vscode', which only exists inside the extension host.
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
const vscodeMock = new Proxy({
    Disposable: class { dispose() {} },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    l10n: { t: (message: string) => message },
} as any, { get: (t, key) => (key in t ? t[key] : stub()) });
const moduleAny = Module as any;
const originalLoad = moduleAny._load;
moduleAny._load = function (request: string, ...rest: any[]) {
    return request === 'vscode' ? vscodeMock : originalLoad.call(this, request, ...rest);
};
const { LocalReplicaSCMProvider } = require('../scm/localReplicaSCM');
moduleAny._load = originalLoad;
// The other test files load these modules with their own 'vscode' mocks: do not hand them
// the copies built on this one.
const outDir = require('path').resolve(__dirname, '..');
Object.keys(require.cache)
    .filter((file) => file.startsWith(outDir) && !file.includes('node_modules') && !file.endsWith('.test.js'))
    .forEach((file) => { delete require.cache[file]; });

const bytes = (text: string) => new TextEncoder().encode(text);

/** A replica of `basePath` whose syncs are recorded instead of carried out. */
function replica(basePath: string) {
    const scm = Object.create(LocalReplicaSCMProvider.prototype);
    const synced: string[] = [];
    Object.assign(scm, {
        baseUri: { path: basePath },
        bypassCache: new Map(),
        vfs: { pathToUri: (relPath: string) => ({ path: relPath }) },
    });
    scm.applySync = (action: string, type: string, relPath: string) => { synced.push(`${action} ${type} ${relPath}`); };
    return {scm, synced};
}

describe('Local replica sync', () => {
    it('pushes a saved file with the same path key as a pull, from a folder stored with a trailing slash', () => {
        const {scm, synced} = replica('/C:/Users/me/test/');
        scm.onDocumentSaved({ uri: { path: process.platform === 'win32' ? '/c:/Users/me/test/main.tex' : '/C:/Users/me/test/main.tex' } });
        assert.deepStrictEqual(synced, ['push update /main.tex'], 'key "/main.tex", as syncFromVFS and overwrite use');
    });

    it('ignores saves of files outside the replica', () => {
        const {scm, synced} = replica('/C:/Users/me/test/');
        scm.onDocumentSaved({ uri: { path: '/c:/Users/me/test2/main.tex' } });
        scm.onDocumentSaved({ uri: { path: '/c:/Users/me/other/main.tex' } });
        assert.deepStrictEqual(synced, []);
    });

    if (process.platform === 'win32') {
        it('pushes saves although VS Code reports the drive letter in another case than stored (Windows)', () => {
            const {scm, synced} = replica('/C:/Users/me/test/');
            scm.onDocumentSaved({ uri: { path: '/c:/users/ME/test/sub/a.tex' } });
            assert.deepStrictEqual(synced, ['push update /sub/a.tex']);
        });
    }

    it('skips only echoes, and never drops a save after a change came in from Overleaf', () => {
        const {scm} = replica('/base/');
        const push = (text: string) => scm.shouldPropagate('push', '/main.tex', bytes(text));
        const pull = (text: string) => scm.shouldPropagate('pull', '/main.tex', bytes(text));
        scm.setBypassCache('/main.tex', bytes('v0'));      // the first sync: both sides hold v0
        assert.strictEqual(push('v0'), false, 'nothing new');
        assert.strictEqual(push('v1'), true, 'a save');
        assert.strictEqual(pull('v1'), false, 'the save coming back from the vfs');
        assert.strictEqual(pull('v2'), true, 'a change from a collaborator');
        assert.strictEqual(push('v2'), false, 'that change written to the local file');
        // the old check dropped every one of these
        assert.strictEqual(push('v3'), true, 'a save after a pull');
        assert.strictEqual(push('v4'), true, 'and the next save');
        assert.strictEqual(push('v3'), true, 'and a save that undoes it');
    });
});
