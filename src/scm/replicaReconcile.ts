import { ConflictKind, ReplicaBase, hashOf, isText } from './replicaBase';
import { conflictsWithoutBase, merge3 } from './merge3';
import { toLf } from './replicaJournal';

/** The two sides of a local replica, by relative path ("/sub/file.tex"). */
export interface ReplicaSides {
    /** the files of the Overleaf project, without ignored ones */
    remoteFiles(): Promise<string[]>;
    /** the files of the local copy, without ignored ones */
    localFiles(): Promise<string[]>;
    readLocal(relPath: string): Promise<Uint8Array | undefined>;
    writeLocal(relPath: string, content: Uint8Array): Promise<void>;
    deleteLocal(relPath: string): Promise<void>;
    readRemote(relPath: string): Promise<Uint8Array>;
    /** write, creating the file (and its folders) if need be */
    writeRemote(relPath: string, content: Uint8Array): Promise<void>;
    /** keep `content` aside (in ".overleaf/conflicts"); returns where */
    keepCopy(relPath: string, content: Uint8Array, what: string): Promise<string>;
    /** both sides now hold `content` (so the watchers' echoes are not synced back) */
    agreed?(relPath: string, content: Uint8Array | undefined): void;
}

export type ReconcileReport = {
    /** Overleaf's changes taken into the local copy */
    pulled: string[],
    /** local changes (made while not connected) uploaded */
    pushed: string[],
    /** changed on both sides and merged without conflicts */
    merged: string[],
    /** created in the local copy while not connected, uploaded */
    created: string[],
    /** deleted on Overleaf, unchanged here: deleted here too (a copy is kept) */
    deleted: string[],
    /** kept out of sync until the user decides; `copy` is what was kept aside */
    /** `remaining`: for a pending save in conflict, how many saves wait after it */
    conflicts: {relPath: string, kind: ConflictKind, copy?: string, markers?: number, earlier?: boolean, remaining?: number}[],
    /** pending saves (made while not connected) uploaded in order */
    replayed: string[],
    /** pending saves that could not be uploaded yet (connection lost again) */
    waiting: string[],
    /** decisions made offline that could not be carried out, said to the user */
    notes: string[],
};

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && hashOf(a) === hashOf(b);
/** as text, with LF line breaks: Overleaf keeps no CRs, so a CRLF copy would differ on every line */
const decode = (content: Uint8Array) => toLf(new TextDecoder().decode(content));
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * Bring a local replica and its Overleaf project together after they were apart (VS Code
 * closed, or offline): for every file, whatever changed on one side only goes to the other;
 * what changed on both is merged; what cannot be merged is never overwritten but kept out
 * of sync as a conflict, for the user to resolve.
 */
export function emptyReport(): ReconcileReport {
    return {pulled: [], pushed: [], merged: [], created: [], deleted: [], conflicts: [], replayed: [], waiting: [], notes: []};
}

const agree = async (sides: ReplicaSides, base: ReplicaBase, relPath: string, content: Uint8Array) => {
    sides.agreed?.(relPath, content);
    await base.set(relPath, content);
};

const conflict = async (base: ReplicaBase, report: ReconcileReport, relPath: string, kind: ConflictKind,
                        remote: Uint8Array | undefined, extra: {copy?: string, markers?: number}) => {
    await base.setConflict(relPath, kind, remote);
    report.conflicts.push({relPath, kind, ...extra});
};

/**
 * Bring one file the Overleaf project has together with its local copy, Overleaf's
 * content being `remote` (read if not given).
 */
export async function reconcileFile(sides: ReplicaSides, base: ReplicaBase, relPath: string,
                                    report: ReconcileReport, remote?: Uint8Array) {
    const entry = await base.get(relPath);
    if (entry?.conflict) {
        report.conflicts.push({relPath, kind: entry.conflict, earlier: true});
        return;
    }
    remote ??= await sides.readRemote(relPath);
    const local = await sides.readLocal(relPath);
    if (local === undefined) {
        // not here (yet): take Overleaf's
        await sides.writeLocal(relPath, remote);
        await agree(sides, base, relPath, remote);
        if (entry) { report.pulled.push(relPath); }
        return;
    }
    if (same(local, remote)) {
        if (entry?.hash !== hashOf(remote)) { await agree(sides, base, relPath, remote); } else { sides.agreed?.(relPath, remote); }
        return;
    }
    const localChanged = !entry || hashOf(local) !== entry.hash;
    const remoteChanged = !entry || hashOf(remote) !== entry.hash;
    if (!localChanged) {
        await sides.writeLocal(relPath, remote);
        await agree(sides, base, relPath, remote);
        report.pulled.push(relPath);
    } else if (!remoteChanged) {
        await sides.writeRemote(relPath, local);
        await agree(sides, base, relPath, local);
        report.pushed.push(relPath);
    } else if (isText(local) && isText(remote) && (!entry || entry.content)) {
        const merge = entry?.content
            ? merge3(decode(entry.content), decode(local), decode(remote))
            : conflictsWithoutBase(decode(local), decode(remote));
        if (merge.conflicts === 0) {
            const merged = encode(merge.text);
            await sides.writeLocal(relPath, merged);
            await sides.writeRemote(relPath, merged);
            await agree(sides, base, relPath, merged);
            report.merged.push(relPath);
        } else {
            // the local version as it was is kept aside, then the file shows both
            const copy = await sides.keepCopy(relPath, local, 'local');
            await conflict(base, report, relPath, 'text', remote, {copy, markers: merge.conflicts});
            await sides.writeLocal(relPath, encode(merge.text));
        }
    } else {
        // cannot be merged: the local file stays, Overleaf's version is kept aside
        const copy = await sides.keepCopy(relPath, remote, 'overleaf');
        await conflict(base, report, relPath, 'binary', remote, {copy});
    }
}

export async function reconcile(sides: ReplicaSides, base: ReplicaBase, skip: Set<string> = new Set(),
                                report = emptyReport()): Promise<ReconcileReport> {
    const remoteFiles = await sides.remoteFiles();
    const onRemote = new Set(remoteFiles);
    for (const relPath of remoteFiles) {
        // files with pending saves: replayed save by save instead
        if (skip.has(relPath)) { continue; }
        try {
            await reconcileFile(sides, base, relPath, report);
        } catch {
            report.waiting.push(relPath); // one file failing does not stop the others
        }
    }

    for (const relPath of await sides.localFiles()) {
        if (onRemote.has(relPath) || skip.has(relPath)) { continue; }
        const entry = await base.get(relPath);
        if (entry?.conflict) {
            report.conflicts.push({relPath, kind: entry.conflict, earlier: true});
            continue;
        }
        const local = await sides.readLocal(relPath);
        if (local === undefined) { continue; }
        if (!entry) {
            // created here while not connected
            try {
                await sides.writeRemote(relPath, local);
            } catch {
                report.waiting.push(relPath); // tried again at the next start
                continue;
            }
            await agree(sides, base, relPath, local);
            report.created.push(relPath);
        } else if (hashOf(local) === entry.hash) {
            // deleted on Overleaf, unchanged here: follow, keeping a copy to be safe
            await sides.keepCopy(relPath, local, 'deleted-on-overleaf');
            await sides.deleteLocal(relPath);
            sides.agreed?.(relPath, undefined);
            await base.remove(relPath);
            report.deleted.push(relPath);
        } else {
            // deleted on Overleaf, but changed here: the user decides
            await conflict(base, report, relPath, 'deleted', undefined, {});
        }
    }
    return report;
}
