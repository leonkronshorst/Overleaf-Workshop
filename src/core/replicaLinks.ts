import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';

/**
 * The local replica folders and the Overleaf projects they mirror, so that a file in a
 * local replica can be treated as the Overleaf doc it is a copy of: its edits sent as
 * typed (EditRecorder), its tracked changes and comments shown (ReviewManager).
 */
export class ReplicaLinks {
    private static readonly links: {local: vscode.Uri, remote: vscode.Uri}[] = [];
    private static readonly emitter = new vscode.EventEmitter<void>();
    /** Fires when a link is added or removed. */
    static readonly onDidChange = ReplicaLinks.emitter.event;

    /** Link the folder `local` to the project folder `remote` (a vfs origin) until disposed. */
    static link(local: vscode.Uri, remote: vscode.Uri): vscode.Disposable {
        const link = {local, remote};
        ReplicaLinks.links.push(link);
        ReplicaLinks.emitter.fire();
        return {dispose: () => {
            const index = ReplicaLinks.links.indexOf(link);
            if (index !== -1) {
                ReplicaLinks.links.splice(index, 1);
                ReplicaLinks.emitter.fire();
            }
        }};
    }

    /** `path` below `base` (both uri paths), as "/sub/file.tex"; undefined if it is not below. */
    private static below(base: string, path: string, ignoreCase: boolean): string | undefined {
        const prefix = base.endsWith('/') ? base : base + '/';
        const [p, b] = ignoreCase ? [path.toLowerCase(), prefix.toLowerCase()] : [path, prefix];
        return p.startsWith(b) ? path.slice(prefix.length - 1) : undefined;
    }

    /** `base` with `rel` ("/sub/file.tex") appended to its path, keeping its query. */
    private static join(base: vscode.Uri, rel: string): vscode.Uri {
        return base.with({path: base.path.replace(/\/$/, '') + rel});
    }

    /** The Overleaf uri of `uri`: itself for an Overleaf file, its original for a local replica file. */
    static toRemote(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme === ROOT_NAME) { return uri; }
        if (uri.scheme !== 'file') { return undefined; }
        for (const {local, remote} of ReplicaLinks.links) {
            // Windows paths are case-insensitive (and VS Code lowercases the drive letter)
            const rel = ReplicaLinks.below(local.path, uri.path, process.platform === 'win32');
            if (rel !== undefined && !rel.split('/').some((part) => part.startsWith('.'))) {
                return ReplicaLinks.join(remote, rel);
            }
        }
        return undefined;
    }

    /** The local replica copy of the Overleaf file `uri`, if there is a linked replica. */
    static toLocal(uri: vscode.Uri): vscode.Uri | undefined {
        for (const {local, remote} of ReplicaLinks.links) {
            if (uri.scheme !== remote.scheme || uri.authority !== remote.authority || uri.query !== remote.query) { continue; }
            const rel = ReplicaLinks.below(remote.path, uri.path, false);
            if (rel !== undefined) { return ReplicaLinks.join(local, rel); }
        }
        return undefined;
    }

    /** The linked replica folder of the Overleaf file `uri` and the file's path in it ("/sub/file.tex"). */
    static locate(uri: vscode.Uri): {folder: vscode.Uri, relPath: string} | undefined {
        for (const {local, remote} of ReplicaLinks.links) {
            if (uri.scheme !== remote.scheme || uri.authority !== remote.authority || uri.query !== remote.query) { continue; }
            const relPath = ReplicaLinks.below(remote.path, uri.path, false);
            if (relPath !== undefined) { return {folder: local, relPath}; }
        }
        return undefined;
    }

    /** The project folder of some linked replica, for commands not about a particular file. */
    static get anyRemote(): vscode.Uri | undefined {
        return ReplicaLinks.links[0]?.remote;
    }

    /**
     * The uri to open the Overleaf file `uri` in: the local copy when the window works on a
     * local replica, not on the Overleaf folder itself.
     */
    static forEditor(uri: vscode.Uri): vscode.Uri {
        const remoteOpen = vscode.workspace.workspaceFolders?.some((f) => f.uri.scheme === ROOT_NAME);
        return (!remoteOpen && ReplicaLinks.toLocal(uri)) || uri;
    }
}
