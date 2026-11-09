import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ReplicaLinks } from '../core/replicaLinks';
import { log } from '../utils/log';
import { ReplicaBase, hashOf, isText } from './replicaBase';
import { ReconcileReport, ReplicaSides, emptyReport, reconcile, reconcileFile } from './replicaReconcile';
import { hasConflictMarkers } from './merge3';
import { FileJournal, JournalEntry, ReplayContext, ReplayOutcome, ReplicaJournal, ThreadQueue, replayFile, replayThreads, toLf } from './replicaJournal';
import { generateTrackChangesIdSeed } from '../api/socketio';
import { EventBus } from '../utils/eventBus';
import { EditRecorder } from '../core/editRecorder';
import { GlobalStateManager } from '../utils/globalStateManager';

const IGNORE_SETTING_KEY = 'ignore-patterns';

/** One key per replica folder, however its uri is spelled (drive letter case, trailing slash). */
function folderKey(uri: vscode.Uri): string {
    const path = uri.path.replace(/\/$/, '');
    return process.platform==='win32' ? path.toLowerCase() : path;
}

const decode = (content: Uint8Array) => new TextDecoder().decode(content);
const encode = (text: string) => new TextEncoder().encode(text);

type FileCache = {date:number, hash:number};

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    /** per file, the content both sides last agreed on */
    private bypassCache: Map<string, FileCache> = new Map();
    /**
     * Per file, what both sides last agreed on, kept on disk in ".overleaf/base": the base
     * of the merge when both changed while apart. Without it, the first sync after a
     * reconnect or a restart copied the Overleaf version over every local file, losing
     * what had been saved while not connected.
     */
    private readonly base: ReplicaBase;
    /** one base per replica folder, shared by the instances a reconnect creates anew */
    private static readonly bases = new Map<string, ReplicaBase>();
    /**
     * The saves not uploaded yet (made while not connected), in ".overleaf/pending": they
     * are sent in order when the connection is back, each in the mode it was made in.
     */
    private readonly journal: ReplicaJournal;
    private static readonly journals = new Map<string, ReplicaJournal>();
    /** comment thread actions made while not connected, per replica folder */
    private readonly threadQueue: ThreadQueue;
    private static readonly threadQueues = new Map<string, ThreadQueue>();
    /** decisions made offline that could not be carried out, for the next announcement */
    private notes: string[] = [];
    /** per folder and file: one journal operation at a time (saves, replays, resolutions) */
    private static readonly locks = new Map<string, Promise<unknown>>();
    /** folders whose replica sync is running (it takes the saves, not `journalWhileNotConnected`) */
    private static readonly active = new Map<string, number>();
    private replayTimers = new Map<string, NodeJS.Timeout>();
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
        // more of what LaTeX tools write next to the sources (index, glossaries, beamer,
        // nomenclature, minted, ...): local builds must not end up in the Overleaf project
        '**/*.synctex',
        '**/*.dvi',
        '**/*.auxlock',
        '**/*.idx', '**/*.ilg', '**/*.ind',
        '**/*.glo', '**/*.gls', '**/*.glg', '**/*.ist', '**/*.xdy',
        '**/*.acn', '**/*.acr', '**/*.alg',
        '**/*.nlo', '**/*.nls',
        '**/*.nav', '**/*.snm', '**/*.vrb',
        '**/*.loa', '**/*.lol', '**/*.thm',
        '**/*.ptc', '**/*.maf', '**/*.mtc*',
        '**/*.pyg', '**/_minted*', '**/_minted*/**',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
        const key = folderKey(baseUri);
        const io = (folder: string) => {
            const at = (path: string) => vscode.Uri.joinPath(baseUri, '.overleaf', folder, ...path.split('/').filter(Boolean));
            return {
                read: async (path: string) => { try { return await vscode.workspace.fs.readFile(at(path)); } catch { return undefined; } },
                write: async (path: string, data: Uint8Array) => { await vscode.workspace.fs.writeFile(at(path), data); },
                remove: async (path: string) => { await vscode.workspace.fs.delete(at(path)); },
            };
        };
        let base = LocalReplicaSCMProvider.bases.get(key);
        if (!base) {
            base = new ReplicaBase(io('base'));
            LocalReplicaSCMProvider.bases.set(key, base);
        }
        this.base = base;
        let journal = LocalReplicaSCMProvider.journals.get(key);
        if (!journal) {
            journal = new ReplicaJournal(io('pending'));
            LocalReplicaSCMProvider.journals.set(key, journal);
        }
        this.journal = journal;
        let queue = LocalReplicaSCMProvider.threadQueues.get(key);
        if (!queue) {
            queue = new ThreadQueue(io('pending'));
            LocalReplicaSCMProvider.threadQueues.set(key, queue);
        }
        this.threadQueue = queue;
    }

    /** The replica of the local file `localUri`, if its sync is set up: journal, base, thread queue. */
    private static locateLocal(localUri: vscode.Uri) {
        const path = process.platform==='win32' ? localUri.path.toLowerCase() : localUri.path;
        for (const [key, journal] of LocalReplicaSCMProvider.journals) {
            if (!path.startsWith(key + '/')) { continue; }
            return {key, relPath: localUri.path.slice(key.length), journal,
                    base: LocalReplicaSCMProvider.bases.get(key)!, queue: LocalReplicaSCMProvider.threadQueues.get(key)!};
        }
        return undefined;
    }

    /**
     * Keep a review decision or a new comment made offline on the local replica file
     * `localUri` (see JournalEntry), after the saves before it. False if the file has no
     * synced state to build on (it is new here).
     */
    static async keepDecision(localUri: vscode.Uri, entry: JournalEntry): Promise<boolean> {
        const at = LocalReplicaSCMProvider.locateLocal(localUri);
        if (!at) { return false; }
        return LocalReplicaSCMProvider.exclusiveFor(at.key + '|' + at.relPath, async () => {
            await at.journal.ready();
            const synced = await at.base.get(at.relPath);
            if (!at.journal.has(at.relPath) && synced?.content===undefined) { return false; }
            await at.journal.appendAction(at.relPath, toLf(decode(synced?.content ?? new Uint8Array())), entry);
            log('info', `local replica: ${at.relPath}: ${entry.kind} kept for upload`);
            return true;
        });
    }

    /** The comment thread actions kept while offline for the replica of `localUri`. */
    static threadQueueOf(localUri: vscode.Uri): ThreadQueue | undefined {
        return LocalReplicaSCMProvider.locateLocal(localUri)?.queue;
    }

    /**
     * Until the replica sync starts (it needs the project joined), keep the saves made in
     * the replica folder `baseUri` in its journal: VS Code may have been started offline.
     */
    static journalWhileNotConnected(context: vscode.ExtensionContext, vfs: VirtualFileSystem, folder: vscode.Uri): vscode.Disposable {
        const key = folderKey(folder);
        const persists = GlobalStateManager.getServerProjectSCMPersists(context, vfs.serverName, vfs.projectId);
        const persist = Object.values(persists).find((p: any) => p.label===LocalReplicaSCMProvider.label
            && (p.enabled ?? true) && folderKey(vscode.Uri.parse(p.baseUri))===key) as any;
        if (!persist) { return {dispose: () => {}}; }
        const scm = new LocalReplicaSCMProvider(vfs, vscode.Uri.parse(persist.baseUri));
        return vscode.Disposable.from(
            // its files are the project's docs from the start: edits recorded as typed, and
            // the tracked changes shown (offline: as last seen, with the kept saves on top)
            ReplicaLinks.link(scm.baseUri, vfs.origin),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (LocalReplicaSCMProvider.active.get(key)) { return; } // the replica sync takes it
                scm.onDocumentSaved(doc);
            }),
        );
    }

    /**
     * The saves of the local replica file `localUri` that wait for upload (with the text
     * they start from), if any: the offline review view shows them as Overleaf will have them.
     */
    static async pendingSaves(localUri: vscode.Uri): Promise<FileJournal | undefined> {
        const path = process.platform==='win32' ? localUri.path.toLowerCase() : localUri.path;
        for (const [key, journal] of LocalReplicaSCMProvider.journals) {
            if (!path.startsWith(key + '/')) { continue; }
            await journal.ready();
            const relPath = localUri.path.slice(key.length);
            return journal.has(relPath) ? journal.get(relPath) : undefined;
        }
        return undefined;
    }

    /** Count this folder's sync as running until disposed. */
    private markActive(): vscode.Disposable {
        const key = folderKey(this.baseUri);
        const {active} = LocalReplicaSCMProvider;
        active.set(key, (active.get(key) ?? 0) + 1);
        let disposed = false;
        return {dispose: () => {
            if (disposed) { return; }
            disposed = true;
            active.set(key, (active.get(key) ?? 1) - 1);
            this.replayTimers.forEach((timer) => clearTimeout(timer));
            this.replayTimers.clear();
        }};
    }

    /** Run `fn` for `relPath` once the journal operations before it are done. */
    private exclusive<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
        return LocalReplicaSCMProvider.exclusiveFor(folderKey(this.baseUri) + '|' + relPath, fn);
    }

    private static exclusiveFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const before = LocalReplicaSCMProvider.locks.get(key) ?? Promise.resolve();
        const run = before.catch(() => {}).then(fn);
        LocalReplicaSCMProvider.locks.set(key, run);
        run.finally(() => { if (LocalReplicaSCMProvider.locks.get(key)===run) { LocalReplicaSCMProvider.locks.delete(key); } }).catch(() => {});
        return run;
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    /** Remember `content` as what both sides of `relPath` now hold. */
    private setBypassCache(relPath: string, content?: Uint8Array) {
        this.bypassCache.set(relPath, {date: Date.now(), hash: hashCode(content)});
    }

    /**
     * Whether a change should be synced to the other side: unless it carries exactly what
     * both sides last agreed on, as an echo does (a pull's write to the local file, or a
     * push coming back from the vfs).
     *
     * This used to keep the last push and the last pull apart, and while they differed
     * (after any pull) let a push through only within 500 ms of the previous push: every
     * ordinary save after a change had come in from Overleaf was dropped without a word.
     */
    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        if (this.bypassCache.get(relPath)?.hash===hashCode(content)) { return false; }
        this.setBypassCache(relPath, content);
        return true;
    }

    /** The files of one side, as "/sub/file.tex", without ignored ones. */
    private async listFiles(toUri: (relPath: string) => vscode.Uri): Promise<string[]> {
        const files: string[] = [];
        const queue = ['/'];
        while (queue.length!==0) {
            const dir = queue.shift()!;
            let items: [string, vscode.FileType][] = [];
            try {
                items = await vscode.workspace.fs.readDirectory(toUri(dir));
            } catch {
                continue;
            }
            for (const [name, type] of items) {
                const relPath = dir + name;
                if (this.matchIgnorePatterns(relPath)) { continue; }
                if (type & vscode.FileType.Directory) { queue.push(relPath + '/'); } else { files.push(relPath); }
            }
        }
        return files;
    }

    /** The local copy and the Overleaf project, for `reconcile` and resolving conflicts. */
    private get sides(): ReplicaSides {
        const localUri = (relPath: string) => vscode.Uri.joinPath(this.baseUri, relPath);
        return {
            remoteFiles: () => this.listFiles((p) => this.vfs.pathToUri(p)),
            localFiles: () => this.listFiles(localUri),
            readLocal: async (p) => await this.readFile(p),
            writeLocal: async (p, content) => {
                this.setBypassCache(p, content);
                await this.writeFile(p, content);
            },
            deleteLocal: async (p) => {
                this.setBypassCache(p, undefined);
                await vscode.workspace.fs.delete(localUri(p));
            },
            readRemote: async (p) => await vscode.workspace.fs.readFile(this.vfs.pathToUri(p)),
            writeRemote: async (p, content) => {
                this.setBypassCache(p, content);
                const folder = p.split('/').slice(0, -1).join('/');
                if (folder) {
                    try { await vscode.workspace.fs.createDirectory(this.vfs.pathToUri(folder)); } catch { /* there already */ }
                }
                await vscode.workspace.fs.writeFile(this.vfs.pathToUri(p), content);
            },
            keepCopy: async (p, content, what) => {
                // local time, as the user's clock shows it: 2026-11-06_15-01-21
                const d = new Date();
                const two = (n: number) => String(n).padStart(2, '0');
                const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
                const copy = `/.overleaf/conflicts${p}.${stamp}.${what}`;
                await this.writeFile(copy, content);
                return copy.slice(1);
            },
            agreed: (p, content) => this.setBypassCache(p, content),
        };
    }

    /** The two sides as a replay of the journal sees them: texts, and edits sent in a mode. */
    private get replayContext(): ReplayContext {
        const sides = this.sides;
        return {
            readRemote: async (p) => {
                try {
                    return decode(await sides.readRemote(p));
                } catch (err: any) {
                    if (err?.code==='FileNotFound' || err?.name?.includes?.('FileNotFound')) { return undefined; }
                    throw err;
                }
            },
            send: async (p, expected, ops, tracked, seed) => {
                const after = await this.vfs.applyEdits(this.vfs.pathToUri(p), expected, ops, tracked, seed);
                this.setBypassCache(p, encode(after)); // its echo from the vfs is no news
                return after;
            },
            // LF, as Overleaf keeps it: a copy with Windows line breaks differed on every line
            readLocal: async (p) => { const c = await sides.readLocal(p); return c===undefined ? undefined : toLf(decode(c)); },
            writeLocal: async (p, text) => sides.writeLocal(p, encode(text)),
            keepCopy: async (p, text, what) => sides.keepCopy(p, encode(text), what),
            currentTracking: () => this.vfs.knownTracking ?? false,
            synced: async (p, text) => {
                this.setBypassCache(p, encode(text));
                await this.base.set(p, encode(text));
            },
            setConflict: async (p, remote) => {
                await this.base.setConflict(p, remote===undefined ? undefined : 'text', remote===undefined ? undefined : encode(remote));
            },
            hasMarkers: hasConflictMarkers,
            log: (message) => log('info', `local replica: ${message}`),
            accept: async (p, ids) => {
                const uri = this.vfs.pathToUri(p);
                const review = await this.vfs.getReviewDoc(uri);
                const there = new Set(review?.ranges.changes.map((c) => c.id) ?? []);
                const present = ids.filter((id) => there.has(id));
                if (present.length > 0) { await this.vfs.acceptChanges(uri, present); }
                return ids.filter((id) => !there.has(id));
            },
            postMessage: (threadId, content) => this.vfs.postThreadMessage(threadId, content),
            placeComment: (p, expected, offset, c, threadId) => this.vfs.placeComment(this.vfs.pathToUri(p), expected, offset, c, threadId),
            skipped: (p, what, n, detail) => {
                const name = p.replace(/^\//, '');
                this.notes.push(what==='accept'
                    ? vscode.l10n.t('{name}: {n} suggestion(s) you accepted while offline had changed on Overleaf meanwhile (accepted, rejected or edited by someone else), and were left as they are.', {name, n})
                    : vscode.l10n.t('{name}: a comment you made while offline could not be placed: its text was changed on Overleaf meanwhile. Your comment was: "{text}"', {name, text: detail ?? ''}));
            },
        };
    }

    /** Send the comment thread actions kept while offline (after the saves, which may create threads). */
    private async replayThreadQueue(report: ReconcileReport) {
        if ((await this.threadQueue.list()).length===0) { return; }
        const logSent = (what: string) => log('info', `local replica: sent the ${what}, made while offline`);
        try {
            const {sent, skipped} = await replayThreads(this.threadQueue, {
                reply: async (t, c) => { await this.vfs.replyToThread(t, c); logSent(`reply to thread ${t}: "${c.slice(0, 40)}"`); },
                edit: async (t, m, c) => { await this.vfs.editThreadMessage(t, m, c); logSent(`edit of message ${m} in thread ${t}`); },
                deleteMessage: async (t, m) => { await this.vfs.deleteOwnThreadMessage(t, m); logSent(`deletion of message ${m} in thread ${t}`); },
                resolve: async (t, r, d) => { await this.vfs.setThreadResolved(t, r, d); logSent(`${r ? 'resolve' : 'reopen'} of thread ${t}`); },
                deleteThread: async (t, d) => { await this.vfs.deleteThread(t, d); logSent(`deletion of thread ${t}`); },
            });
            log('info', `local replica: sent ${sent} comment action(s) made while offline${skipped.length ? `, skipped ${skipped.length}` : ''}`);
            if (skipped.length > 0) {
                report.notes.push(vscode.l10n.t('{n} comment action(s) made while offline could not be sent: their thread or message is gone on Overleaf.', {n: skipped.length}));
            }
        } catch (err: any) {
            log('warn', `local replica: comment actions made while offline not sent yet: ${err?.message ?? err}`);
        }
        this.vfs.forgetThreads();
    }

    /**
     * A save of `relPath` while not connected, or while earlier saves of it still wait: kept
     * in the journal with the mode of now, to be sent in order. While the file is paused
     * at a conflict, a save without markers is the resolution. Returns false for a save that
     * is uploaded as usual.
     */
    private async journalPush(relPath: string, content: Uint8Array, agreed?: FileCache, uploadFailed = false): Promise<boolean> {
        await this.journal.ready();
        const pending = this.journal.has(relPath);
        if (!pending && this.vfs.isJoined && !uploadFailed) { return false; }
        if (!isText(content)) { return false; }
        const entry = await this.base.get(relPath);
        // a file new here, or not a text: the next start-up sync takes it as a whole
        if (!pending && entry?.content===undefined) { return false; }
        // not synced (yet): the other side still holds what was agreed before
        if (agreed) { this.bypassCache.set(relPath, agreed); } else { this.bypassCache.delete(relPath); }
        let kept = true;
        await this.exclusive(relPath, async () => {
            const journal = await this.journal.get(relPath);
            const text = toLf(decode(content));
            const name = relPath.replace(/^\//, '');
            // A replay that ran meanwhile has taken this save (and given the file Overleaf's
            // text), or a newer save follows: this one is outdated. Taken from the base, it
            // would undo what others changed.
            const now = await this.readFile(relPath);
            if (now===undefined || hashOf(now)!==hashOf(content)) {
                log('info', `local replica: ${relPath}: changed again before this save was kept: skipped`);
                return;
            }
            if (journal?.paused) {
                if (hasConflictMarkers(text)) {
                    log('warn', `local replica: ${relPath} still has conflict markers: not uploaded`);
                    vscode.window.showWarningMessage(vscode.l10n.t('{name} still has conflict markers (<<<<<<< / >>>>>>>), so it is not uploaded. Resolve them and save again.', {name}));
                } else if (!this.vfs.isJoined) {
                    log('info', `local replica: ${relPath}: conflict resolved while not connected: uploaded when the connection is back`);
                } else {
                    await this.runReplay(relPath, text);
                }
                return;
            }
            const start = journal?.start ?? toLf(decode(entry!.content!));
            const tracked = this.vfs.knownTracking;
            const remote = this.vfs.pathToUri(relPath);
            // Overleaf builds the ids of the suggestions from this seed: the same ids offline
            const after = await this.journal.append(relPath, start, text, tracked,
                (from, to) => EditRecorder.opsFor(remote, from, to), Date.now(), false,
                tracked ? generateTrackChangesIdSeed() : undefined);
            if (after.entries.length===(journal?.entries.length ?? 0)) {
                // the same text as what is kept already (or synced): nothing to add
                kept = false;
                return;
            }
            const last = after.entries[after.entries.length - 1];
            log('info', `local replica: ${relPath}: save kept for upload (${after.entries.length} pending, ` +
                        `${tracked===undefined ? 'mode not known' : tracked ? 'Reviewing' : 'Editing'}, ` +
                        `${last?.exact ? 'as typed' : 'from a diff'})`);
            if (this.vfs.isJoined) { this.scheduleReplay(relPath); }
            // the review view shows the kept saves as they will be on Overleaf: redraw
            EventBus.fire('reviewChangedEvent', {origin: this.vfs.origin});
        });
        await this.updateAttention();
        return kept || !uploadFailed;
    }

    /** Replay `relPath`'s journal soon (a save went into it while connected). */
    private scheduleReplay(relPath: string, delayMs = 2000) {
        if (this.replayTimers.has(relPath)) { return; }
        this.replayTimers.set(relPath, setTimeout(() => {
            this.replayTimers.delete(relPath);
            this.exclusive(relPath, () => this.runReplay(relPath)).catch(() => {});
        }, delayMs));
    }

    /** Replay `relPath`'s journal now (inside `exclusive`) and tell about the outcome. */
    private async runReplay(relPath: string, resolution?: string) {
        const report = emptyReport();
        await this.replayInto(relPath, report, resolution);
        await this.updateAttention();
        // not awaited: a modal question must not hold up the next save of the file
        this.announce(report).catch((err) => log("warn", `local replica: ${err?.message ?? err}`));
    }

    /** Replay `relPath`'s journal (inside `exclusive`), adding the outcome to `report`. */
    private async replayInto(relPath: string, report: ReconcileReport, resolution?: string) {
        let outcome: ReplayOutcome;
        try {
            outcome = await replayFile(this.journal, this.replayContext, relPath, resolution);
        } catch (err: any) {
            log('warn', `local replica: pending saves of ${relPath} not uploaded yet: ${err?.message ?? err}`);
            report.waiting.push(relPath);
            return;
        }
        switch (outcome.kind) {
            case 'done':
                if (outcome.sent > 0 || resolution!==undefined) { report.replayed.push(relPath); }
                break;
            case 'paused':
                report.conflicts.push({relPath, kind: 'text', copy: outcome.copy, markers: outcome.markers,
                    remaining: outcome.remaining, earlier: outcome.earlier});
                break;
            case 'gone':
                await this.base.setConflict(relPath, 'deleted');
                report.conflicts.push({relPath, kind: 'deleted'});
                break;
        }
    }

    /** The status bar: files in conflict, and saves waiting for the connection. */
    private async updateAttention() {
        if (this.status.status==='push' || this.status.status==='pull') { return; } // shown when done
        const conflicts = (await this.base.conflicts()).length;
        const pending = (await this.journal.files()).length - (await this.pausedFiles()).length;
        if (conflicts > 0) {
            this.status = {status: 'need-attention', message: conflicts===1
                ? vscode.l10n.t('1 file in conflict')
                : vscode.l10n.t('{n} files in conflict', {n: conflicts})};
        } else if (pending > 0) {
            this.status = {status: 'pending', message: pending===1
                ? vscode.l10n.t('1 file with saves not uploaded yet')
                : vscode.l10n.t('{n} files with saves not uploaded yet', {n: pending})};
        } else if (this.status.status!=='idle') {
            this.status = {status: 'idle', message: ''};
        }
    }

    private async pausedFiles(): Promise<string[]> {
        const paused: string[] = [];
        for (const f of await this.journal.files()) {
            if ((await this.journal.get(f))?.paused) { paused.push(f); }
        }
        return paused;
    }

    /** The status bar item was clicked while files are in conflict: show the dialog again. */
    async showConflicts() {
        const report = emptyReport();
        for (const {relPath, kind} of await this.base.conflicts()) {
            const journal = await this.journal.get(relPath);
            report.conflicts.push({relPath, kind, earlier: true, remaining: journal?.paused ? journal.entries.length - 1 : undefined});
        }
        if (report.conflicts.length===0) {
            vscode.window.showInformationMessage(vscode.l10n.t('No conflicts: the local copy is in sync with Overleaf.'));
            return;
        }
        await this.announce(report);
    }

    /**
     * The first sync after connecting (VS Code started, or the connection is back): bring
     * together what changed on either side meanwhile (see `reconcile`), and tell about it.
     */
    private async overwrite(): Promise<boolean|undefined> {
        await this.base.ready();
        await this.journal.ready();
        const report = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
        }, async () => {
            const report = emptyReport();
            // Files with saves made while not connected: those are sent save by save, each
            // in its own mode; one that overlaps with Overleaf's changes pauses only its file.
            const pending = new Set(await this.journal.files());
            // replayed right here: no need for the replays planned after failed uploads
            this.replayTimers.forEach((timer) => clearTimeout(timer));
            this.replayTimers.clear();
            for (const relPath of pending) {
                await this.exclusive(relPath, () => this.replayInto(relPath, report));
            }
            await reconcile(this.sides, this.base, pending, report);
            await this.replayThreadQueue(report);
            return report;
        });
        await this.updateAttention();
        // not awaited: a modal question must not hold up the sync from starting
        this.announce(report).catch((err) => log('warn', `local replica: ${err?.message ?? err}`));
        return true;
    }

    private async announce(report: ReconcileReport) {
        const list = (files: string[]) => files.map((f) => f.replace(/^\//, '')).join(', ');
        if (report.pulled.length) { log('info', `local replica: taken from Overleaf: ${list(report.pulled)}`); }
        if (report.pushed.length) { log('info', `local replica: uploaded local changes: ${list(report.pushed)}`); }
        if (report.merged.length) { log('info', `local replica: merged changes from both sides: ${list(report.merged)}`); }
        if (report.created.length) { log('info', `local replica: uploaded new local files: ${list(report.created)}`); }
        if (report.deleted.length) { log('info', `local replica: deleted here as on Overleaf (copies in .overleaf/conflicts): ${list(report.deleted)}`); }
        if (report.replayed.length) { log('info', `local replica: uploaded saves made while not connected, in order: ${list(report.replayed)}`); }
        if (report.waiting.length) { log('warn', `local replica: saves still waiting for the connection: ${list(report.waiting)}`); }
        report.notes.push(...this.notes.splice(0));
        if (report.notes.length) {
            report.notes.forEach((note) => log('warn', `local replica: ${note}`));
            vscode.window.showWarningMessage(report.notes.join(' '));
        }
        for (const c of report.conflicts) {
            log('warn', `local replica: conflict (${c.kind}${c.earlier ? ', from before' : ''}) in ${c.relPath}${c.copy ? `, kept aside: ${c.copy}` : ''}` +
                        `${c.remaining!==undefined ? `, ${c.remaining} later saves wait` : ''}`);
        }
        const offline = [...report.pushed, ...report.merged, ...report.created, ...report.replayed];
        if (report.conflicts.length===0) {
            if (offline.length) {
                vscode.window.showInformationMessage(vscode.l10n.t('Synced changes of the local copy that Overleaf did not have yet: {files}',
                    {files: list(offline)}));
            }
            return;
        }
        /** for a pending save in conflict: what happens to the saves after it */
        const later = (c: ReconcileReport['conflicts'][number]) => c.remaining===undefined ? ''
            : c.remaining===0 ? ' ' + vscode.l10n.t('It was your last save of the file made while not connected; once resolved, it is uploaded in the mode it was made in.')
            : c.remaining===1 ? ' ' + vscode.l10n.t('The file shows the state up to that save: 1 later save is applied after you resolve it, so it is not lost.')
            : ' ' + vscode.l10n.t('The file shows the state up to that save: {n} later saves are applied after you resolve it, so they are not lost.', {n: c.remaining});
        const detail = report.conflicts.map((c) => {
            const name = c.relPath.replace(/^\//, '');
            switch (c.kind) {
                case 'text': return (c.earlier
                    ? vscode.l10n.t('{name}: still has conflict markers from before.', {name})
                    : c.remaining!==undefined
                        ? vscode.l10n.t('{name}: a save made while not connected overlaps with changes on Overleaf. Both are in the file between conflict markers, in {n} place(s). Your version as it was is kept in {copy}.',
                            {name, n: c.markers ?? 1, copy: c.copy ?? ''})
                    : (c.markers ?? 1)===1
                        ? vscode.l10n.t('{name}: both versions are in the file between conflict markers, in one place. Your version as it was is kept in {copy}.',
                            {name, copy: c.copy ?? ''})
                        : vscode.l10n.t('{name}: both versions are in the file between conflict markers, in {n} places. Your version as it was is kept in {copy}.',
                            {name, n: c.markers ?? 1, copy: c.copy ?? ''})) + later(c);
                case 'binary': return c.earlier
                    ? vscode.l10n.t('{name}: changed on both sides, still undecided.', {name})
                    : vscode.l10n.t('{name}: changed on both sides and cannot be merged. The local file stays; Overleaf\'s version is kept in {copy}.',
                        {name, copy: c.copy ?? ''});
                case 'deleted': return vscode.l10n.t('{name}: deleted on Overleaf, but changed here.', {name});
            }
        }).join('\n') + '\n\n' + vscode.l10n.t('Only the file(s) in conflict wait: all other files are synced as usual. Until then, Overleaf has the last synced version of them, so a compile on Overleaf may show "??" for what they define.');
        const resolve = vscode.l10n.t('Resolve');
        const choice = await vscode.window.showErrorMessage(
            report.conflicts.length===1
                ? vscode.l10n.t('Conflict between the local copy and Overleaf: {name} was changed on both sides, and the changes could not be merged. It is not synced until you resolve it.',
                    {name: report.conflicts[0].relPath.replace(/^\//, '')})
                : vscode.l10n.t('Conflicts between the local copy and Overleaf: {n} files were changed on both sides, and the changes could not be merged. They are not synced until you resolve them.',
                    {n: report.conflicts.length}),
            {modal: true, detail}, resolve);
        if (choice===resolve) {
            for (const c of report.conflicts) { await this.resolveConflict(c.relPath, c.kind); }
        }
    }

    /** Lead the user through resolving the conflict of `relPath`. */
    private async resolveConflict(relPath: string, kind: string) {
        const name = relPath.replace(/^\//, '');
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        if (kind==='text') {
            await vscode.window.showTextDocument(localUri, {preview: false});
            const journal = await this.journal.get(relPath);
            const mode = journal?.paused ? journal.entries[0]?.tracked : undefined;
            vscode.window.showWarningMessage(!journal?.paused
                ? vscode.l10n.t('Resolve the conflict markers in {name} ("Current" is the local copy, "Incoming" is Overleaf\'s version), then save: that uploads it.', {name})
                : mode===undefined
                    ? vscode.l10n.t('Resolve the conflict markers in {name} ("Current" is your save made while not connected, "Incoming" is Overleaf\'s version), then save: that uploads it, and your later saves follow.', {name})
                    : vscode.l10n.t('Resolve the conflict markers in {name} ("Current" is your save made while not connected, "Incoming" is Overleaf\'s version), then save: that uploads it in {mode} mode, as it was made, and your later saves follow.',
                        {name, mode: mode ? vscode.l10n.t('Reviewing') : vscode.l10n.t('Editing')}));
            return;
        }
        const [keep, other] = kind==='binary'
            ? [vscode.l10n.t('Keep the local version'), vscode.l10n.t('Take Overleaf\'s version')]
            : [vscode.l10n.t('Upload it again'), vscode.l10n.t('Delete it here')];
        const choice = await vscode.window.showWarningMessage(
            kind==='binary'
                ? vscode.l10n.t('{name} was changed both here and on Overleaf. Which version do you keep?', {name})
                : vscode.l10n.t('{name} was deleted on Overleaf, but changed here. Keep it?', {name}),
            {modal: true}, keep, other);
        if (!choice) { return; }   // stays a conflict; asked again at the next start
        const sides = this.sides;
        try {
            if (choice===keep) {
                const local = await sides.readLocal(relPath);
                if (!local) { return; }
                await sides.writeRemote(relPath, local);
                await this.base.set(relPath, local);
            } else if (kind==='binary') {
                const remote = await sides.readRemote(relPath);
                await sides.writeLocal(relPath, remote);
                await this.base.set(relPath, remote);
            } else {
                const local = await sides.readLocal(relPath);
                if (local) { await sides.keepCopy(relPath, local, 'deleted-on-overleaf'); }
                await sides.deleteLocal(relPath);
                await this.base.remove(relPath);
            }
            // decided as a whole: pending saves of it are settled too
            await this.journal.set(relPath, undefined);
            log('info', `local replica: conflict in ${relPath} resolved (${choice})`);
            await this.updateAttention();
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not resolve the conflict in {name}: {error}', {name, error: err?.message ?? String(err)}));
        }
    }

    /**
     * Whether a sync of `relPath` may go ahead while it has a conflict: nothing comes in
     * from Overleaf, and the local file goes out only once its markers are resolved.
     */
    private async conflictAllows(action: 'push'|'pull', relPath: string, content: Uint8Array): Promise<boolean> {
        const kind = this.base.conflictOf(relPath);
        if (!kind) { return true; }
        const name = relPath.replace(/^\//, '');
        if (action==='pull') {
            log('info', `local replica: ${relPath} has a conflict: not updated from Overleaf until it is resolved`);
            return false;
        }
        if (kind==='text' && hasConflictMarkers(new TextDecoder().decode(content))) {
            log('warn', `local replica: ${relPath} still has conflict markers: not uploaded`);
            vscode.window.showWarningMessage(vscode.l10n.t('{name} still has conflict markers (<<<<<<< / >>>>>>>), so it is not uploaded. Resolve them and save again.', {name}));
            return false;
        }
        // saved without markers (or a file that cannot be merged, saved again): that is the resolution
        log('info', `local replica: conflict in ${relPath} resolved by saving it`);
        vscode.window.showInformationMessage(vscode.l10n.t('Conflict in {name} resolved: uploading it.', {name}));
        await this.base.setConflict(relPath, undefined);
        return true;
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    /**
     * Files being uploaded now (counted, by folder and path, whichever instance uploads), and
     * those a change from Overleaf came in for meanwhile.
     */
    private static readonly pushing = new Map<string, number>();
    private static readonly pullAfterPush = new Set<string>();

    /**
     * Sync one file. A change coming in from Overleaf while our own upload of the file runs
     * is held until the upload is done: mostly it is that upload's own echo, and on its way
     * (a new file is created empty first, a save may arrive in steps) the file is neither
     * the old nor the new text. Taken for a change, it was "merged" into conflict markers.
     */
    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        const {pushing, pullAfterPush} = LocalReplicaSCMProvider;
        const key = folderKey(this.baseUri) + '|' + relPath;
        const ours = type==='update' && !this.matchIgnorePatterns(relPath);
        if (action==='pull' && ours && pushing.get(key)) {
            log('info', `local replica: ${relPath} changed on Overleaf while our upload of it runs: taken once it is done`);
            pullAfterPush.add(key);
            return;
        }
        // Counted: VS Code may report one new file twice, and the quick second upload (an
        // echo, skipped) used to clear the mark while the first was still creating the file.
        const guarded = action==='push' && ours;
        if (guarded) { pushing.set(key, (pushing.get(key) ?? 0) + 1); }
        try {
            await this.applySyncNow(action, type, relPath, fromUri, toUri);
        } finally {
            if (guarded) {
                const left = (pushing.get(key) ?? 1) - 1;
                if (left > 0) { pushing.set(key, left); } else { pushing.delete(key); }
                if (left===0 && pullAfterPush.delete(key)) {
                    // whatever came in meanwhile: an echo is skipped, a real change taken
                    this.applySync('pull', 'update', relPath, toUri, fromUri).catch(() => {});
                }
            }
        }
    }

    private async applySyncNow(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        await (async () => {
            if (type==='delete') {
                const newContent = undefined;
                const kind = this.base.conflictOf(relPath);
                if (kind) {
                    if (action==='pull') { return; }
                    // deleted here: that settles it; a file Overleaf no longer has needs no more
                    log('info', `local replica: conflict in ${relPath} resolved by deleting it`);
                    await this.base.remove(relPath);
                    if (kind==='deleted') { return; }
                }
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                if (action==='push') { await this.journal.set(relPath, undefined); } // deleted: its pending saves are moot
                await this.base.remove(relPath);
                await vscode.workspace.fs.delete(toUri, {recursive:true});
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type===vscode.FileType.File) {
                    const agreed = this.bypassCache.get(relPath);
                    let newContent: Uint8Array | undefined;
                    try {
                        newContent = await vscode.workspace.fs.readFile(fromUri);
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        // saved while not connected, or while earlier saves still wait: in order, via the journal
                        if (action==='push' && await this.journalPush(relPath, newContent, agreed)) { return; }
                        if (action==='pull') {
                            await this.journal.ready();
                            if (this.journal.has(relPath)) {
                                // its pending saves go first; the replay then takes Overleaf's text
                                if (agreed) { this.bypassCache.set(relPath, agreed); } else { this.bypassCache.delete(relPath); }
                                log('info', `local replica: ${relPath} has saves waiting for upload: not updated from Overleaf before they are sent`);
                                return;
                            }
                        }
                        if (!(await this.conflictAllows(action, relPath, newContent))) {
                            if (agreed) { this.bypassCache.set(relPath, agreed); } else { this.bypassCache.delete(relPath); }
                            return;
                        }
                        if (action==='pull') {
                            // A local file with changes Overleaf does not have (an upload that
                            // failed, an edit by another program) is merged, never overwritten.
                            const local = await this.readFile(relPath);
                            const entry = await this.base.get(relPath);
                            if (local && hashOf(local)!==hashOf(newContent) && (!entry || hashOf(local)!==entry.hash)) {
                                log('info', `local replica: ${relPath} changed on Overleaf and here: merging`);
                                const report = emptyReport();
                                await reconcileFile(this.sides, this.base, relPath, report, newContent);
                                await this.announce(report);
                                return;
                            }
                        }
                        await vscode.workspace.fs.writeFile(toUri, newContent);
                        await this.base.set(relPath, newContent);
                        if (action==='push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
                    } catch (error: any) {
                        // not synced after all: the other side still holds what was agreed before
                        if (agreed) { this.bypassCache.set(relPath, agreed); } else { this.bypassCache.delete(relPath); }
                        log('warn', `local replica: ${action} of ${relPath} failed: ${error?.message ?? error}`);
                        if (action==='push') {
                            // kept with its edits and mode, sent once the connection is back
                            const kept = newContent!==undefined && await this.journalPush(relPath, newContent, agreed, true).catch(() => false);
                            vscode.window.showWarningMessage(kept
                                ? vscode.l10n.t('Could not upload {path} to Overleaf: {error}. The save is kept and uploaded, in the mode it was made in, when the connection is back.',
                                    {path: relPath, error: error?.message ?? String(error)})
                                : vscode.l10n.t('Could not upload {path} to Overleaf: {error}. It stays in the local copy and is merged in when the connection is back.',
                                    {path: relPath, error: error?.message ?? String(error)}));
                        }
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        })();

        this.status = {status: 'idle', message: ''};
        await this.updateAttention();
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = ('/' + pathParts.join('/'));
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        this.applySync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        // get relative path to baseUri, as "/sub/file.tex" like syncFromVFS and overwrite:
        // the caches are keyed by it. The stored folder may end with a slash; slicing that
        // off as well gave "sub/file.tex", so pushes never saw the pulls' entries, and the
        // bypass check then took every push after the second as an echo and dropped it.
        const basePath = this.baseUri.path.replace(/\/$/, '');
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        this.applySync('push', type, relPath, localUri, vfsUri);
    }

    /**
     * Push a saved document to the VFS.
     * Only fires for explicit user saves in the editor, not for external
     * file modifications (git, compilation tools, etc.).
     * This is the general fix for issues #299 and #323.
     */
    private onDocumentSaved(doc: vscode.TextDocument) {
        const docUri = doc.uri;
        // Only sync files within our baseUri (ensure path separator boundary)
        const basePath = this.baseUri.path.endsWith('/') ? this.baseUri.path : this.baseUri.path + '/';
        // Windows paths are case-insensitive: the folder is stored as typed ("/C:/Users/..."),
        // while VS Code reports open files with a lowercase drive letter ("/c:/Users/...").
        // Compared case-sensitively, no save was ever pushed.
        const inside = process.platform==='win32'
            ? docUri.path.toLowerCase().startsWith(basePath.toLowerCase())
            : docUri.path.startsWith(basePath);
        if (!inside) { return; }
        this.syncToVFS(docUri, 'update');
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error) {
            await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ));
        }

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );
        await this.overwrite();

        const syncOnFileChange = vscode.workspace
            .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange')
            .get<boolean>('enabled', false);

        // By default, only explicit editor saves push file modifications. Users who
        // rely on external tools can opt into file-system change events instead.
        // Keep these listeners mutually exclusive so an editor save is not pushed twice.
        const localChangeListener = syncOnFileChange
            ? this.localWatcher.onDidChange(async uri => await this.syncToVFS(uri, 'update'))
            : vscode.workspace.onDidSaveTextDocument(doc => this.onDocumentSaved(doc));

        return [
            // its files are copies of the project's docs: edits sent as typed, reviews shown
            ReplicaLinks.link(this.baseUri, this.vfs.origin),
            // from now on this sync takes the saves (see journalWhileNotConnected)
            this.markActive(),
            // sync from vfs to local
            this.vfsWatcher.onDidChange(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(async uri => await this.syncFromVFS(uri, 'delete')),
            // sync from local to vfs: file updates use the configured listener above;
            // file creation and deletion still always use the file-system watcher
            localChangeListener,
            this.localWatcher.onDidCreate(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidDelete(async uri => await this.syncToVFS(uri, 'delete')),
        ];
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
