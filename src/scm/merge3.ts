import * as DiffMatchPatch from 'diff-match-patch';

/** The labels of the conflict markers: "current" is the local copy, "incoming" Overleaf's. */
export const LOCAL_LABEL = 'local copy';
export const REMOTE_LABEL = 'Overleaf';

/** The lines of `text`, each with its line break (the last one may have none). */
function splitLines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Replace base lines [start, end) with `lines`. */
type Hunk = {start: number, end: number, lines: string[]};

/**
 * The changes that turn the lines `a` into `b`, as hunks in `a`'s line numbers.
 * Each distinct line becomes one character, so diff-match-patch diffs whole lines.
 */
function diffLines(a: string[], b: string[]): Hunk[] {
    const codes = new Map<string, string>();
    let tooMany = false;
    const encode = (lines: string[]) => lines.map((line) => {
        let code = codes.get(line);
        if (code === undefined) {
            const n = codes.size;
            // skip the surrogate range, which diff-match-patch would split
            const point = n < 0xD800 ? n : n + 0x800;
            if (point > 0xFFFF) { tooMany = true; }
            code = String.fromCharCode(point & 0xFFFF);
            codes.set(line, code);
        }
        return code;
    }).join('');
    const [ca, cb] = [encode(a), encode(b)];
    if (tooMany) { // more distinct lines than characters: one hunk for all
        return a.join('') === b.join('') ? [] : [{start: 0, end: a.length, lines: b}];
    }
    const dmp = new DiffMatchPatch();
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    let i = 0, j = 0;
    for (const [op, chars] of dmp.diff_main(ca, cb, false)) {
        const n = chars.length;
        if (op === 0) {                            // equal
            if (current) { hunks.push(current); current = undefined; }
            i += n; j += n;
        } else if (op === -1) {                    // deleted
            current ??= {start: i, end: i, lines: []};
            i += n;
            current.end = i;
        } else {
            current ??= {start: i, end: i, lines: []};
            current.lines.push(...b.slice(j, j + n));
            j += n;
        }
    }
    if (current) { hunks.push(current); }
    return hunks;
}

function withFinalBreak(lines: string[]): string[] {
    const last = lines[lines.length - 1];
    return last === undefined || last.endsWith('\n') ? lines : [...lines.slice(0, -1), last + '\n'];
}

function conflictBlock(local: string[], remote: string[]): string[] {
    return [
        `<<<<<<< ${LOCAL_LABEL}\n`, ...withFinalBreak(local),
        '=======\n', ...withFinalBreak(remote),
        `>>>>>>> ${REMOTE_LABEL}\n`,
    ];
}

export type MergeResult = {text: string, conflicts: number};

/**
 * Three-way merge by lines, like git: what changed on one side only is taken from that
 * side; where both sides changed the same lines differently, the result holds both
 * versions between conflict markers (local copy first, then Overleaf's), which VS Code
 * offers to resolve with "Accept Current / Incoming / Both".
 */
export function merge3(base: string, local: string, remote: string): MergeResult {
    const baseLines = splitLines(base);
    const localLines = splitLines(local);
    const remoteLines = splitLines(remote);
    const hunks = [
        ...diffLines(baseLines, localLines).map((h) => ({...h, local: true})),
        ...diffLines(baseLines, remoteLines).map((h) => ({...h, local: false})),
    ].sort((x, y) => x.start - y.start || x.end - y.end);

    const out: string[] = [];
    let conflicts = 0;
    let pos = 0;
    for (let k = 0; k < hunks.length;) {
        // the hunks touching the same base lines, from either side
        const start = hunks[k].start;
        let end = hunks[k].end;
        const cluster = [hunks[k++]];
        while (k < hunks.length && (hunks[k].start < end || hunks[k].start === start)) {
            end = Math.max(end, hunks[k].end);
            cluster.push(hunks[k++]);
        }
        out.push(...baseLines.slice(pos, start));
        // one side's version of base lines [start, end)
        const version = (side: Hunk[]) => {
            const lines: string[] = [];
            let p = start;
            for (const h of side) {
                lines.push(...baseLines.slice(p, h.start), ...h.lines);
                p = h.end;
            }
            lines.push(...baseLines.slice(p, end));
            return lines;
        };
        const ours = cluster.filter((h) => h.local);
        const theirs = cluster.filter((h) => !h.local);
        if (theirs.length === 0) {
            out.push(...version(ours));
        } else if (ours.length === 0) {
            out.push(...version(theirs));
        } else {
            const [l, r] = [version(ours), version(theirs)];
            if (l.join('') === r.join('')) {
                out.push(...l);                    // the same change on both sides
            } else {
                conflicts++;
                out.push(...conflictBlock(l, r));
            }
        }
        pos = end;
    }
    out.push(...baseLines.slice(pos));
    return {text: out.join(''), conflicts};
}

/**
 * Without a common base nothing tells which side changed what: every place where the
 * two differ becomes a conflict.
 */
export function conflictsWithoutBase(local: string, remote: string): MergeResult {
    const localLines = splitLines(local);
    const out: string[] = [];
    let conflicts = 0;
    let pos = 0;
    for (const h of diffLines(localLines, splitLines(remote))) {
        out.push(...localLines.slice(pos, h.start));
        out.push(...conflictBlock(localLines.slice(h.start, h.end), h.lines));
        conflicts++;
        pos = h.end;
    }
    out.push(...localLines.slice(pos));
    return {text: out.join(''), conflicts};
}

/** Whether `text` still holds conflict markers. */
export function hasConflictMarkers(text: string): boolean {
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
}
