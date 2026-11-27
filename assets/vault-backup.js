/* =====================================================================
   SA Vault — office server backup (vault.html, "Server backup" page)

   Two server folders are connected separately:
     Client data  — one folder per client (top level = client name)
     Office data  — the office's own files (studies, payments, ledgers, formats)

   Down  (daily):  vault  ->  office server. Copies new and changed files only.
   Up    (rare):   office server  ->  vault. For the first set-up, or after working offline.

   How files are recognised: every vault file has a permanent ID and a fingerprint
   (MD5) that changes whenever its content changes. A small record file kept in each
   server folder remembers what was copied, so a normal run only downloads what is
   new or changed, without scanning the server.

   Safety: the vault never deletes anything on the office server. When a newer
   version from the vault replaces a server file, the old server copy is first saved
   in "SA Vault - replaced files" inside that folder.
   ===================================================================== */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var V = function () { return window.SAV; };

    var RECORD = 'SA Vault backup record.json';
    var RECORD_PREV = 'SA Vault backup record (previous).json';
    var LOG = 'SA Vault backup log.csv';
    var LOCK = 'SA Vault backup is running.txt';
    var REPLACED = 'SA Vault - replaced files';
    var SKIP_FILE = /^(SA Vault backup record.*\.json|SA Vault backup log\.csv|SA Vault backup is running\.txt|Thumbs\.db|desktop\.ini|\.DS_Store)$|^~\$|\.crswap$/i;
    var SKIP_DIR = /^(\$RECYCLE\.BIN|System Volume Information|\.Trash.*|SA Vault - replaced files)$/i;
    var CHUNK = 6 * 1048576;               // download piece
    var PARALLEL = 3;
    var AUTO_EVERY = 30 * 60 * 1000;
    var DEEP_EVERY = 7 * 86400000;
    var LOCK_STALE = 10 * 60 * 1000;
    var SAVE_EVERY = 90 * 1000;
    var EXPORTS = {
        'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
        'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
        'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
        'application/vnd.google-apps.drawing': ['application/pdf', '.pdf']
    };
    var SUPPORTED = !!(window.showDirectoryPicker || window.VAULT_TEST_PICK);
    var SCOPES = {
        clients: { label: 'Client data', key: 'server', help: 'the folder that holds one folder per client' },
        office: { label: 'Office data', key: 'office', help: 'the folder with the office’s own files (studies, payments, ledgers, formats)' }
    };
    var ORDER = ['clients', 'office'];

    var B = {
        f: { clients: { h: null, name: '', perm: 'none', reachable: null }, office: { h: null, name: '', perm: 'none', reachable: null } },
        running: null, stop: false, report: null, started: false, timer: 0, failed: { down: 0, up: 0 }
    };

    /* ---------------------------------------------------------------
       MD5 (fingerprint), incremental so big files never sit in memory
       --------------------------------------------------------------- */
    var K = new Int32Array(64), SH = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (var ki = 0; ki < 64; ki++) K[ki] = (Math.abs(Math.sin(ki + 1)) * 4294967296) | 0;
    function MD5() { this.h = new Int32Array([1732584193, -271733879, -1732584194, 271733878]); this.buf = new Uint8Array(64); this.n = 0; this.len = 0; this.M = new Int32Array(16); }
    MD5.prototype.block = function (b, o) {
        var M = this.M, h = this.h, i;
        for (i = 0; i < 16; i++) M[i] = b[o + 4 * i] | (b[o + 4 * i + 1] << 8) | (b[o + 4 * i + 2] << 16) | (b[o + 4 * i + 3] << 24);
        var a = h[0], bb = h[1], c = h[2], d = h[3], f, g, t, x, s;
        for (i = 0; i < 64; i++) {
            if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
            else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
            else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
            else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
            s = SH[(i >> 4) * 4 + (i & 3)];
            t = d; d = c; c = bb;
            x = (a + f + K[i] + M[g]) | 0;
            bb = (bb + ((x << s) | (x >>> (32 - s)))) | 0;
            a = t;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    };
    MD5.prototype.update = function (u8) {
        var i = 0, L = u8.length;
        this.len += L;
        if (this.n) {
            while (i < L && this.n < 64) this.buf[this.n++] = u8[i++];
            if (this.n === 64) { this.block(this.buf, 0); this.n = 0; }
        }
        for (; i + 64 <= L; i += 64) this.block(u8, i);
        while (i < L) this.buf[this.n++] = u8[i++];
        return this;
    };
    MD5.prototype.hex = function () {
        var bits = this.len * 8, pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
        pad[0] = 0x80;
        var lo = bits % 4294967296, hi = Math.floor(bits / 4294967296), p = pad.length - 8;
        for (var i = 0; i < 4; i++) { pad[p + i] = (lo >>> (8 * i)) & 255; pad[p + 4 + i] = (hi >>> (8 * i)) & 255; }
        this.update(pad);
        var out = '';
        for (var w = 0; w < 4; w++) for (var j = 0; j < 4; j++) out += ('0' + ((this.h[w] >>> (8 * j)) & 255).toString(16)).slice(-2);
        return out;
    };
    function md5OfFile(file, onBytes) {
        var m = new MD5(), pos = 0, step = 8 * 1048576;
        function next() {
            if (pos >= file.size) return Promise.resolve(m.hex());
            var part = file.slice(pos, pos + step);
            return part.arrayBuffer().then(function (ab) {
                m.update(new Uint8Array(ab)); pos += ab.byteLength;
                if (onBytes) onBytes(ab.byteLength);
                if (B.stop) throw stopErr();
                return next();
            });
        }
        return next();
    }
    window.SAVMD5 = function (u8) { return new MD5().update(u8).hex(); };      // used by the tests

    /* ---------------------------------------------------------------
       Small helpers
       --------------------------------------------------------------- */
    function stopErr() { var e = new Error('Stopped'); e.stopped = true; return e; }
    function b64ToBytes(s) {
        var bin = atob(s || ''), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function lower(p) { return String(p).toLowerCase(); }
    function nowIso() { return new Date().toISOString(); }
    function store(k, v) { try { if (v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
    function stored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function deviceId() {
        var id = stored('sav.device');
        if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 10); store('sav.device', id); }
        return id;
    }
    function autoOn() { return stored('sav.auto') !== '0'; }
    function ago(iso) {
        if (!iso) return '';
        var s = (Date.now() - new Date(iso).getTime()) / 1000;
        if (s < 90) return 'just now';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        var d = Math.round(s / 86400);
        return d === 1 ? 'yesterday' : d + ' days ago';
    }

    /* Windows-safe file and folder names. Returns the safe name. */
    function safeName(n) {
        var s = String(n).replace(/[\u0000-\u001f<>:"\/\\|?*]/g, '_').replace(/^\s+/, '').replace(/[. ]+$/, '');
        if (!s) s = '_';
        if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = '_' + s;
        if (s.length > 180) {
            var ext = (/\.[^.]{1,10}$/.exec(s) || [''])[0];
            s = s.slice(0, 180 - ext.length).replace(/[. ]+$/, '') + ext;
        }
        return s;
    }
    function withSuffix(path, n) {
        var i = path.lastIndexOf('/'), dir = path.slice(0, i + 1), name = path.slice(i + 1);
        var dot = name.lastIndexOf('.');
        return dot > 0 ? dir + name.slice(0, dot) + ' (' + n + ')' + name.slice(dot) : dir + name + ' (' + n + ')';
    }

    /* ---------------------------------------------------------------
       Remembered server folder (IndexedDB keeps the folder handle)
       --------------------------------------------------------------- */
    function idb(mode, fn) {
        return new Promise(function (res, rej) {
            var open = indexedDB.open('sa-vault', 1);
            open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
            open.onerror = function () { rej(open.error); };
            open.onsuccess = function () {
                var tx = open.result.transaction('kv', mode), st = tx.objectStore('kv'), r = fn(st);
                tx.oncomplete = function () { res(r && r.result); open.result.close(); };
                tx.onerror = function () { rej(tx.error); };
            };
        });
    }
    var MK = window.VAULT_MOCK_KV;           // demo page only
    var kvGet = function (k) { return MK ? Promise.resolve(MK.get(k)) : idb('readonly', function (s) { return s.get(k); }); };
    var kvSet = function (k, v) { return MK ? Promise.resolve(MK.set(k, v)) : idb('readwrite', function (s) { return s.put(v, k); }); };
    var kvDel = function (k) { return MK ? Promise.resolve(MK.del(k)) : idb('readwrite', function (s) { return s.delete(k); }); };

    function permission(h, ask) {
        if (!h.queryPermission) return Promise.resolve('granted');
        var o = { mode: 'readwrite' };
        return h.queryPermission(o).then(function (p) {
            if (p === 'granted' || !ask) return p;
            return h.requestPermission(o);
        });
    }
    function reachable(h) {
        return (async function () { var it = h.values(); await it.next(); return true; })().catch(function () { return false; });
    }


    /* ---------------------------------------------------------------
       Server folder file operations
       --------------------------------------------------------------- */
    function Disk(root) { this.root = root; this.dirs = new Map(); }
    Disk.prototype.dir = async function (parts, create) {
        var cur = this.root, key = '';
        for (var i = 0; i < parts.length; i++) {
            key += '/' + lower(parts[i]);
            var hit = this.dirs.get(key);
            if (hit) { cur = hit; continue; }
            try { cur = await cur.getDirectoryHandle(parts[i], { create: !!create }); }
            catch (e) { if (!create && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }
            this.dirs.set(key, cur);
        }
        return cur;
    };
    Disk.prototype.stat = async function (path) {          // -> File or null
        var parts = path.split('/'), d = await this.dir(parts.slice(0, -1), false);
        if (!d) return null;
        try { return await (await d.getFileHandle(parts[parts.length - 1])).getFile(); }
        catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null; throw e; }
    };
    /* Safe write: the browser writes to a temporary file and only swaps it in on close(),
       so a cut network or closed laptop never leaves a half-written file under the real name. */
    Disk.prototype.write = async function (path, producer) {
        var parts = path.split('/'), name = parts[parts.length - 1];
        var d = await this.dir(parts.slice(0, -1), true);
        var existed = true;
        try { await d.getFileHandle(name); } catch (e) { existed = false; }
        var fh = await d.getFileHandle(name, { create: true });
        var w = await fh.createWritable({ keepExistingData: false });
        try {
            await producer(w);
            await w.close();
        } catch (err) {
            try { await w.abort(); } catch (e) {}
            if (!existed) { try { await d.removeEntry(name); } catch (e) {} }
            throw err;
        }
        return fh.getFile();
    };
    Disk.prototype.readText = async function (name) {
        try { return await (await (await this.root.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
    };
    Disk.prototype.writeText = function (name, text) {
        return this.write(name, function (w) { return w.write(text); });
    };
    Disk.prototype.append = async function (name, text, header) {
        var fh = await this.root.getFileHandle(name, { create: true });
        var size = (await fh.getFile()).size;
        var w = await fh.createWritable({ keepExistingData: true });
        try {
            await w.seek(size);
            await w.write((size ? '' : '﻿' + header) + text);
            await w.close();
        } catch (e) { try { await w.abort(); } catch (x) {} throw e; }
    };
    Disk.prototype.remove = function (name) { return this.root.removeEntry(name).catch(function () {}); };

    /* ---------------------------------------------------------------
       Record of what is on the server, and the "someone else is running" lock
       --------------------------------------------------------------- */
    async function loadRecord(disk) {
        var tries = [RECORD, RECORD_PREV];
        for (var i = 0; i < tries.length; i++) {
            var t = await disk.readText(tries[i]);
            if (!t) continue;
            try { var r = JSON.parse(t); if (r && r.files) { r.dirs = r.dirs || {}; return r; } } catch (e) {}
        }
        return { v: 1, files: {}, dirs: {} };
    }
    async function saveRecord(disk, rec) {
        rec.saved = nowIso();
        await disk.writeText(RECORD, JSON.stringify(rec));
    }
    async function takeLock(disk) {
        var t = await disk.readText(LOCK);
        if (t) {
            var l = {};
            try { l = JSON.parse(t.split('\n').pop()); } catch (e) {}
            if (l.device && l.device !== deviceId() && Date.now() - new Date(l.time).getTime() < LOCK_STALE) {
                throw new Error('Another computer (' + (l.who || 'someone') + ') is backing up to this server folder right now. Try again in a few minutes.');
            }
        }
        await writeLock(disk);
    }
    function writeLock(disk) {
        var info = { device: deviceId(), who: (V().S.user || '') + ' on ' + (navigator.platform || 'a computer'), time: nowIso() };
        return disk.writeText(LOCK, 'The vault is copying files with this folder. This file is removed when it finishes.\n' + JSON.stringify(info));
    }

    /* ---------------------------------------------------------------
       Talking to the vault
       --------------------------------------------------------------- */
    var tickets = {};
    function ticketFor(driveId) {
        var t = tickets[driveId];
        if (t && t.expires - Date.now() > 10 * 60 * 1000) return Promise.resolve(t);
        return V().api('downloadTicket', { driveId: driveId }).then(function (r) { tickets[driveId] = r; return r; });
    }
    function agentCall(driveId, action, params, attempt) {
        attempt = attempt || 0;
        return ticketFor(driveId).then(function (t) {
            var body = Object.assign({ action: action, ticket: t.ticket }, params);
            if (window.VAULT_MOCK_AGENT) return Promise.resolve(window.VAULT_MOCK_AGENT(t.agentUrl, body)).then(function (j) {     // demo page only
                if (j.ok) return j; throw new Error(j.error || 'Drive error');
            });
            return fetch(t.agentUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
                body: JSON.stringify(body) })
                .then(function (r) { if (!r.ok) { var e = new Error('Google answered with an error (' + r.status + ')'); e.retry = true; throw e; } return r.json(); },
                    function () { var e = new Error('Could not reach Google. Check the internet connection.'); e.retry = true; throw e; })
                .then(function (j) {
                    if (j.ok) return j;
                    if (j.error === 'TICKET_EXPIRED') { delete tickets[driveId]; var e = new Error('Ticket expired'); e.retry = true; throw e; }
                    throw new Error(j.error || 'Drive error');
                });
        }).catch(function (err) {
            if (!err.retry || attempt >= 4 || B.stop) throw err;
            return V().wait((window.VAULT_TEST_FAST ? [30, 30, 30, 30] : [2000, 5000, 10000, 20000])[attempt]).then(function () { return agentCall(driveId, action, params, attempt + 1); });
        });
    }


    /* ---------------------------------------------------------------
       The two server folders, remembered on this computer
       --------------------------------------------------------------- */
    function loadFolders() {
        if (!SUPPORTED) return Promise.resolve();
        return Promise.all(ORDER.map(function (k) {
            var f = B.f[k];
            return kvGet(SCOPES[k].key).then(function (h) {
                if (!h) { f.h = null; f.perm = 'none'; return; }
                f.h = h; f.name = h.name;
                return permission(h, false).then(function (p) {
                    f.perm = p;
                    if (p !== 'granted') return;
                    return reachable(h).then(function (ok) { f.reachable = ok; });
                });
            }).catch(function () { f.h = null; f.perm = 'none'; });
        })).then(refreshFailedCounts).then(refreshReplaced);
    }
    function askAccess(h) {
        return permission(h, true).catch(function () { return 'prompt'; });
    }

    async function chooseFolder(k) {
        var otherKey = k === 'clients' ? 'office' : 'clients', other = B.f[otherKey].h;
        try {
            var h = window.VAULT_TEST_PICK ? await window.VAULT_TEST_PICK(k) : await window.showDirectoryPicker({ id: 'sa-vault-' + k, mode: 'readwrite' });
            if ((await askAccess(h)) !== 'granted') throw new Error('The browser did not allow access to that folder.');
            if (other) {
                if (await h.isSameEntry(other)) throw new Error('That is already the ' + SCOPES[otherKey].label + ' folder. Choose a different folder.');
                var inA = await h.resolve(other).catch(function () { return null; });
                var inB = await other.resolve(h).catch(function () { return null; });
                if (inA || inB) throw new Error('The Client data folder and the Office data folder must be separate: one cannot be inside the other.');
            }
            await kvSet(SCOPES[k].key, h);
            B.f[k] = { h: h, name: h.name, perm: 'granted', reachable: true };
            await refreshFailedCounts();
            render(); renderChip();
            V().toast(SCOPES[k].label + ' folder set: ' + h.name);
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            V().toast(err.message || 'Could not open that folder.', true);
        }
    }

    /* Failed files are remembered in each folder's record, so "Retry" works even after a restart */
    async function refreshFailedCounts() {
        var down = 0, up = 0;
        for (var i = 0; i < ORDER.length; i++) {
            var f = B.f[ORDER[i]];
            if (!f.h || f.perm !== 'granted' || f.reachable === false) continue;
            try {
                var rec = await loadRecord(new Disk(f.h));
                down += Object.keys(rec.failed || {}).length;
                up += Object.keys(rec.upFailed || {}).length;
            } catch (e) {}
        }
        B.failed = { down: down, up: up };
    }

    /* Size of "SA Vault - replaced files" in each folder, day by day */
    async function replacedInfo(k) {
        var f = B.f[k];
        if (!f.h || f.perm !== 'granted' || f.reachable === false) return null;
        var root;
        try { root = await f.h.getDirectoryHandle(REPLACED); } catch (e) { return { bytes: 0, files: 0, days: [] }; }
        var info = { bytes: 0, files: 0, days: [] };
        for await (var d of root.values()) {
            if (d.kind !== 'directory') continue;
            var day = { name: d.name, bytes: 0, files: 0 };
            var walk = async function (dir) {
                for await (var e of dir.values()) {
                    if (e.kind === 'directory') await walk(e);
                    else { var file = await e.getFile(); day.bytes += file.size; day.files++; }
                }
            };
            await walk(d);
            info.days.push(day); info.bytes += day.bytes; info.files += day.files;
        }
        info.days.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        return info;
    }
    async function refreshReplaced() {
        var out = {};
        for (var i = 0; i < ORDER.length; i++) { try { out[ORDER[i]] = await replacedInfo(ORDER[i]); } catch (e) { out[ORDER[i]] = null; } }
        B.replaced = out;
    }

    /* ---------------------------------------------------------------
       Everything in the vault, as a list of files with their space and path
       --------------------------------------------------------------- */
    async function cloudFiles(driveIds, onDrive) {
        var S = V().S;
        var byFolder = {};
        S.clients.forEach(function (c) { if (c.status !== 'missing') byFolder[c.folderId] = c; });
        var files = [], folders = [], failedDrives = [], okDrives = [], unknown = [], moving = {};
        S.clients.forEach(function (c) { if (c.moveTo) moving[c.moveDestId || ''] = 1; });
        for (var i = 0; i < driveIds.length; i++) {
            var d = V().driveOf(driveIds[i]);
            if (onDrive) onDrive(d);
            var inv;
            try { inv = await agentCall(d.id, 'inventory', {}); }
            catch (err) { failedDrives.push({ label: d.label, error: err.message }); continue; }
            okDrives.push(d.id);
            var parent = {}, name = {};
            inv.folders.forEach(function (f) { parent[f[0]] = f[1]; name[f[0]] = f[2]; });
            var memo = {};
            var place = function (fid) {
                if (fid in memo) return memo[fid];
                var out = null;
                if (byFolder[fid] && byFolder[fid].driveId === d.id) out = { client: byFolder[fid], parts: [], ids: [fid] };
                else if (parent[fid] !== undefined && parent[fid] !== inv.rootId) {
                    var up = place(parent[fid]);
                    if (up) out = { client: up.client, parts: up.parts.concat(name[fid]), ids: up.ids.concat(fid) };
                }
                memo[fid] = out;
                return out;
            };
            inv.folders.forEach(function (f) {
                var p = place(f[0]);
                if (p && p.parts.length) folders.push({ id: f[0], client: p.client, parts: p.parts, ids: p.ids });
                if (f[1] === inv.rootId && !byFolder[f[0]] && !moving[f[0]]) unknown.push(d.label + ': ' + f[2]);
            });
            inv.files.forEach(function (f) {
                var p = place(f[1]);
                if (!p) return;
                var native = /^application\/vnd\.google-apps\./.test(f[3]);
                files.push({ id: f[0], driveId: d.id, client: p.client, parts: p.parts.concat(f[2]), ids: p.ids, mime: f[3], size: f[4], md5: f[5],
                    modified: f[6], native: native, fp: native ? 'mt:' + f[6] : f[5] });
            });
        }
        return { files: files, folders: folders, failedDrives: failedDrives, okDrives: okDrives, unknown: unknown };
    }
    function inScope(k, c) { return k === 'office' ? c.kind === 'office' : c.kind !== 'office'; }

    /* ---------------------------------------------------------------
       Run framework (progress, report, log)
       --------------------------------------------------------------- */
    function newRun(kind, label) {
        return { kind: kind, label: label, started: nowIso(), phase: 'Starting…', total: 0, done: 0, bytesTotal: 0, bytesDone: 0,
            copied: 0, copiedBytes: 0, same: 0, failed: 0, issues: [], logs: {}, recs: {}, saved: {}, current: '' };
    }
    function where(scope, path) { return (scope === 'office' ? 'Office data / ' : '') + (path || ''); }
    function issue(run, group, scope, path, note) { run.issues.push({ group: group, path: where(scope, path), note: note || '' }); }
    function logRow(run, scope, action, path, size, note) {
        (run.logs[scope] = run.logs[scope] || []).push([new Date().toLocaleString('en-IN'), run.kind === 'up' ? 'Server to vault' : 'Vault to server', action, path,
            size === undefined ? '' : size, note || '']);
    }
    function csv(rows) {
        return rows.map(function (r) {
            return r.map(function (v) { v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
        }).join('\r\n') + '\r\n';
    }
    var GROUPS = {
        folder: 'Server folders that could not be used this time',
        conflict: 'Not copied: changed on the server and in the vault',
        differs: 'Not copied: a different file with this name is already on the server',
        failed: 'Failed: use “Retry” (they are also tried again on the next run)',
        replaced: 'Updated on the server: the old copy was saved in “' + REPLACED + '”',
        winname: 'Name changed so Windows accepts it',
        renamed: 'Renamed in the vault (the old name is kept on the server too)',
        deleted: 'Deleted in the vault (still kept on the server)',
        restored: 'Missing on the server, copied again',
        unsupported: 'Not copied: Google file type that cannot be saved as a file',
        loose: 'Skipped: files directly in the Client data folder (not inside a client folder)',
        noclient: 'Skipped: folders in the vault not linked to a client yet',
        drive: 'Drives that could not be reached (their files were not checked)',
        removed: 'Moved to the vault trash (not on the server)',
        cleaned: 'Deleted for good from “' + REPLACED + '”',
        unreadable: 'Could not be read on the server (skipped, nothing changed)'
    };
    var ALERT = /folder|conflict|differs|failed|drive|unreadable/;

    var lastPaint = 0;
    function paint(force) {
        if (!force && Date.now() - lastPaint < 200) return;
        lastPaint = Date.now();
        renderChip();
        if (V().S.view === 'backup') renderProgress();
    }

    /* Opens the chosen server folders, locks them, runs fn, then always saves records and logs. */
    async function withRun(kind, label, want, fn, opts) {
        opts = opts || {};
        if (B.running || B.waiting) { if (!opts.quiet) V().toast('A backup is already running.', true); return; }
        want = (want || ORDER).filter(function (k) { return B.f[k].h; });
        if (!want.length) { V().toast('Choose the office server folder first.', true); V().show('backup'); return; }
        var run = newRun(kind, label);
        B.running = run; B.stop = false;
        V().S.busy++;
        paint(true); render();
        var scopes = [], beat = 0;
        var openScopes = async function () {
            for (var i = 0; i < want.length; i++) {
                var k = want[i], f = B.f[k];
                var p = opts.gesture ? await askAccess(f.h) : await permission(f.h, false).catch(function () { return 'prompt'; });
                f.perm = p;
                if (p !== 'granted') { issue(run, 'folder', k, SCOPES[k].label + ' folder', 'The browser needs your permission again. Press “Allow access”.'); continue; }
                f.reachable = await reachable(f.h);
                if (!f.reachable) { issue(run, 'folder', k, SCOPES[k].label + ' folder', 'Not reachable. Connect to the office network.'); continue; }
                var disk = new Disk(f.h);
                try { await takeLock(disk); }
                catch (err) { issue(run, 'folder', k, SCOPES[k].label + ' folder', err.message); continue; }
                scopes.push({ key: k, label: SCOPES[k].label, disk: disk });
            }
        };
        var body = async function () {
            await openScopes();
            if (!scopes.length) {
                run.fatal = run.issues.length ? run.issues[run.issues.length - 1].note : 'The office server folder is not reachable.';
                return;
            }
            beat = setInterval(function () { scopes.forEach(function (sc) { writeLock(sc.disk).catch(function () {}); }); }, 2 * 60 * 1000);
            try { await fn(run, scopes); }
            finally {
                clearInterval(beat);
                for (var i = 0; i < scopes.length; i++) {
                    var sc = scopes[i];
                    if (run.recs[sc.key] && !run.saved[sc.key]) { try { await saveRecord(sc.disk, run.recs[sc.key]); } catch (e) {} }
                    try { if (run.logs[sc.key] && run.logs[sc.key].length) await sc.disk.append(LOG, csv(run.logs[sc.key]), csv([['Date and time', 'Direction', 'What happened', 'File', 'Size (bytes)', 'Note']])); }
                    catch (e) { issue(run, 'failed', sc.key, LOG, 'Could not write the log file: ' + e.message); }
                    await sc.disk.remove(LOCK);
                }
            }
        };
        try {
            if (navigator.locks) await navigator.locks.request('sa-vault-backup', { ifAvailable: true }, function (l) {
                if (!l) throw new Error('A backup is already running in another tab of this browser.');
                return body();
            });
            else await body();
        } catch (err) {
            if (err.stopped) issue(run, 'failed', null, '', 'Stopped before the end. Run it again to continue from here.');
            else run.fatal = err.message;
        }
        run.finished = nowIso();
        V().S.busy--;
        B.running = null; B.waiting = false;
        if (!run.cancelledBeforeStart) {
            B.report = run;
            keepReport(run);
        }
        if (!run.fatal && !run.cancelledBeforeStart && kind !== 'selected' && kind !== 'retry' && kind !== 'clean') {
            V().api('backupDone', { direction: kind === 'up' ? 'up' : 'down', files: run.copied, bytes: run.copiedBytes, failed: run.failed,
                issues: run.issues.filter(function (i) { return i.group !== 'failed'; }).length })
                .then(function (r) { V().S.backup = r.backup; renderChip(); render(); }).catch(function () {});
        }
        await refreshFailedCounts();
        await refreshReplaced();
        paint(true); render();
        if (run.fatal) V().toast(run.fatal, true);
        else if (!run.cancelledBeforeStart && !opts.quiet) V().toast(summaryLine(run), !!run.failed);
        else if (!run.cancelledBeforeStart && (run.copied || run.failed)) V().toast(summaryLine(run), !!run.failed);
        if (kind === 'up') V().refreshAll();
    }
    function summaryLine(run) {
        if (run.kind === 'clean') return run.copied ? 'Deleted ' + run.copied + ' older cop' + (run.copied === 1 ? 'y' : 'ies') + ' (' + V().bytes(run.copiedBytes) + ').' : 'There were no older copies to delete.';
        if (run.kind === 'up') return 'Copied ' + run.copied + ' file' + (run.copied === 1 ? '' : 's') + ' to the vault' + (run.failed ? ', ' + run.failed + ' failed' : '') + '.';
        return run.copied ? 'Backed up ' + run.copied + ' file' + (run.copied === 1 ? '' : 's') + ' to the server' + (run.failed ? ', ' + run.failed + ' failed' : '') + '.'
            : (run.failed ? run.failed + ' file(s) could not be copied.' : 'The server is up to date.');
    }
    function keepReport(run) {
        var r = { label: run.label, kind: run.kind, started: run.started, copied: run.copied, failed: run.failed, same: run.same, fatal: run.fatal || null,
            issues: run.issues.slice(0, 400), more: Math.max(0, run.issues.length - 400) };
        store('sav.report', JSON.stringify(r));
    }

    async function pool(items, n, fn) {
        var i = 0;
        async function worker() {
            while (i < items.length) {
                if (B.stop) return;
                var it = items[i++];
                await fn(it);
            }
        }
        var ws = [];
        for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
        await Promise.all(ws);
    }

    /* ---------------------------------------------------------------
       DOWN: vault -> office server
       --------------------------------------------------------------- */
    function backupNow(opts) {
        opts = opts || {};
        var kind = opts.selection ? 'selected' : opts.only ? 'retry' : 'down';
        var label = opts.selection ? 'Selected items sent to the server' : opts.only ? 'Failed copies retried' : opts.deep ? 'Backup with full check' : 'Backup to the office server';
        return withRun(kind, label, opts.scopes || null, function (run, scopes) { return downRun(run, scopes, opts); },
            { gesture: !opts.auto, quiet: !!opts.auto });
    }

    async function downRun(run, scopes, opts) {
        var S = V().S;
        run.phase = 'Reading the backup records…'; paint(true);
        for (var i = 0; i < scopes.length; i++) {
            var sc = scopes[i];
            sc.rec = run.recs[sc.key] = await loadRecord(sc.disk);
            var t = await sc.disk.readText(RECORD);
            if (t) await sc.disk.writeText(RECORD_PREV, t);          // keep the previous record as a spare
        }
        var driveIds = S.drives.map(function (d) { return d.id; });
        if (opts.selection) {
            var want = {};
            opts.selection.forEach(function (x) { var c = S.clients.filter(function (y) { return y.id === x.clientId; })[0]; if (c) want[c.driveId] = 1; });
            driveIds = driveIds.filter(function (id) { return want[id]; });
        }
        var cloud = await cloudFiles(driveIds, function (d) { run.phase = 'Listing files on ' + d.label + '…'; paint(true); });
        cloud.failedDrives.forEach(function (f) { issue(run, 'drive', null, f.label, f.error); });
        var partial = !!(opts.selection || opts.only);
        if (!partial) cloud.unknown.forEach(function (n) { issue(run, 'noclient', null, n, 'Press “Rescan drives” on the Storage page to add it as a client.'); });
        for (var j = 0; j < scopes.length && !B.stop; j++) await downScope(run, scopes[j], cloud, opts, partial);
        if (B.stop) throw stopErr();
    }

    async function downScope(run, sc, cloud, opts, partial) {
        var S = V().S, k = sc.key, rec = sc.rec, disk = sc.disk;
        rec.failed = rec.failed || {};
        var files = cloud.files.filter(function (f) { return inScope(k, f.client); });
        if (opts.selection) {
            var ids = {};
            opts.selection.forEach(function (x) { ids[x.id] = x.kind; });
            files = files.filter(function (f) {
                return ids[f.id] || ids[f.client.id] === 'client' || f.ids.some(function (a) { return ids[a] === 'folder'; });
            });
        }
        if (opts.only) { var only = opts.only[k] || {}; files = files.filter(function (f) { return only[f.id]; }); }
        var head = function (f) { return k === 'clients' ? [f.client.name] : []; };

        // Weekly full check: files the record says are on the server but are not any more
        var deep = !partial && (opts.deep || Date.now() - Number(stored('sav.lastDeep.' + k) || 0) > DEEP_EVERY);
        if (deep) {
            run.phase = 'Full check of the ' + sc.label + ' folder…'; paint(true);
            var keys = Object.keys(rec.files), n = 0;
            await pool(keys, 4, async function (id) {
                var e = rec.files[id];
                if (++n % 50 === 0) { run.current = n + ' of ' + keys.length + ' checked'; paint(); }
                if (e.g) return;
                try { if (!(await disk.stat(e.p))) e.missing = 1; } catch (err) { /* could not check this one; leave it as it is */ }
            });
            run.current = '';
        }

        run.phase = 'Comparing ' + sc.label + ' with the server…'; paint(true);
        var byPath = {};
        Object.keys(rec.files).forEach(function (id) { byPath[lower(rec.files[id].p)] = id; });
        files.forEach(function (f) {
            var parts = head(f).concat(f.parts).map(safeName);
            if (f.native && EXPORTS[f.mime]) parts[parts.length - 1] += EXPORTS[f.mime][1];
            f.want = parts.join('/');
            var orig = head(f).concat(f.parts).join('/') + (f.native && EXPORTS[f.mime] ? EXPORTS[f.mime][1] : '');
            f.renamedForWindows = orig !== f.want;
            f.path = null;
        });
        var claimed = {};
        files.forEach(function (f) {
            var e = rec.files[f.id];
            if (e && e.d === f.want && !claimed[lower(e.p)]) { f.path = e.p; claimed[lower(e.p)] = f.id; }
        });
        files.slice().sort(function (a, b) { return a.want < b.want ? -1 : a.want > b.want ? 1 : (a.id < b.id ? -1 : 1); }).forEach(function (f) {
            if (f.path) return;
            var p = f.want, n = 2;
            while (claimed[lower(p)] && claimed[lower(p)] !== f.id) p = withSuffix(f.want, n++);
            f.path = p; claimed[lower(p)] = f.id;
        });

        var jobs = [], seen = {}, checked = 0;
        var toCheck = files.filter(function (f) {
            seen[f.id] = 1;
            var e = rec.files[f.id];
            if (f.native && !EXPORTS[f.mime]) { issue(run, 'unsupported', k, f.path, f.mime.replace('application/vnd.google-apps.', 'Google ')); return false; }
            if (e && !e.missing && e.m === f.fp && lower(e.p) === lower(f.path)) { run.same++; e.c = f.client.id; delete e.g; delete rec.failed[f.id]; return false; }
            return true;
        });
        await pool(toCheck, 4, async function (f) {
          try { await compareOne(f); }
          catch (err) {
            if (err.stopped) throw err;
            run.failed++;
            rec.failed[f.id] = { p: f.path, e: err.message, t: nowIso() };
            issue(run, 'failed', k, f.path, 'Could not check the server copy: ' + err.message);
          }
        });
        async function compareOne(f) {
            if (++checked % 20 === 0) { run.current = checked + ' of ' + toCheck.length + ' compared'; paint(); }
            var e = rec.files[f.id];
            if (e && e.m === f.fp && lower(e.p) !== lower(f.path) && !e.missing) {      // renamed or moved in the vault, same content
                var old = await disk.stat(e.p);
                if (old && old.size === e.ls && old.lastModified === e.lm) { jobs.push({ f: f, how: 'local', from: e.p, oldSize: old.size, oldLm: old.lastModified, note: 'renamed' }); return; }
            }
            var local = await disk.stat(f.path);
            if (!local) { jobs.push({ f: f, how: 'download', note: e ? (e.missing ? 'restored' : (e.m === f.fp ? 'renamed' : 'changed')) : 'new' }); return; }
            var ownerId = (e && lower(e.p) === lower(f.path)) ? f.id : byPath[lower(f.path)];
            var owner = ownerId && rec.files[ownerId];
            if (owner) {
                var untouched = local.size === owner.ls && local.lastModified === owner.lm;
                if (owner.m === f.fp) { adopt(rec, f, local, ownerId); run.same++; return; }
                if (!untouched) {
                    issue(run, 'conflict', k, f.path, 'Edited on the server since the last backup, and changed in the vault too. The server copy was kept.');
                    logRow(run, k, 'Not copied (changed on both)', f.path, f.size);
                    return;
                }
                jobs.push({ f: f, how: 'download', note: 'changed', replace: ownerId, overwrite: true });
                return;
            }
            if (local.size === 0 && f.size > 0) { jobs.push({ f: f, how: 'download', note: 'new', overwrite: true }); return; }   // left over from an interrupted copy
            if (!f.native && f.md5 && local.size === f.size && (await md5OfFile(local)) === f.md5) { adopt(rec, f, local); run.same++; return; }
            issue(run, 'differs', k, f.path, 'The server already has a different file with this name. It was kept. Rename one of them, or use “Copy server to vault” if the server copy is the right one.');
            logRow(run, k, 'Not copied (different file on server)', f.path, f.size);
        }
        run.current = '';

        // Copy
        run.total += jobs.length;
        run.bytesTotal += jobs.reduce(function (a, j) { return a + (j.f.size || 0); }, 0);
        run.phase = jobs.length ? 'Copying to the ' + sc.label + ' folder…' : 'Finishing…';
        paint(true);
        var lastSave = Date.now();
        await pool(jobs, PARALLEL, async function (j) {
            var f = j.f;
            run.current = where(k, f.path);
            paint();
            try {
                var written, kept = null;
                if (j.how === 'local') {
                    var src = await disk.stat(j.from);
                    written = await disk.write(f.path, async function (w) { await w.write(src); });
                    if (written.size !== src.size) throw new Error('The copy on the server has the wrong size.');
                } else {
                    if (j.overwrite) kept = await keepOld(disk, f.path);
                    written = await download(f, disk, run);
                }
                if (j.replace && j.replace !== f.id) delete rec.files[j.replace];
                if (j.how === 'local') {
                    var prev = rec.files[f.id];
                    rec.files['old:' + lower(j.from)] = { p: j.from, d: '', m: prev ? prev.m : f.fp, s: f.size, ls: j.oldSize, lm: j.oldLm, c: f.client.id, g: nowIso() };
                }
                rec.files[f.id] = { p: f.path, d: f.want, m: f.fp, s: f.size, ls: written.size, lm: written.lastModified, c: f.client.id };
                delete rec.failed[f.id];
                byPath[lower(f.path)] = f.id;
                run.copied++; run.copiedBytes += written.size;
                logRow(run, k, j.note === 'new' ? 'Copied (new)' : j.note === 'changed' ? 'Copied (changed)' : j.note === 'restored' ? 'Copied again (was missing)' : 'Copied (renamed in vault)', f.path, written.size);
                if (kept && !kept.already) { issue(run, 'replaced', k, f.path, 'Old copy: ' + kept.path); logRow(run, k, 'Old server copy saved', kept.path); }
                if (kept && kept.already) { issue(run, 'replaced', k, f.path, 'Today’s earlier version is already kept: ' + kept.path); logRow(run, k, 'Old server copy already kept today', kept.path); }
                if (j.note === 'renamed') issue(run, 'renamed', k, f.path, j.from ? 'Old name on the server: ' + j.from : '');
                if (j.note === 'restored') issue(run, 'restored', k, f.path);
                if (f.renamedForWindows) issue(run, 'winname', k, f.path, 'In the vault: ' + head(f).concat(f.parts).join('/'));
            } catch (err) {
                if (err.stopped) throw err;
                run.failed++;
                rec.failed[f.id] = { p: f.path, e: err.message, t: nowIso() };
                issue(run, 'failed', k, f.path, err.message);
                logRow(run, k, 'Failed', f.path, f.size, err.message);
            }
            run.done++;
            paint();
            if (Date.now() - lastSave > SAVE_EVERY) { lastSave = Date.now(); await saveRecord(disk, rec); }
        });

        if (!partial) {
            // Empty folders: create them once so the server mirrors the vault's structure
            var dirs = cloud.folders.filter(function (fo) { return inScope(k, fo.client) && !rec.dirs[fo.id]; });
            for (var i = 0; i < dirs.length && !B.stop; i++) {
                try { await disk.dir((k === 'clients' ? [dirs[i].client.name] : []).concat(dirs[i].parts).map(safeName), true); rec.dirs[dirs[i].id] = 1; } catch (e) {}
            }
            // Deleted in the vault: the server copy is kept; it is listed once
            var okDrive = {}, clientDrive = {};
            cloud.okDrives.forEach(function (id) { okDrive[id] = 1; });
            S.clients.forEach(function (c) { clientDrive[c.id] = c.driveId; });
            Object.keys(rec.files).forEach(function (id) {
                var e = rec.files[id];
                if (seen[id] || e.g) return;
                var dId = clientDrive[e.c];
                if (dId && !okDrive[dId]) return;
                e.g = nowIso();
                issue(run, 'deleted', k, e.p);
                logRow(run, k, 'Deleted in vault (kept on server)', e.p, e.ls);
            });
            Object.keys(rec.failed).forEach(function (id) { if (!seen[id]) delete rec.failed[id]; });
            if (deep) store('sav.lastDeep.' + k, String(Date.now()));
        }
        Object.keys(rec.files).forEach(function (id) { delete rec.files[id].missing; });
        await saveRecord(disk, rec);
        run.saved[k] = true;
        if (!run.copied && !run.failed && !(run.logs[k] || []).length) logRow(run, k, 'Checked, nothing new', '', '', run.same + ' files already on the server');
    }

    function adopt(rec, f, local, oldId) {
        if (oldId && oldId !== f.id) delete rec.files[oldId];
        rec.files[f.id] = { p: f.path, d: f.want, m: f.fp, s: f.size, ls: local.size, lm: local.lastModified, c: f.client.id };
        delete (rec.failed || {})[f.id];
    }

    /* Before the server copy of a file is replaced, save it in "SA Vault - replaced files/<date>/..." */
    async function keepOld(disk, path) {
        var src = await disk.stat(path);
        if (!src || !src.size) return null;
        var dest = REPLACED + '/' + localDay(Date.now()) + '/' + path;
        // One old copy per file per day: if today's is already kept, that is the version from before
        // the first change today, so it stays and nothing more is added.
        if (await disk.stat(dest)) return { path: dest, already: true };
        try {
            var w = await disk.write(dest, async function (x) { await x.write(src); });
            if (w.size !== src.size) throw new Error('size check failed');
        } catch (err) {
            throw new Error('Could not save the old server copy first, so it was not replaced (' + err.message + ').');
        }
        return { path: dest };
    }
    function localDay(ms) {
        var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    async function download(f, disk, run) {
        return disk.write(f.path, async function (w) {
            if (f.native) {
                var r = await agentCall(f.driveId, 'exportFile', { fileId: f.id, mimeType: EXPORTS[f.mime][0] });
                var b = b64ToBytes(r.data);
                await w.write(b);
                run.bytesDone += b.length;
                return;
            }
            var m = new MD5(), pos = 0;
            while (pos < f.size) {
                if (B.stop) throw stopErr();
                var len = Math.min(CHUNK, f.size - pos);
                var part = await agentCall(f.driveId, 'fetchChunk', { fileId: f.id, start: pos, length: len });
                var bytes = b64ToBytes(part.data);
                if (bytes.length !== len) throw new Error('Google sent ' + bytes.length + ' bytes instead of ' + len + '. The file may have changed while copying.');
                m.update(bytes);
                await w.write(bytes);
                pos += bytes.length;
                run.bytesDone += bytes.length;
                paint();
            }
            if (f.md5 && m.hex() !== f.md5) throw new Error('The copy did not match the vault file (fingerprint check failed). It was not saved.');
        });
    }

    /* ---------------------------------------------------------------
       UP: office server -> vault
       --------------------------------------------------------------- */
    async function readServer(sc, run) {
        // The chosen folder itself cannot be read (drive letter disconnected, folder moved or renamed): stop with a clear message.
        var topErr = function (err) {
            return new Error('The ' + sc.label + ' folder (“' + sc.disk.root.name + '”) could not be opened. Check that the server is connected and the folder still exists, then press “Change” next to it and choose it again. (' + (err && err.message || err) + ')');
        };
        var out = { groups: [], loose: [], unreadable: [] }, count = 0;
        var head = function (g) { return sc.key === 'clients' ? [g.name] : []; };
        // A file or folder the browser cannot open is listed and skipped; the scan carries on.
        var walk = async function (dir, parts, g) {
            try {
                for await (var e of dir.values()) {
                    if (B.stop) throw stopErr();
                    try {
                        if (e.kind === 'directory') { if (!SKIP_DIR.test(e.name)) await walk(e, parts.concat(e.name), g); continue; }
                        if (SKIP_FILE.test(e.name)) continue;
                        var file = await e.getFile();
                        g.files.push({ parts: parts.concat(e.name), file: file });
                        g.bytes += file.size;
                        if (++count % 25 === 0) { run.current = count + ' files found'; paint(); }
                    } catch (err) {
                        if (err.stopped) throw err;
                        out.unreadable.push({ path: head(g).concat(parts, e.name).join('/'), error: err });
                    }
                }
            } catch (err) {
                if (err.stopped) throw err;
                if (dir === sc.disk.root) throw topErr(err);
                out.unreadable.push({ path: head(g).concat(parts).join('/') + '/ (folder)', error: err });
            }
        };
        if (sc.key === 'office') {
            var g = { name: 'Office data', files: [], bytes: 0 };
            await walk(sc.disk.root, [], g);
            out.groups.push(g);
        } else {
            try {
                for await (var entry of sc.disk.root.values()) {
                    if (B.stop) throw stopErr();
                    if (entry.kind === 'file') { if (!SKIP_FILE.test(entry.name)) out.loose.push(entry.name); continue; }
                    if (SKIP_DIR.test(entry.name)) continue;
                    out.groups.push({ name: entry.name, handle: entry, files: [], bytes: 0 });
                }
            } catch (err) { if (err.stopped) throw err; throw topErr(err); }
            out.groups.sort(function (a, b) { return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }); });
            for (var i = 0; i < out.groups.length; i++) await walk(out.groups[i].handle, [], out.groups[i]);
        }
        if (out.unreadable.length) {
            out.unreadable.forEach(function (u) { u.note = unreadableNote(u.path, u.error); });
        }
        run.current = '';
        return out;
    }

    function unreadableNote(path, err) {
        var why = err && err.name === 'NotFoundError' ? 'The browser could not find it while reading.' :
            err && err.name === 'NotReadableError' ? 'The file is open or locked by another program.' :
                err && err.name === 'SecurityError' ? 'The browser does not allow this kind of file to be opened.' : 'It could not be opened (' + (err && err.message || 'unknown reason') + ').';
        var hint = path.length > 180 ? ' Its path is very long (' + path.length + ' characters, plus the server folder’s own path; Windows struggles past about 250): shorten the folder or file names.' :
            /[ .]$/.test(path.split('/').pop()) ? ' Its name ends with a space or a dot, which Windows does not handle well: rename it.' :
                ' Common causes: a very long path, a name ending with a space or a dot, or the file being moved or open while the scan ran.';
        return why + hint;
    }

    function startUp(opts) {
        opts = opts || {};
        return withRun(opts.only ? 'up' : 'up', opts.only ? 'Failed copies to the vault retried' : 'Office server copied to the vault', opts.scopes || null, async function (run, scopes) {
            var plan = await planUp(run, scopes, opts);
            if (!plan) return;
            B.running = null; B.waiting = true; V().S.busy--;            // the confirm dialog is up
            renderChip(); render();
            var go = await confirmUp(plan);
            V().S.busy++; B.running = run; B.waiting = false;
            if (!go) { run.cancelledBeforeStart = true; return; }
            plan.mirror = go.mirror;
            plan.conflicts.forEach(function (it) {
                if (go.useServer) it.how = 'replace';
                else issue(run, 'conflict', it.scope, it.localPath, 'Changed on the server and in the vault. Both copies were left as they are.');
            });
            await executeUp(run, plan);
        }, { gesture: true });
    }

    async function planUp(run, scopes, opts) {
        var S = V().S;
        run.phase = 'Checking the drives…'; paint(true);
        await V().refreshAll();
        var offline = S.drives.filter(function (d) { return !d.online; });
        if (offline.length) throw new Error(offline.map(function (d) { return d.label; }).join(', ') + ' cannot be reached. All drives must be online to copy the server to the vault.');
        var cloud = await cloudFiles(S.drives.map(function (d) { return d.id; }), function (d) { run.phase = 'Listing files on ' + d.label + '…'; paint(true); });
        if (cloud.failedDrives.length) throw new Error('Could not list ' + cloud.failedDrives.map(function (f) { return f.label; }).join(', ') + '. Try again.');

        var byId = {}, byClient = {};
        cloud.files.forEach(function (f) { byId[f.id] = f; (byClient[f.client.id] = byClient[f.client.id] || []).push(f); });
        var plan = { pcs: [], upload: 0, uploadBytes: 0, replace: 0, replaceBytes: 0, same: 0, newClients: 0, removeFiles: [], removeClients: [],
            needBytes: 0, conflicts: [], keptDeleted: 0, vaultNewer: 0, perScope: {}, retry: !!opts.only };
        var hashList = [], matched = {};

        for (var si = 0; si < scopes.length; si++) {
            var sc = scopes[si], k = sc.key;
            run.phase = 'Reading the ' + sc.label + ' folder…'; paint(true);
            var rec = sc.rec = run.recs[k] = await loadRecord(sc.disk);
            rec.upFailed = rec.upFailed || {};
            var server = await readServer(sc, run);
            if (!opts.only) server.loose.forEach(function (n) { issue(run, 'loose', k, n); });
            server.unreadable.forEach(function (u) { issue(run, 'unreadable', k, u.path, u.note); });
            plan.unreadable = (plan.unreadable || 0) + server.unreadable.length;
            var partialRead = server.unreadable.length > 0;
            var recByPath = {};
            Object.keys(rec.files).forEach(function (id) { recByPath[lower(rec.files[id].p)] = id; });
            var clientByName = {};
            S.clients.forEach(function (c) { if (c.status !== 'missing' && c.kind !== 'office') clientByName[lower(c.name.trim())] = c; });
            var office = S.clients.filter(function (c) { return c.kind === 'office' && c.status !== 'missing'; })[0];
            var only = opts.only ? (opts.only[k] || {}) : null;
            var ps = plan.perScope[k] = { files: 0, groups: server.groups.length };

            server.groups.forEach(function (g) {
                var c = k === 'office' ? office : clientByName[lower(g.name.trim())];
                var pc = { scope: k, rec: rec, name: k === 'office' ? 'Office data' : g.name.trim(), client: c || null, bytes: g.bytes, items: [] };
                var cm = {};
                if (c) (byClient[c.id] || []).forEach(function (f) { var key = lower(f.parts.join('/')); if (!cm[key]) cm[key] = f; });
                g.files.forEach(function (lf) {
                    var localPath = (k === 'clients' ? [g.name] : []).concat(lf.parts).join('/');
                    if (only && !only[lower(localPath)]) return;
                    ps.files++;
                    var item = { scope: k, rel: lf.parts.join('/'), parts: lf.parts, file: lf.file, localPath: localPath, how: 'new' };
                    var rid = recByPath[lower(localPath)];
                    var e = rid && rec.files[rid];
                    var untouched = e && e.ls === lf.file.size && e.lm === lf.file.lastModified;
                    if (e) {
                        var cf = byId[rid];
                        if (e.g || !cf) {
                            if (untouched) { item.how = 'skip'; plan.keptDeleted++; pc.items.push(item); return; }
                        } else {
                            matched[cf.id] = 1;
                            item.cloud = cf;
                            var vaultChanged = cf.fp !== e.m;
                            if (untouched && !vaultChanged) item.how = 'same';
                            else if (untouched) { item.how = 'skip'; plan.vaultNewer++; }
                            else if (!vaultChanged) item.how = cf.md5 ? 'replace' : 'new';
                            else { item.how = 'conflict'; plan.conflicts.push(item); }
                            pc.items.push(item);
                            return;
                        }
                    }
                    var byName = cm[lower(item.rel)];
                    if (byName && !matched[byName.id] && !(rec.files[byName.id] && lower(rec.files[byName.id].p) !== lower(localPath))) {
                        matched[byName.id] = 1;
                        item.cloud = byName;
                        if (!byName.md5) item.how = 'new';
                        else if (byName.size === lf.file.size) { item.how = 'hash'; hashList.push(item); }
                        else item.how = 'replace';
                    }
                    pc.items.push(item);
                });
                if (!c) plan.newClients++;
                plan.pcs.push(pc);
            });
            if (partialRead) plan.mirrorOff = true;
            if (!only && !partialRead) {
                var names = {};
                server.groups.forEach(function (g) { names[lower(g.name.trim())] = 1; });
                plan.pcs.filter(function (pc) { return pc.scope === k && pc.client; }).forEach(function (pc) {
                    (byClient[pc.client.id] || []).forEach(function (f) { if (!matched[f.id] && f.md5) plan.removeFiles.push({ scope: k, client: pc.client, file: f }); });
                });
                if (k === 'clients') S.clients.forEach(function (c) { if (c.status === 'ok' && c.kind !== 'office' && !names[lower(c.name.trim())]) plan.removeClients.push(c); });
            }
        }

        if (hashList.length) {
            run.phase = 'Comparing ' + hashList.length + ' files with the vault…';
            var n = 0;
            await pool(hashList, 3, async function (it) {
                var h;
                try { h = await md5OfFile(it.file); }
                catch (err) {
                    if (err.stopped) throw err;
                    it.how = 'unreadable';
                    plan.unreadable = (plan.unreadable || 0) + 1;
                    issue(run, 'unreadable', it.scope, it.localPath, unreadableNote(it.localPath, err));
                    return;
                }
                it.how = h === it.cloud.md5 ? 'same' : 'replace';
                it.md5 = h;
                if (++n % 10 === 0) { run.current = n + ' of ' + hashList.length + ' compared'; paint(); }
            });
            run.current = '';
        }
        plan.pcs.forEach(function (pc) {
            pc.items.forEach(function (it) {
                if (it.how === 'same') plan.same++;
                else if (it.how === 'replace') { plan.replace++; plan.replaceBytes += it.file.size; plan.needBytes += Math.max(0, it.file.size - it.cloud.size); }
                else if (it.how === 'new') { plan.upload++; plan.uploadBytes += it.file.size; plan.needBytes += it.file.size; }
            });
        });
        plan.free = S.drives.filter(function (d) { return d.status === 'active'; })
            .reduce(function (a, d) { return a + Math.max(0, d.limit - d.used - (300 * 1048576)); }, 0);
        plan.folderIssues = run.issues.filter(function (i) { return i.group === 'folder'; }).map(function (i) { return i.path + ': ' + i.note; });
        run.phase = 'Waiting for you to confirm…'; paint(true);
        return plan;
    }

    function confirmUp(plan) {
        var X = V(), esc = X.esc;
        var line = function (n, label, extra) {
            label = label.replace(/\{([^|}]*)\|([^}]*)\}/g, function (m, one, many) { return n === 1 ? one : many; });
            return '<li><strong>' + n.toLocaleString('en-IN') + '</strong> ' + label + (extra ? ' <span class="v-muted">' + extra + '</span>' : '') + '</li>';
        };
        var clientsPcs = plan.pcs.filter(function (p) { return p.scope === 'clients'; });
        var officePc = plan.pcs.filter(function (p) { return p.scope === 'office'; })[0];
        var html = '<ul class="v-bk-plan">' +
            (plan.perScope.clients ? line(clientsPcs.length, 'client {folder|folders} on the server',
                clientsPcs.filter(function (p) { return !p.client; }).length ? '(' + clientsPcs.filter(function (p) { return !p.client; }).length + ' new in the vault, placed on the drives in A–Z order)' : '') : '') +
            (officePc ? line(officePc.items.length, 'office {file|files} on the server', officePc.client ? '(Office data space)' : '(a new Office data space will be created)') : '') +
            line(plan.upload, '{file|files} to copy to the vault', X.bytes(plan.uploadBytes)) +
            line(plan.replace, '{file differs|files differ} in the vault and will be replaced by the server copy', X.bytes(plan.replaceBytes) + (plan.replace ? ' · the vault keeps the previous version in Google Drive’s version history' : '')) +
            line(plan.same, '{file is|files are} already the same (skipped)') +
            (plan.vaultNewer ? line(plan.vaultNewer, '{file is|files are} newer in the vault', '(the next backup brings them to the server)') : '') +
            (plan.keptDeleted ? line(plan.keptDeleted, '{file was|files were} deleted or renamed in the vault and only kept on the server', '(not copied back)') : '') + '</ul>' +
            (plan.folderIssues && plan.folderIssues.length ? '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> Not included this time: ' +
                plan.folderIssues.map(esc).join('; ') + '</p>' : '') +
            (plan.unreadable ? '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> ' + plan.unreadable + ' item' + (plan.unreadable === 1 ? '' : 's') +
                ' on the server could not be read and will be skipped. They are listed with the reason after this run. Fix them (usually by shortening or renaming) and run this again.' +
                (plan.mirrorOff ? ' Because of this, “make the vault match the server” is not offered this time, so nothing in the vault is removed by mistake.' : '') + '</p>' : '') +
            (plan.conflicts.length ? '<div class="v-bk-mirror"><label class="v-check"><input type="checkbox" id="bkUseServer"> Use the server copy for ' + plan.conflicts.length +
                ' file(s) changed in both places</label><p class="v-small v-muted">' + plan.conflicts.slice(0, 5).map(function (it) { return esc(where(it.scope, it.localPath)); }).join('<br>') +
                (plan.conflicts.length > 5 ? '<br>…' : '') + '<br>If you leave this unticked, both copies stay as they are. If ticked, the vault keeps its version in Google Drive’s version history.</p></div>' : '') +
            (plan.needBytes > plan.free ? '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> This needs about ' + X.bytes(plan.needBytes) +
                ' but the drives have about ' + X.bytes(plan.free) + ' free. Add a drive or free up space first, or some files will fail.</p>' : '') +
            (plan.removeFiles.length || plan.removeClients.length ?
                '<div class="v-bk-mirror"><label class="v-check"><input type="checkbox" id="bkMirror"> Make the vault match the server exactly</label>' +
                '<p class="v-small v-muted">Moves to the <strong>vault trash</strong> (you can restore them from the Storage page for 30 days): ' + plan.removeFiles.length + ' vault file(s) that are not on the server' +
                (plan.removeClients.length ? ', and ' + plan.removeClients.length + ' client folder(s) that are not on the server (' +
                    plan.removeClients.slice(0, 6).map(function (c) { return esc(c.name); }).join(', ') + (plan.removeClients.length > 6 ? '…' : '') + ')' : '') +
                '. Google Docs created in the vault are never removed. Leave this unticked to keep everything.</p>' +
                '<div id="bkMirrorConfirm" hidden><label class="v-label" for="bkMirrorType">Type REMOVE to confirm</label><input class="v-input" id="bkMirrorType" autocomplete="off"></div></div>' : '') +
            '<p class="v-small v-muted">Nothing on the server is changed. Keep this page open until it finishes; if it stops, run it again and it continues.</p>';
        var body = X.el('<div>' + html + '</div>');
        var mirror = body.querySelector('#bkMirror');
        var useServer = body.querySelector('#bkUseServer');
        if (mirror) mirror.onchange = function () { body.querySelector('#bkMirrorConfirm').hidden = !mirror.checked; };
        if (!plan.upload && !plan.replace && !plan.conflicts.length && !plan.unreadable && !(plan.removeFiles.length || plan.removeClients.length)) {
            return X.modal({ title: plan.folderIssues && plan.folderIssues.length ? 'Nothing to copy from the folders that could be read' : 'The vault already matches the server', body: body, actions: [{ label: 'Close', value: true }] })
                .then(function () { return { mirror: false, nothing: true }; });
        }
        return X.modal({ title: plan.retry ? 'Retry the failed copies to the vault?' : 'Copy the office server to the vault?', body: body, wide: true, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: '<i class="fas fa-upload"></i> Start copying', id: 'bkUpGo', value: function () { return { mirror: !!(mirror && mirror.checked), useServer: !!(useServer && useServer.checked) }; },
                onClick: function () {
                    if (mirror && mirror.checked && body.querySelector('#bkMirrorType').value.trim().toUpperCase() !== 'REMOVE') {
                        X.toast('Type REMOVE to confirm moving vault files that are not on the server to the vault trash.', true);
                        body.querySelector('#bkMirrorType').focus();
                        return false;
                    }
                } }
        ] });
    }

    async function executeUp(run, plan) {
        var X = V();
        var sends = function (it) { return it.how === 'new' || it.how === 'replace'; };
        var todo = [];
        plan.pcs.forEach(function (pc) { pc.items.forEach(function (it) { if (sends(it)) todo.push(it); }); });
        run.total = todo.length;
        run.bytesTotal = todo.reduce(function (a, it) { return a + it.file.size; }, 0);
        var lastSave = Date.now(), pending = {};
        var record = function (pc, it, r) {
            var c = pc.client, rec = pc.rec;
            var want = (pc.scope === 'clients' ? [c.name] : []).concat(it.parts).map(safeName).join('/');
            Object.keys(rec.files).forEach(function (id) { if (id !== r.id && lower(rec.files[id].p) === lower(it.localPath)) delete rec.files[id]; });
            rec.files[r.id] = { p: it.localPath, d: want, m: r.md5, s: r.size, ls: it.file.size, lm: it.file.lastModified, c: c.id };
            delete rec.upFailed[lower(it.localPath)];
        };
        var fail = function (pc, it, msg) {
            run.failed++;
            pc.rec.upFailed[lower(it.localPath)] = { p: it.localPath, e: msg, t: nowIso() };
            issue(run, 'failed', pc.scope, it.localPath, msg);
            logRow(run, pc.scope, 'Failed', it.localPath, it.file.size, msg);
        };
        var order = plan.pcs.slice().sort(function (a, b) { return (a.scope === 'office') - (b.scope === 'office'); });
        for (var ci = 0; ci < order.length && !B.stop; ci++) {
            var pc = order[ci];
            if (pc.client) pc.items.forEach(function (it) { if (it.how === 'same' && it.cloud) record(pc, it, { id: it.cloud.id, md5: it.cloud.fp || it.cloud.md5, size: it.cloud.size }); });
            var items = pc.items.filter(sends);
            if (!items.length) continue;
            if (!pc.client) {
                run.phase = 'Creating “' + pc.name + '” in the vault…'; paint(true);
                try {
                    var made = await X.api(pc.scope === 'office' ? 'createOffice' : 'createClient', { name: pc.name, sizeHint: pc.bytes, pending: pending });
                    pc.client = made.client;
                    if (!X.S.clients.some(function (c) { return c.id === made.client.id; })) X.S.clients.push(made.client);
                    logRow(run, pc.scope, 'New ' + (pc.scope === 'office' ? 'office space' : 'client folder') + ' in vault (' + (made.drive || X.driveLabel(made.client.driveId)) + ')', pc.name, pc.bytes);
                } catch (err) {
                    items.forEach(function (it) { fail(pc, it, err.message); run.done++; });
                    continue;
                }
            }
            var c = pc.client;
            run.phase = 'Copying “' + pc.name + '” to the vault…'; paint(true);
            var folders = {};
            var folderOf = function (parts) {
                var key = '', p = Promise.resolve(c.folderId);
                parts.forEach(function (name) {
                    key += '/' + lower(name);
                    var kk = key;
                    p = p.then(function (pid) {
                        if (!folders[kk]) {
                            folders[kk] = X.makeFolder(c, pid, name, true).then(function (r) { return r.id; });
                            folders[kk].catch(function () { delete folders[kk]; });
                        }
                        return folders[kk];
                    });
                });
                return p;
            };
            await pool(items, X.direct(c) ? X.UPLOAD_JOBS : PARALLEL, async function (it) {
                run.current = where(pc.scope, it.localPath); paint();
                var sentNow = 0;      // several files upload at once: each adds only its own progress
                try {
                    var fid = await folderOf(it.parts.slice(0, -1));
                    var r = await X.uploadOne({ client: c, folderId: fid, file: it.file, name: it.parts[it.parts.length - 1],
                        fileId: it.how === 'replace' ? it.cloud.id : '', oldSize: it.how === 'replace' ? it.cloud.size : 0,
                        onProgress: function (sent) { run.bytesDone += sent - sentNow; sentNow = sent; paint(); } });
                    if (!r.md5) r.md5 = it.md5 || await md5OfFile(it.file);
                    record(pc, it, r);
                    pending[c.driveId] = (pending[c.driveId] || 0) + (it.file.size - (it.how === 'replace' ? it.cloud.size : 0));
                    run.copied++; run.copiedBytes += it.file.size;
                    logRow(run, pc.scope, it.how === 'replace' ? 'Replaced in vault (previous version kept in Google Drive)' : 'Copied to vault', it.localPath, it.file.size);
                } catch (err) {
                    if (err.stopped) throw err;
                    fail(pc, it, err.message);
                }
                run.bytesDone += it.file.size - sentNow;
                run.done++;
                paint();
                if (Date.now() - lastSave > SAVE_EVERY) { lastSave = Date.now(); await saveRecord(new Disk(B.f[pc.scope].h), pc.rec); }
            });
        }
        if (plan.mirror && !B.stop) {
            run.phase = 'Moving vault files that are not on the server to the vault trash…'; paint(true);
            for (var i = 0; i < plan.removeFiles.length && !B.stop; i++) {
                var rf = plan.removeFiles[i], rp = rf.file.parts.join('/');
                try {
                    await X.api('deleteItem', { clientId: rf.client.id, id: rf.file.id, name: rp, reason: 'Not on the office server (copy server to vault)' });
                    issue(run, 'removed', rf.scope, (rf.scope === 'clients' ? rf.client.name + '/' : '') + rp);
                    logRow(run, rf.scope, 'Moved to vault trash (not on server)', (rf.scope === 'clients' ? rf.client.name + '/' : '') + rp, rf.file.size);
                } catch (err) { issue(run, 'failed', rf.scope, rp, err.message); }
            }
            for (var j = 0; j < plan.removeClients.length && !B.stop; j++) {
                var rc = plan.removeClients[j];
                try {
                    await X.api('deleteClient', { clientId: rc.id, confirm: rc.name, reason: 'Not on the office server (copy server to vault)' });
                    issue(run, 'removed', 'clients', rc.name + ' (whole client folder)');
                    logRow(run, 'clients', 'Client folder moved to vault trash (not on server)', rc.name, rc.sizeBytes);
                } catch (err) { issue(run, 'failed', 'clients', rc.name, err.message); }
            }
        }
        run.phase = 'Saving the backup records…'; paint(true);
        await X.flushSizes();
        var done = {};
        for (var p = 0; p < plan.pcs.length; p++) {
            var s = plan.pcs[p].scope;
            if (done[s]) continue;
            done[s] = 1;
            await saveRecord(new Disk(B.f[s].h), plan.pcs[p].rec);
            run.saved[s] = true;
        }
        if (B.stop) throw stopErr();
    }

    function cleanUp() {
        var X = V(), esc = X.esc, R = B.replaced || {};
        var count = function (days) {
            var cut = localDay(Date.now() - days * 86400000), n = 0, b = 0;
            ORDER.forEach(function (k) { (R[k] && R[k].days || []).forEach(function (d) { if (/^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name < cut) { n += d.files; b += d.bytes; } }); });
            return { n: n, b: b, cut: cut };
        };
        var body = X.el('<div><p>Delete older copies from <strong>“' + REPLACED + '”</strong> in the server folders. Your current files are not touched.</p>' +
            '<label class="v-label">Delete copies older than</label><div class="v-bk-ages">' +
            [30, 90, 180].map(function (d) { return '<label class="v-check"><input type="radio" name="bkAge" value="' + d + '"' + (d === 90 ? ' checked' : '') + '> ' + d + ' days</label>'; }).join('') +
            '</div><p class="v-bk-warn" id="bkCleanSum"></p><label class="v-label" for="bkCleanType">Type DELETE to confirm</label><input class="v-input" id="bkCleanType" autocomplete="off"></div>');
        var sum = function () {
            var days = Number(body.querySelector('input[name=bkAge]:checked').value), c = count(days);
            body.querySelector('#bkCleanSum').innerHTML = c.n ? '<i class="fas fa-triangle-exclamation"></i> This deletes <strong>' + c.n + ' file' + (c.n === 1 ? '' : 's') + ' (' + X.bytes(c.b) +
                ')</strong> kept before ' + X.date(c.cut) + ', for good. Copies from the last ' + days + ' days stay.' : 'Nothing is older than ' + days + ' days.';
            return c;
        };
        body.querySelectorAll('input[name=bkAge]').forEach(function (r) { r.onchange = sum; });
        sum();
        X.modal({ title: 'Clean up old copies', body: body, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: null },
            { label: '<i class="fas fa-broom"></i> Delete older copies', cls: 'v-btn--danger', id: 'bkCleanGo',
                value: function () { return Number(body.querySelector('input[name=bkAge]:checked').value); },
                onClick: function () {
                    if (!sum().n) { X.toast('There is nothing that old to delete.'); return false; }
                    if (body.querySelector('#bkCleanType').value.trim().toUpperCase() !== 'DELETE') { X.toast('Type DELETE to confirm.', true); body.querySelector('#bkCleanType').focus(); return false; }
                } }
        ] }).then(function (days) {
            if (!days) return;
            var cut = localDay(Date.now() - days * 86400000);
            withRun('clean', 'Older copies cleaned up', null, async function (run, scopes) {
                run.phase = 'Deleting older copies…'; paint(true);
                for (var i = 0; i < scopes.length; i++) {
                    var sc = scopes[i], info = (B.replaced || {})[sc.key] || { days: [] }, root;
                    try { root = await sc.disk.root.getDirectoryHandle(REPLACED); } catch (e) { continue; }
                    for (var j = 0; j < info.days.length; j++) {
                        var d = info.days[j];
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.name) || d.name >= cut) continue;
                        try {
                            await root.removeEntry(d.name, { recursive: true });
                            run.copied += d.files; run.copiedBytes += d.bytes;
                            issue(run, 'cleaned', sc.key, REPLACED + '/' + d.name, d.files + ' file(s), ' + X.bytes(d.bytes));
                            logRow(run, sc.key, 'Older copies deleted for good', REPLACED + '/' + d.name, d.bytes, d.files + ' file(s)');
                        } catch (err) { run.failed++; issue(run, 'failed', sc.key, REPLACED + '/' + d.name, err.message); }
                    }
                }
                if (run.copied) X.api('logNote', { what: 'old copies deleted', detail: run.copied + ' older copies (' + X.bytes(run.copiedBytes) + ') kept before ' + cut + ' in “' + REPLACED + '”' }).catch(function () {});
            }, { gesture: true });
        });
    }

    /* ---------------------------------------------------------------
       Retry, selected items, automatic runs
       --------------------------------------------------------------- */
    async function retryFailed(direction) {
        var only = {}, scopes = [];
        for (var i = 0; i < ORDER.length; i++) {
            var k = ORDER[i], f = B.f[k];
            if (!f.h) continue;
            var rec = await loadRecord(new Disk(f.h));
            var list = direction === 'up' ? rec.upFailed : rec.failed;
            if (!list || !Object.keys(list).length) continue;
            only[k] = {};
            Object.keys(list).forEach(function (id) { only[k][id] = 1; });
            scopes.push(k);
        }
        if (!scopes.length) { V().toast('Nothing to retry.'); await refreshFailedCounts(); render(); return; }
        if (direction === 'up') return startUp({ only: only, scopes: scopes });
        return backupNow({ only: only, scopes: scopes });
    }

    function sendSelected(list) {
        if (!SUPPORTED) { V().toast('Sending to the office server needs Chrome or Edge on a computer.', true); return; }
        var S = V().S, need = {};
        list.forEach(function (x) { var c = S.clients.filter(function (y) { return y.id === x.clientId; })[0]; need[c && c.kind === 'office' ? 'office' : 'clients'] = 1; });
        var scopes = Object.keys(need);
        var missing = scopes.filter(function (k) { return !B.f[k].h; });
        if (missing.length) { V().toast('Choose the ' + SCOPES[missing[0]].label + ' folder on the Server backup page first.', true); V().show('backup'); return; }
        return backupNow({ selection: list, scopes: scopes }).then(function () {
            V().S.fsel = {};
            if (V().S.view === 'files') V().show('files');
        });
    }

    function onOverview() {
        renderChip();
        if (B.started) return;
        B.started = true;
        try { var r = JSON.parse(stored('sav.report') || 'null'); if (r) { r.stored = true; B.report = r; } } catch (e) {}
        loadFolders().then(function () {
            renderChip(); render();
            if (ORDER.some(function (k) { var f = B.f[k]; return f.h && f.perm === 'granted' && f.reachable; }) && autoOn()) setTimeout(autoRun, 2500);
            B.timer = setInterval(autoRun, AUTO_EVERY);
        });
    }
    function autoRun() {
        if (!SUPPORTED || B.running || B.waiting || !autoOn() || $('vApp').hidden) return;
        var have = ORDER.filter(function (k) { return B.f[k].h; });
        if (!have.length) return;
        Promise.all(have.map(function (k) {
            var f = B.f[k];
            return permission(f.h, false).catch(function () { return 'prompt'; }).then(function (p) {
                f.perm = p;
                if (p !== 'granted') return null;
                return reachable(f.h).then(function (ok) { f.reachable = ok; return ok ? k : null; });
            });
        })).then(function (ks) {
            ks = ks.filter(Boolean);
            renderChip(); render();
            if (ks.length) backupNow({ auto: true, scopes: ks });
        });
    }

    /* ---------------------------------------------------------------
       Screens
       --------------------------------------------------------------- */
    function renderChip() {
        var chip = $('vBk'), text = $('vBkText');
        if (!chip || !V()) return;
        var b = V().S.backup && V().S.backup.down;
        var cls = 'v-bk-chip', label;
        var needPerm = ORDER.some(function (k) { return B.f[k].h && B.f[k].perm === 'prompt'; });
        if (B.running) {
            var r = B.running;
            label = '<i class="fas fa-spinner fa-spin"></i> ' + (r.total ? 'Copying ' + Math.min(r.done + 1, r.total) + ' of ' + r.total : 'Checking the server…');
            cls += ' run';
        } else if (needPerm) {
            label = '<i class="fas fa-lock-open"></i> Click to allow server access'; cls += ' warn';
        } else if (B.failed.down || B.failed.up) {
            label = '<i class="fas fa-triangle-exclamation"></i> ' + (B.failed.down + B.failed.up) + ' failed · click to retry'; cls += ' warn';
        } else if (!b) {
            label = '<i class="fas fa-server"></i> Server backup: not run yet'; cls += ' warn';
        } else {
            label = '<i class="fas fa-server"></i> Server backup · ' + ago(b.time);
            if (Date.now() - new Date(b.time).getTime() > 7 * 86400000 || b.failed) cls += ' warn';
        }
        chip.className = cls;
        text.innerHTML = label;
    }

    function renderProgress() {
        var box = $('bkProgress');
        if (!box) return;
        var r = B.running;
        box.hidden = !r;
        if (!r) return;
        if (!B.stop) $('bkStop').disabled = false;
        $('bkPhase').textContent = r.phase;
        var pct = r.bytesTotal ? r.bytesDone / r.bytesTotal * 100 : (r.total ? r.done / r.total * 100 : 0);
        $('bkBar').style.width = Math.min(100, pct) + '%';
        var X = V();
        $('bkCounts').innerHTML = (r.total ? '<span><b>' + r.done + '</b> of ' + r.total + ' files</span><span><b>' + X.bytes(r.bytesDone) + '</b> of ' + X.bytes(r.bytesTotal) + '</span>' : '') +
            (r.same ? '<span><b>' + r.same.toLocaleString('en-IN') + '</b> already up to date</span>' : '') +
            (r.failed ? '<span class="bad"><b>' + r.failed + '</b> failed</span>' : '');
        $('bkCurrent').textContent = r.current || '';
    }

    function renderReport() {
        var box = $('bkReport');
        var r = B.report;
        box.hidden = !r || B.running;
        if (box.hidden) return;
        var X = V(), esc = X.esc;
        var groups = {};
        r.issues.forEach(function (i) { (groups[i.group] = groups[i.group] || []).push(i); });
        var head = r.fatal ? '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> ' + esc(r.fatal) + '</p>' :
            '<p class="v-bk-sum">' + esc(summaryLine(r)) + (r.same ? ' ' + r.same.toLocaleString('en-IN') + (r.same === 1 ? ' file was' : ' files were') + ' already up to date.' : '') + '</p>';
        var html = '<div class="v-bk-report-head"><h2 class="v-h2">Last run: ' + esc(r.label) + '</h2><span class="v-small v-muted">' + X.date(r.started, true) + '</span></div>' + head;
        Object.keys(GROUPS).forEach(function (g) {
            var list = groups[g];
            if (!list) return;
            html += '<details' + (ALERT.test(g) ? ' open' : '') + ' class="v-bk-group ' + g + '"><summary>' + esc(GROUPS[g]) + ' <span class="v-badge ' +
                (ALERT.test(g) ? 'warn' : 'idle') + '">' + list.length + '</span></summary><ul>' +
                list.slice(0, 200).map(function (i) { return '<li><span>' + esc(i.path) + '</span>' + (i.note ? '<em>' + esc(i.note) + '</em>' : '') + '</li>'; }).join('') +
                (list.length > 200 ? '<li><em>… and ' + (list.length - 200) + ' more (see the log file)</em></li>' : '') + '</ul></details>';
        });
        html += '<p class="v-small v-muted" style="margin-top:1rem">Every run is also written to <strong>' + LOG + '</strong> in each server folder.</p>';
        box.innerHTML = html;
    }

    function renderFolders() {
        var box = $('bkFolders');
        box.innerHTML = ORDER.map(function (k) {
            var f = B.f[k], has = !!f.h;
            var state = !SUPPORTED ? 'Not available in this browser' :
                !has ? 'Not chosen yet: ' + SCOPES[k].help + '.' :
                    f.perm === 'prompt' ? 'The browser needs your permission again.' :
                        f.perm !== 'granted' ? 'Access was not allowed. Choose the folder again.' :
                            f.reachable === false ? 'Not reachable right now. Connect to the office network.' : 'Connected';
            var ok = has && f.perm === 'granted' && f.reachable !== false;
            return '<div class="v-bk-folder" data-k="' + k + '"><span class="v-bk-folder-ico ' + k + '"><i class="fas ' + (k === 'office' ? 'fa-building' : 'fa-users') + '"></i></span>' +
                '<div class="v-bk-folder-main"><span class="v-bk-folder-label">' + SCOPES[k].label + '</span><strong>' + (has ? V().esc(f.name) : '—') + '</strong>' +
                '<span class="v-bk-state ' + (ok ? 'ok' : 'warn') + '">' + V().esc(state) + '</span></div>' +
                '<div class="v-bk-folder-acts">' +
                (has && f.perm === 'prompt' ? '<button class="v-btn v-btn--sm" data-allow><i class="fas fa-lock-open"></i> Allow access</button>' : '') +
                '<button class="v-btn v-btn--ghost v-btn--sm" data-choose' + (!SUPPORTED || B.running ? ' disabled' : '') + '><i class="fas fa-folder-open"></i> ' + (has ? 'Change' : 'Choose folder') + '</button>' +
                (has && !B.running ? '<button class="v-link" data-forget>Forget</button>' : '') + '</div></div>';
        }).join('');
        box.querySelectorAll('.v-bk-folder').forEach(function (row) {
            var k = row.dataset.k;
            row.querySelector('[data-choose]').onclick = function () { chooseFolder(k); };
            var a = row.querySelector('[data-allow]');
            if (a) a.onclick = function () {
                askAccess(B.f[k].h).then(function (p) {
                    B.f[k].perm = p;
                    return reachable(B.f[k].h).then(function (ok) { B.f[k].reachable = ok; });
                }).then(refreshFailedCounts).then(function () { render(); renderChip(); if (B.f[k].perm === 'granted' && autoOn()) backupNow({}); });
            };
            var fg = row.querySelector('[data-forget]');
            if (fg) fg.onclick = function () {
                V().confirmBox('Forget the ' + SCOPES[k].label + ' folder?', 'The vault stops backing up this folder on this computer until you choose it again. <strong>Nothing is deleted.</strong>', 'Forget').then(function (ok) {
                    if (!ok) return;
                    kvDel(SCOPES[k].key).then(function () { B.f[k] = { h: null, name: '', perm: 'none', reachable: null }; return refreshFailedCounts(); }).then(function () { render(); renderChip(); });
                });
            };
        });
    }

    function render() {
        if (!$('view-backup') || !V()) return;
        var X = V(), S = X.S;
        $('bkUnsupported').hidden = SUPPORTED;
        renderFolders();
        $('bkAuto').checked = autoOn();
        var ready = SUPPORTED && anyFolder() && !B.running && !B.waiting;
        $('bkRun').disabled = !ready; $('bkDeep').disabled = !ready; $('bkUpCheck').disabled = !ready;
        var att = $('bkAttention');
        att.hidden = !(B.failed.down || B.failed.up) || !!B.running;
        $('bkRetryDown').hidden = !B.failed.down;
        $('bkRetryDown').innerHTML = '<i class="fas fa-rotate-right"></i> Retry ' + B.failed.down + ' failed cop' + (B.failed.down === 1 ? 'y' : 'ies') + ' to the server';
        $('bkRetryUp').hidden = !B.failed.up;
        $('bkRetryUp').innerHTML = '<i class="fas fa-rotate-right"></i> Retry ' + B.failed.up + ' failed cop' + (B.failed.up === 1 ? 'y' : 'ies') + ' to the vault';
        $('bkRetryDown').disabled = $('bkRetryUp').disabled = !ready;
        var last = function (b, none) {
            if (!b) return '<span class="v-muted">' + none + '</span>';
            return '<i class="fas fa-clock-rotate-left"></i> Last run ' + X.date(b.time, true) + ' (' + ago(b.time) + ') by ' + X.esc(b.user) + ': ' +
                b.files + ' file' + (b.files === 1 ? '' : 's') + ' copied' + (b.failed ? ', <span class="bad">' + b.failed + ' failed</span>' : '') +
                (b.issues ? ', ' + b.issues + ' to check' : '');
        };
        var R = B.replaced || {}, rows = ORDER.filter(function (k) { return R[k]; }), total = 0;
        rows.forEach(function (k) { total += R[k].bytes; });
        $('bkReplaced').innerHTML = rows.length ? rows.map(function (k) {
            var r = R[k];
            return '<li><span>' + SCOPES[k].label + '</span><strong>' + X.bytes(r.bytes) + '</strong><em>' + r.files + ' file' + (r.files === 1 ? '' : 's') +
                (r.days.length ? ' · since ' + X.date(r.days[0].name) : '') + '</em></li>';
        }).join('') : '<li><span class="v-muted">Connect the server folders to see this.</span></li>';
        $('bkClean').disabled = !ready || !total;
        $('bkLastDown').innerHTML = last(S.backup && S.backup.down, 'Not run yet.');
        $('bkLastUp').innerHTML = last(S.backup && S.backup.up, 'Not run yet.');
        renderProgress();
        renderReport();
    }
    function anyFolder() { return ORDER.some(function (k) { return !!B.f[k].h; }); }

    function bind() {
        if (!$('bkRun')) return;
        $('bkAuto').addEventListener('change', function () { store('sav.auto', this.checked ? '1' : '0'); });
        $('bkRun').addEventListener('click', function () { backupNow({}); });
        $('bkDeep').addEventListener('click', function () { backupNow({ deep: true }); });
        $('bkUpCheck').addEventListener('click', function () { startUp({}); });
        $('bkClean').addEventListener('click', cleanUp);
        $('bkRetryDown').addEventListener('click', function () { retryFailed('down'); });
        $('bkRetryUp').addEventListener('click', function () { retryFailed('up'); });
        $('bkStop').addEventListener('click', function () { B.stop = true; this.disabled = true; $('bkPhase').textContent = 'Stopping after the files in progress…'; });
        $('vBk').addEventListener('click', function () { V().show('backup'); });
    }

    window.SAVBackup = { onOverview: onOverview, render: render, sendSelected: sendSelected, backupNow: backupNow, startUp: startUp, state: B, safeName: safeName };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
