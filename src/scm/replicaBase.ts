import { createHash } from 'crypto';

/** Reads and writes files below the base folder (".overleaf/base" of a replica). */
export interface BaseIO {
    read(path: string): Promise<Uint8Array | undefined>;
    write(path: string, data: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
}

/** Why a file is kept out of sync until the user decides. */
export type ConflictKind =
    /** both sides changed it and the merge overlaps: the local file holds conflict markers */
    | 'text'
    /** both sides changed a file that cannot be merged: Overleaf's version is kept aside */
    | 'binary'
    /** changed in the local copy, deleted on Overleaf */
    | 'deleted';

export type BaseEntry = {hash: string, text: boolean, conflict?: ConflictKind};

export function hashOf(content: Uint8Array): string {
    return createHash('sha1').update(content).digest('hex');
}

/** UTF-8 text without NUL bytes: something the merge can work on. */
export function isText(content: Uint8Array): boolean {
    if (content.subarray(0, 8000).includes(0)) { return false; }
    try {
        new TextDecoder('utf-8', {fatal: true}).decode(content);
        return true;
    } catch {
        return false;
    }
}

/**
 * The last synced state of a local replica, kept on disk: what local copy and Overleaf
 * last agreed on, per file. It is the base of the three-way merge when both changed a
 * file while they were not connected, also after VS Code was closed meanwhile.
 *
 * Text files are kept as they are (about one more copy of the project's text); of other
 * files only a hash, which tells whether they changed, but cannot be merged anyway.
 */
export class ReplicaBase {
    private index?: {[relPath: string]: BaseEntry};
    private saving: Promise<void> = Promise.resolve();

    constructor(private readonly io: BaseIO) {}

    private async load() {
        if (!this.index) {
            const raw = await this.io.read('index.json').catch(() => undefined);
            let files = {};
            try {
                files = raw ? JSON.parse(new TextDecoder().decode(raw)).files ?? {} : {};
            } catch {
                // unreadable: start afresh (files that differ then count as conflicts)
            }
            this.index ??= files;
        }
        return this.index!;
    }

    /** Write the index; writes are queued, so the last one carries the latest state. */
    private save() {
        this.saving = this.saving.then(() => this.io.write('index.json',
            new TextEncoder().encode(JSON.stringify({version: 1, files: this.index}, null, 1))));
        return this.saving;
    }

    /** Load the index (needed before `conflictOf`). */
    async ready() { await this.load(); }

    async get(relPath: string): Promise<(BaseEntry & {content?: Uint8Array}) | undefined> {
        const entry = (await this.load())[relPath];
        if (!entry) { return undefined; }
        const content = entry.text ? await this.io.read('files' + relPath).catch(() => undefined) : undefined;
        return {...entry, content};
    }

    /** `relPath` is now synced with `content` on both sides (any conflict is over). */
    async set(relPath: string, content: Uint8Array) {
        const index = await this.load();
        const text = isText(content);
        index[relPath] = {hash: hashOf(content), text};
        if (text) {
            await this.io.write('files' + relPath, content);
        } else {
            await this.io.remove('files' + relPath).catch(() => {});
        }
        await this.save();
    }

    async remove(relPath: string) {
        const index = await this.load();
        if (!index[relPath]) { return; }
        delete index[relPath];
        await this.io.remove('files' + relPath).catch(() => {});
        await this.save();
    }

    /** Mark `relPath` as in conflict (kept out of sync), or as resolved with `undefined`. */
    async setConflict(relPath: string, kind: ConflictKind | undefined, content?: Uint8Array) {
        const index = await this.load();
        if (!index[relPath] && content) {
            index[relPath] = {hash: hashOf(content), text: isText(content)};
        }
        if (!index[relPath]) { return; }
        if (kind) { index[relPath].conflict = kind; } else { delete index[relPath].conflict; }
        await this.save();
    }

    /** The conflict of `relPath`, if any; once `ready`. */
    conflictOf(relPath: string): ConflictKind | undefined {
        return this.index?.[relPath]?.conflict;
    }

    async conflicts(): Promise<{relPath: string, kind: ConflictKind}[]> {
        return Object.entries(await this.load())
            .filter(([, e]) => e.conflict)
            .map(([relPath, e]) => ({relPath, kind: e.conflict!}));
    }
}
