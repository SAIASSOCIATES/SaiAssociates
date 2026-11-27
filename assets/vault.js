/* =====================================================================
   SA Vault — page logic (vault.html). No libraries needed.
   Talks to the MASTER Apps Script web app set in window.VAULT_CONFIG.api
   ===================================================================== */
(function () {
    'use strict';

    var CFG = window.VAULT_CONFIG || {};
    var CHUNK = 8 * 1024 * 1024;              // resumable upload piece (multiple of 256 KB)
    var SMALL_LIMIT = 20 * 1024 * 1024;       // fallback path limit
    var PARALLEL = 8;                         // files being prepared/uploaded at once
    var PUT_SLOTS = 4;                        // of those, how many send their bytes at the same time
    var KEY = 'saVault.session';

    var $ = function (id) { return document.getElementById(id); };
    var S = {
        token: '', user: '', drives: [], settings: { threshold: 80 }, clients: [], loaded: false,
        view: 'files',
        client: null, path: [], items: [], itemsFor: '',
        fileSort: 'name', search: '',
        cSort: { key: 'size', dir: -1 }, cSearch: '', cDrive: '', selected: {}, fsel: {}, backup: { down: null, up: null },
        busy: 0, passes: {}
    };

    /* ---------------------------------------------------------------
       Helpers
       --------------------------------------------------------------- */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function bytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
        return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
    }
    function gb(n) { return ((Number(n) || 0) / 1073741824).toFixed(1) + ' GB'; }
    function pct(n) { return (Number(n) || 0).toFixed(0) + '%'; }
    function date(iso, withTime) {
        if (!iso) return '—';
        var d = new Date(iso);
        if (isNaN(d)) return '—';
        var o = { day: 'numeric', month: 'short', year: 'numeric' };
        if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
        return d.toLocaleString('en-IN', o);
    }
    function ago(iso) {
        if (!iso) return 'not checked yet';
        var s = (Date.now() - new Date(iso).getTime()) / 1000;
        if (isNaN(s)) return '';
        if (s < 90) return 'checked just now';
        if (s < 3600) return 'checked ' + Math.round(s / 60) + ' min ago';
        if (s < 86400) return 'checked ' + Math.round(s / 3600) + ' h ago';
        return 'checked ' + date(iso);
    }
    function byName(a, b) { return String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' }); }
    function driveOf(id) { return S.drives.filter(function (d) { return d.id === id; })[0]; }
    function driveLabel(id) { var d = driveOf(id); return d ? d.label : 'Unknown drive'; }
    function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
    function spin(btn, on, html) {
        if (!btn) return;
        if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner"></i> ' + (html || 'Working…'); }
        else { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
    }
    function fileIcon(item) {
        if (item.isFolder) return ['', 'fa-folder'];
        var n = String(item.name).toLowerCase(), m = String(item.mimeType || '');
        if (/\.pdf$/.test(n) || /pdf/.test(m)) return ['pdf', 'fa-file-pdf'];
        if (/\.(xlsx?|xlsm|csv|ods)$/.test(n) || /spreadsheet|excel|csv/.test(m)) return ['xls', 'fa-file-excel'];
        if (/\.(docx?|odt|rtf|txt)$/.test(n) || /document|word|text\//.test(m)) return ['doc', 'fa-file-lines'];
        if (/\.(jpe?g|png|gif|webp|heic|bmp|tiff?)$/.test(n) || /^image\//.test(m)) return ['img', 'fa-file-image'];
        if (/\.(zip|rar|7z|tar|gz)$/.test(n) || /zip|compressed|archive/.test(m)) return ['zip', 'fa-file-zipper'];
        if (/\.(json|xml|html?|js)$/.test(n)) return ['other', 'fa-file-code'];
        return ['other', 'fa-file'];
    }
    function openUrl(item) { return item.url || (item.isFolder ? 'https://drive.google.com/drive/folders/' + item.id : 'https://drive.google.com/file/d/' + item.id + '/view'); }
    function downloadUrl(item) { return 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(item.id); }
    function isGoogleDoc(item) { return /^application\/vnd\.google-apps\./.test(item.mimeType || ''); }

    var toastTimer;
    function toast(msg, isErr) {
        var t = $('vToast');
        t.textContent = msg;
        t.className = 'v-toast show' + (isErr ? ' err' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.className = 'v-toast' + (isErr ? ' err' : ''); }, isErr ? 6000 : 3200);
    }

    /* ---------------------------------------------------------------
       API
       --------------------------------------------------------------- */
    function configured() { return !!CFG.api && /^https?:\/\//.test(CFG.api); }

    var LIMIT_MSG = 'Google’s daily limit for this account is used up. It resets within 24 hours; nothing is lost. Opening folders still works.';
    function friendly(msg) { return /too many times for one day|Service invoked too many/i.test(msg || '') ? LIMIT_MSG : msg; }
    function api(action, params) {
        var body = Object.assign({ action: action, token: S.token }, params || {});
        var call = window.VAULT_MOCK ? Promise.resolve(window.VAULT_MOCK(body)) :
            fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
                .then(function (r) {
                    if (!r.ok) throw new Error('The vault server answered with an error (' + r.status + '). Please try again.');
                    return r.json();
                }, function () { throw new Error('Could not reach the vault server. Check your internet connection.'); });
        return call.then(function (res) {
            if (!res || !res.ok) {
                if (res && res.code === 'AUTH') { endSession(res.error); }
                var e = new Error(friendly((res && res.error) || 'Something went wrong.'));
                e.code = res && res.code;
                throw e;
            }
            return res;
        });
    }

    /* ---------------------------------------------------------------
       Straight to a drive's agent (one hop instead of two), with a short-lived pass from the master.
       Used when the drive runs the new agent (version 4); older agents go through the master as before.
       --------------------------------------------------------------- */
    function direct(c) { var d = driveOf(c.driveId); return !!(d && Number(d.v) >= 4 && d.online !== false); }
    function passFor(driveId, fresh) {
        var p = S.passes[driveId];
        if (!fresh && p && p.expires - Date.now() > 5 * 60 * 1000) return Promise.resolve(p);
        return api('downloadTicket', { driveId: driveId }).then(function (r) { S.passes[driveId] = r; return r; });
    }
    function agentApi(driveId, action, params, again) {
        return passFor(driveId, again).then(function (p) {
            var body = Object.assign({ action: action, ticket: p.ticket }, params || {});
            var call = window.VAULT_MOCK_AGENT ? Promise.resolve(window.VAULT_MOCK_AGENT(p.agentUrl, body)) :
                fetch(p.agentUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
                    .then(function (r) {
                        if (!r.ok) throw new Error(driveLabel(driveId) + ' answered with an error (' + r.status + '). Please try again.');
                        return r.json();
                    }, function () { throw new Error('Could not reach ' + driveLabel(driveId) + '. Check your internet connection.'); });
            return call.then(function (res) {
                if (res && res.ok) return res;
                if (res && res.error === 'TICKET_EXPIRED' && !again) return agentApi(driveId, action, params, true);
                var e = new Error((res && res.error) === 'NO_SPACE' ? 'NO_SPACE' : driveLabel(driveId) + ': ' + friendly((res && res.error) || 'Something went wrong.'));
                throw e;
            });
        });
    }
    function listFolder(c, folderId) {
        if (!direct(c)) return api('list', { clientId: c.id, folderId: folderId }).then(function (r) { return r.items; });
        return agentApi(c.driveId, 'list', { withinId: c.folderId, folderId: folderId || c.folderId }).then(function (r) { return r.items; });
    }
    function makeFolder(c, parentId, name, reuse) {
        if (c.status === 'moving') return Promise.reject(new Error('"' + c.name + '" is being moved to another drive. Try again after the move finishes.'));
        if (!direct(c)) return api('createFolder', { clientId: c.id, parentId: parentId, name: name, reuse: !!reuse });
        return agentApi(c.driveId, 'createFolder', { withinId: c.folderId, parentId: parentId || c.folderId, name: name, reuse: !!reuse });
    }

    /* Upload sessions are asked for in batches: files that start around the same time share one call. */
    var sessQ = {};
    function sessionFor(c, spec) {
        if (c.status === 'moving') return Promise.reject(new Error('"' + c.name + '" is being moved to another drive. Upload after the move finishes.'));
        return new Promise(function (resolve, reject) {
            var q = sessQ[c.id] = sessQ[c.id] || { c: c, items: [], timer: 0 };
            q.items.push({ spec: spec, resolve: resolve, reject: reject });
            if (q.items.length >= 20) flushSessions(c.id);
            else if (!q.timer) q.timer = setTimeout(function () { flushSessions(c.id); }, 80);
        });
    }
    function flushSessions(cid) {
        var q = sessQ[cid];
        if (!q) return;
        clearTimeout(q.timer); q.timer = 0;
        var batch = q.items.splice(0, 20);
        if (!batch.length) return;
        if (q.items.length) q.timer = setTimeout(function () { flushSessions(cid); }, 0);
        agentApi(q.c.driveId, 'uploadSessions', { withinId: q.c.folderId, origin: location.origin, items: batch.map(function (b) { return b.spec; }) })
            .then(function (r) {
                batch.forEach(function (b, i) {
                    var one = (r.sessions || [])[i] || {};
                    if (one.uploadUrl) b.resolve(one.uploadUrl); else b.reject(new Error(one.error || 'The upload could not start. Please try again.'));
                });
            }, function (err) {
                var e = err.message === 'NO_SPACE' ? new Error(driveLabel(q.c.driveId) + ' is nearly full, so "' + q.c.name + '" cannot grow there. Move this client to another drive from the Storage page.') : err;
                batch.forEach(function (b) { b.reject(e); });
            });
    }
    /* Only a few files send their bytes at once; the rest get ready meanwhile. */
    var freeSlots = PUT_SLOTS, slotWait = [];
    function inSlot(fn) {
        return new Promise(function (res) { if (freeSlots > 0) { freeSlots--; res(); } else slotWait.push(res); }).then(function () {
            var done = function () { var n = slotWait.shift(); if (n) n(); else freeSlots++; };
            return Promise.resolve().then(fn).then(function (v) { done(); return v; }, function (e) { done(); throw e; });
        });
    }
    /* Client sizes: uploads straight to a drive are reported to the master in batches. */
    var pendingSizes = {}, sizeTimer = 0;
    function pendSize(c, bytes, files) {
        var p = pendingSizes[c.id] = pendingSizes[c.id] || { clientId: c.id, bytes: 0, files: 0 };
        p.bytes += Number(bytes) || 0; p.files += Number(files) || 0;
        if (!sizeTimer) sizeTimer = setTimeout(flushSizes, 15000);
    }
    function flushSizes() {
        clearTimeout(sizeTimer); sizeTimer = 0;
        var items = Object.keys(pendingSizes).map(function (k) { return pendingSizes[k]; });
        pendingSizes = {};
        if (!items.length) return Promise.resolve();
        return api('noteUploads', { items: items }).then(function () {}, function () {
            items.forEach(function (it) {
                var p = pendingSizes[it.clientId] = pendingSizes[it.clientId] || { clientId: it.clientId, bytes: 0, files: 0 };
                p.bytes += it.bytes; p.files += it.files;
            });
            if (!sizeTimer) sizeTimer = setTimeout(flushSizes, 60000);
        });
    }
    window.addEventListener('pagehide', function () {
        var items = Object.keys(pendingSizes).map(function (k) { return pendingSizes[k]; });
        if (!items.length || window.VAULT_MOCK || !navigator.sendBeacon || !CFG.api) return;
        try { navigator.sendBeacon(CFG.api, new Blob([JSON.stringify({ action: 'noteUploads', token: S.token, items: items })], { type: 'text/plain' })); pendingSizes = {}; } catch (e) {}
    });

    /* ---------------------------------------------------------------
       Modal
       --------------------------------------------------------------- */
    var modalResolve = null, modalLocked = false;
    function modal(opts) {
        return new Promise(function (resolve) {
            closeModal(undefined);
            modalResolve = resolve;
            modalLocked = !!opts.locked;
            $('vModalTitle').textContent = opts.title || '';
            var body = $('vModalBody');
            body.innerHTML = '';
            if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
            var acts = $('vModalActions');
            acts.innerHTML = '';
            (opts.actions || [{ label: 'OK', value: true }]).forEach(function (a) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'v-btn ' + (a.cls || '');
                b.innerHTML = a.label;
                if (a.id) b.id = a.id;
                b.addEventListener('click', function () {
                    if (a.onClick) { var r = a.onClick(b); if (r === false) return; }
                    closeModal(typeof a.value === 'function' ? a.value() : a.value);
                });
                acts.appendChild(b);
            });
            document.querySelector('.v-modal-card').classList.toggle('wide', !!opts.wide);
            $('vModal').hidden = false;
            var first = body.querySelector('input, select') || acts.lastChild;
            setTimeout(function () { if (first) first.focus(); }, 30);
        });
    }
    function closeModal(value) {
        if ($('vModal').hidden) return;
        $('vModal').hidden = true;
        modalLocked = false;
        var r = modalResolve; modalResolve = null;
        if (r) r(value);
    }
    function confirmBox(title, html, okLabel, danger) {
        return modal({ title: title, body: '<p>' + html + '</p>', actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: okLabel || 'OK', cls: danger ? 'v-btn--danger' : '', value: true }
        ] });
    }
    function promptBox(title, label, value, okLabel, hint) {
        var wrap = el('<div><label class="v-label" for="vPrompt">' + esc(label) + '</label><input class="v-input" id="vPrompt" autocomplete="off">' +
            (hint ? '<p class="v-muted v-small">' + hint + '</p>' : '') + '</div>');
        var input = wrap.querySelector('input');
        input.value = value || '';
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('vModalActions').lastChild.click(); } });
        setTimeout(function () { input.select(); }, 40);
        return modal({ title: title, body: wrap, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: null },
            { label: okLabel || 'Save', value: function () { return input.value.trim(); } }
        ] });
    }

    /* ---------------------------------------------------------------
       Sign in
       --------------------------------------------------------------- */
    var ticket = '';
    function loginAlert(msg, kind) {
        var a = $('vLoginAlert');
        a.textContent = msg || '';
        a.className = 'v-alert' + (msg ? ' show ' + (kind || 'err') : '');
    }
    function showLogin(msg) {
        $('vApp').hidden = true;
        $('vTray').hidden = true;
        $('vLogin').hidden = false;
        $('vOtpForm').hidden = true;
        $('vLoginForm').hidden = false;
        $('vPass').value = '';
        loginAlert(msg || '', 'info');
        if (!configured() && !window.VAULT_MOCK) {
            loginAlert('This page is not connected yet. Paste the master web app link into vault.html (VAULT_CONFIG.api).', 'err');
        }
        setTimeout(function () { ($('vUser').value ? $('vPass') : $('vUser')).focus(); }, 50);
    }
    function endSession(msg) {
        try { sessionStorage.removeItem(KEY); } catch (e) {}
        S.token = ''; S.loaded = false;
        closeModal(undefined);
        showLogin(msg || 'You have been signed out.');
    }

    $('vLoginForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var u = $('vUser').value.trim(), p = $('vPass').value;
        if (!u || !p) { loginAlert('Enter your username and password.'); return; }
        var btn = $('vLoginBtn');
        spin(btn, true, 'Checking…');
        loginAlert('');
        api('login', { username: u, password: p }).then(function (r) {
            ticket = r.ticket;
            $('vOtpHint').textContent = r.emailHint || 'your email';
            $('vLoginForm').hidden = true;
            $('vOtpForm').hidden = false;
            $('vOtp').value = '';
            setTimeout(function () { $('vOtp').focus(); }, 50);
        }).catch(function (err) { loginAlert(err.message); })
            .then(function () { spin(btn, false); });
    });
    $('vOtp').addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
        if (this.value.length === 6) $('vOtpForm').requestSubmit ? $('vOtpForm').requestSubmit() : $('vOtpBtn').click();
    });
    $('vOtpForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var code = $('vOtp').value.trim();
        if (code.length !== 6) { loginAlert('Enter the 6-digit code from the email.'); return; }
        var btn = $('vOtpBtn');
        if (btn.disabled) return;
        spin(btn, true, 'Signing in…');
        loginAlert('');
        api('verifyOtp', { ticket: ticket, code: code }).then(function (r) {
            S.token = r.token; S.user = r.user;
            try { sessionStorage.setItem(KEY, JSON.stringify({ t: r.token, u: r.user })); } catch (e2) {}
            boot();
        }).catch(function (err) {
            loginAlert(err.message);
            if (/sign in again/i.test(err.message)) { $('vOtpForm').hidden = true; $('vLoginForm').hidden = false; }
            else { $('vOtp').select(); }
        }).then(function () { spin(btn, false); });
    });
    $('vOtpBack').addEventListener('click', function () {
        $('vOtpForm').hidden = true; $('vLoginForm').hidden = false; loginAlert(''); $('vPass').value = ''; $('vUser').focus();
    });
    $('vSignOut').addEventListener('click', function () {
        if (activeWork() && !window.confirm('Uploads or moves are still running. Sign out anyway?')) return;
        api('logout').catch(function () {});
        endSession('You have signed out.');
    });

    /* Eye buttons on password fields */
    document.addEventListener('click', function (e) {
        var b = e.target.closest('[data-eye]');
        if (!b) return;
        var input = $(b.getAttribute('data-eye'));
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.innerHTML = '<i class="far ' + (show ? 'fa-eye-slash' : 'fa-eye') + '"></i>';
        b.setAttribute('aria-label', show ? 'Hide' : 'Show');
        input.focus();
    });

    /* ---------------------------------------------------------------
       App shell
       --------------------------------------------------------------- */
    var TITLES = { files: 'Files', storage: 'Storage', backup: 'Server backup', activity: 'Activity', settings: 'Settings' };

    function boot() {
        $('vLogin').hidden = true;
        $('vApp').hidden = false;
        $('vUserName').textContent = S.user;
        var v = (location.hash || '').replace('#', '');
        show(TITLES[v] ? v : S.view);
        refreshAll();
    }

    function refreshAll() {
        return Promise.all([loadOverview(), loadClients()]).then(function () {
            S.loaded = true;
            render();
        }).catch(function (err) { if (err.code !== 'AUTH') toast(err.message, true); });
    }
    function loadOverview() {
        return api('overview').then(function (r) {
            S.drives = r.drives.sort(function (a, b) { return a.order - b.order; });
            S.settings = r.settings || S.settings;
            S.backup = r.backup || S.backup;
            S.passes = r.passes || {};
            renderCapacity();
            if (window.SAVBackup) window.SAVBackup.onOverview();
        });
    }
    function loadClients() {
        return api('clients').then(function (r) {
            S.clients = r.clients;
            if (S.client) S.client = S.clients.filter(function (c) { return c.id === S.client.id; })[0] || null;
        });
    }

    function show(view) {
        S.view = view;
        document.querySelectorAll('.v-nav-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
        document.querySelectorAll('.v-view').forEach(function (s) { s.hidden = s.id !== 'view-' + view; });
        $('vTopTitle').textContent = TITLES[view];
        if (history.replaceState) history.replaceState(null, '', '#' + view);
        $('vApp').classList.remove('nav-open');
        render();
        if (view === 'activity') loadActivity();
        window.scrollTo(0, 0);
    }
    function render() {
        if (S.view === 'files') renderFiles();
        else if (S.view === 'storage') renderStorage();
        else if (S.view === 'settings') renderSettings();
        else if (S.view === 'backup' && window.SAVBackup) window.SAVBackup.render();
    }

    document.querySelectorAll('.v-nav-btn').forEach(function (b) {
        b.addEventListener('click', function () {
            if (b.dataset.view === 'files' && S.view === 'files' && S.client) { S.client = null; S.path = []; }
            show(b.dataset.view);
            if (b.dataset.view === 'storage') loadOverview().then(render).catch(function () {});
        });
    });
    $('vMenu').addEventListener('click', function () { $('vApp').classList.toggle('nav-open'); });
    $('vScrim').addEventListener('click', function () { $('vApp').classList.remove('nav-open'); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (!$('vModal').hidden && !modalLocked) closeModal(undefined);
            $('vApp').classList.remove('nav-open');
        }
    });
    $('vModal').addEventListener('click', function (e) { if (e.target === this && !modalLocked) closeModal(undefined); });

    function totals() {
        var t = { limit: 0, used: 0, vault: 0 };
        S.drives.forEach(function (d) { t.limit += d.limit; t.used += d.used; t.vault += d.vaultBytes; });
        t.free = Math.max(0, t.limit - t.used);
        t.pct = t.limit ? t.used / t.limit * 100 : 0;
        return t;
    }
    function renderCapacity() {
        var t = totals();
        $('vCapPct').textContent = S.drives.length ? pct(t.pct) : '—';
        $('vCapBar').style.width = Math.min(100, t.pct) + '%';
        $('vCapText').textContent = S.drives.length ? gb(t.free) + ' free of ' + gb(t.limit) + ' · ' + S.drives.length + ' drive' + (S.drives.length === 1 ? '' : 's')
            : 'No drives connected yet';
    }
    /* First drive, in priority order, that would take a new client right now */
    function nextDrive() {
        return S.drives.filter(function (d) { return d.status === 'active' && d.online && (!d.limit || d.pct < S.settings.threshold); })[0];
    }

    /* ---------------------------------------------------------------
       Files view
       --------------------------------------------------------------- */
    $('vSearch').addEventListener('input', function () { S.search = this.value.trim().toLowerCase(); renderFilesBody(); });
    $('vSort').addEventListener('change', function () { S.fileSort = this.value; renderFilesBody(); });

    function currentFolderId() { return S.path.length ? S.path[S.path.length - 1].id : (S.client && S.client.folderId); }

    function openClient(c) {
        if (c.status === 'missing') { toast('This folder was not found on its drive. Rescan drives, or forget it from the list.', true); return; }
        S.client = c;
        S.path = [];
        S.fsel = {};
        S.search = ''; $('vSearch').value = '';
        if (S.view !== 'files') show('files'); else renderFiles();
        loadItems();
    }
    function openFolder(item) {
        S.path.push({ id: item.id, name: item.name });
        S.fsel = {};
        S.search = ''; $('vSearch').value = '';
        renderFiles();
        loadItems();
    }
    function goCrumb(i) {
        if (i < 0) { S.client = null; S.path = []; }
        else S.path = S.path.slice(0, i);
        S.fsel = {};
        S.search = ''; $('vSearch').value = '';
        renderFiles();
        if (S.client) loadItems();
    }
    function loadItems() {
        var c = S.client, fid = currentFolderId();
        S.items = []; S.itemsFor = '';
        renderFilesBody(true);
        return listFolder(c, fid).then(function (items) {
            if (!S.client || S.client.id !== c.id || currentFolderId() !== fid) return;
            S.items = items; S.itemsFor = fid;
            renderFilesBody();
        }).catch(function (err) {
            if (currentFolderId() !== fid) return;
            $('vFiles').innerHTML = '<div class="v-empty"><i class="fas fa-triangle-exclamation"></i><strong>Could not open this folder</strong>' + esc(err.message) +
                '<div class="v-row" style="justify-content:center"><button class="v-btn v-btn--ghost v-btn--sm" data-retry>Try again</button></div></div>';
            var b = $('vFiles').querySelector('[data-retry]'); if (b) b.onclick = loadItems;
        });
    }

    function renderFiles() {
        renderOffice();                                   // the Office data card shows on the client list only
        var crumbs = $('vCrumbs'), meta = $('vFilesMeta'), acts = $('vFileActions');
        crumbs.innerHTML = ''; meta.innerHTML = ''; acts.innerHTML = '';
        if (!S.client) {
            crumbs.innerHTML = '<span class="cur"><i class="fas fa-folder-tree" style="color:var(--teal);margin-right:.4rem"></i>All clients</span>';
            var cl = clientsOnly();
            var size = cl.reduce(function (a, c) { return a + c.sizeBytes; }, 0);
            meta.textContent = S.loaded ? cl.length + ' client folder' + (cl.length === 1 ? '' : 's') + ' · ' + bytes(size) : '';
            $('vSearch').placeholder = 'Search client folders';
            acts.appendChild(el('<button class="v-btn v-btn--ghost" id="vUpFolder" title="Each folder you upload becomes a client folder"><i class="fas fa-folder-open"></i> Upload folder</button>'));
            acts.appendChild(el('<button class="v-btn v-btn--ghost" id="vUpFiles" title="You choose the client the files go to"><i class="fas fa-cloud-arrow-up"></i> Upload files</button>'));
            acts.appendChild(el('<button class="v-btn" id="vNewClient"><i class="fas fa-folder-plus"></i> New client</button>'));
            $('vNewClient').onclick = newClient;
            $('vUpFiles').onclick = function () { pickFiles(false); };
            $('vUpFolder').onclick = function () { pickFiles(true); };
        } else {
            var home = el('<button type="button"><i class="fas fa-folder-tree"></i> ' + (S.client.kind === 'office' ? 'Home' : 'All clients') + '</button>');
            home.onclick = function () { goCrumb(-1); };
            crumbs.appendChild(home);
            var trail = [{ name: S.client.name }].concat(S.path);
            trail.forEach(function (p, i) {
                crumbs.appendChild(el('<span class="sep"><i class="fas fa-chevron-right"></i></span>'));
                if (i === trail.length - 1) crumbs.appendChild(el('<span class="cur">' + esc(p.name) + '</span>'));
                else { var b = el('<button type="button">' + esc(p.name) + '</button>'); b.onclick = function () { goCrumb(i); }; crumbs.appendChild(b); }
            });
            var c = S.client;
            meta.innerHTML = '<span class="v-badge"><i class="fas fa-hard-drive"></i> ' + esc(driveLabel(c.driveId)) + '</span>' +
                '<span>' + bytes(c.sizeBytes) + ' · ' + c.files + ' file' + (c.files === 1 ? '' : 's') + '</span>' +
                (c.status === 'moving' ? '<span class="v-badge warn"><i class="fas fa-right-left"></i> Moving</span>' : '') +
                '<a class="v-link" href="https://drive.google.com/drive/folders/' + encodeURIComponent(currentFolderId()) + '" target="_blank" rel="noopener">Open in Google Drive</a>';
            $('vSearch').placeholder = 'Search this folder';
            var moving = c.status === 'moving';
            acts.appendChild(el('<button class="v-btn v-btn--ghost" id="vNewFolder"' + (moving ? ' disabled' : '') + '><i class="fas fa-folder-plus"></i> New folder</button>'));
            acts.appendChild(el('<button class="v-btn v-btn--ghost" id="vUpFolder"' + (moving ? ' disabled' : '') + '><i class="fas fa-folder-open"></i> Upload folder</button>'));
            acts.appendChild(el('<button class="v-btn" id="vUpFiles"' + (moving ? ' disabled' : '') + '><i class="fas fa-cloud-arrow-up"></i> Upload files</button>'));
            $('vNewFolder').onclick = newFolder;
            $('vUpFiles').onclick = function () { pickFiles(false); };
            $('vUpFolder').onclick = function () { pickFiles(true); };
        }
        renderFilesBody(S.client && S.itemsFor !== currentFolderId());
    }

    function sortList(list, isItems) {
        var key = S.fileSort;
        return list.slice().sort(function (a, b) {
            if (isItems && a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
            if (key === 'size') return (isItems ? b.size - a.size : b.sizeBytes - a.sizeBytes) || byName(a, b);
            if (key === 'updated') return String(isItems ? b.modified : b.updatedAt).localeCompare(String(isItems ? a.modified : a.updatedAt)) || byName(a, b);
            return byName(a, b);
        });
    }

    function renderFilesBody(loading) {
        var box = $('vFiles');
        if (loading || !S.loaded) { box.innerHTML = '<div class="v-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>'; return; }
        var q = S.search;
        if (!S.client) {
            renderOffice();
            var list = sortList(clientsOnly().filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0; }), false);
            if (!clientsOnly().length) {
                box.innerHTML = '<div class="v-empty"><i class="fas fa-folder-plus"></i><strong>No client folders yet</strong>' +
                    (S.drives.length ? 'Create the first one with <em>New client</em>. It will go to ' + esc((nextDrive() || {}).label || 'the first drive with room') + '.'
                        : 'Connect a drive in Settings first.') + '</div>';
                return;
            }
            if (!list.length) { box.innerHTML = '<div class="v-empty"><i class="fas fa-magnifying-glass"></i><strong>No match</strong>No client folder matches “' + esc(q) + '”.</div>'; return; }
            var rows = list.map(function (c) {
                var badge = c.status === 'moving' ? ' <span class="v-badge warn">Moving</span>' : c.status === 'missing' ? ' <span class="v-badge bad">Not found</span>' : '';
                return '<tr data-id="' + esc(c.id) + '">' +
                    '<td class="chk"><input type="checkbox" data-sel aria-label="Select ' + esc(c.name) + '"' + (S.fsel[c.id] ? ' checked' : '') + (c.status !== 'ok' ? ' disabled' : '') + '></td>' +
                    '<td><button class="v-name" data-open><span class="v-ico"><i class="fas fa-folder"></i></span><span>' + esc(c.name) + '</span></button></td>' +
                    '<td class="hide-xs"><span class="v-badge idle">' + esc(driveLabel(c.driveId)) + '</span>' + badge + '</td>' +
                    '<td class="num">' + bytes(c.sizeBytes) + '</td>' +
                    '<td class="num hide-sm">' + c.files + '</td>' +
                    '<td class="dim hide-sm">' + date(c.updatedAt) + '</td>' +
                    '<td><div class="v-acts">' +
                    (c.status === 'missing' ? '<button class="v-act del" data-forget title="Forget"><i class="fas fa-eraser"></i></button>' :
                        '<button class="v-act" data-rename title="Rename"><i class="fas fa-pen"></i></button>' +
                        '<button class="v-act del" data-delete title="Delete"><i class="fas fa-trash-can"></i></button>') +
                    '</div></td></tr>';
            }).join('');
            box.innerHTML = '<div class="v-scroll"><table class="v-list"><thead><tr>' + selAllTh(list.filter(function (c) { return c.status === 'ok'; })) + '<th>Client</th><th class="hide-xs">Drive</th><th class="num">Size</th>' +
                '<th class="num hide-sm">Files</th><th class="hide-sm">Updated</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
            box.querySelectorAll('tr[data-id]').forEach(function (tr) {
                var c = S.clients.filter(function (x) { return x.id === tr.dataset.id; })[0];
                var on = function (sel, fn) { var b = tr.querySelector(sel); if (b) b.onclick = function () { fn(c); }; };
                on('[data-open]', openClient); on('[data-rename]', renameClient); on('[data-delete]', deleteClient); on('[data-forget]', forgetClient);
                bindSel(tr, { kind: 'client', id: c.id, clientId: c.id, name: c.name, size: c.sizeBytes });
            });
            bindSelAll(box, list.filter(function (c) { return c.status === 'ok'; }).map(function (c) {
                return { kind: 'client', id: c.id, clientId: c.id, name: c.name, size: c.sizeBytes };
            }));
            updateFSelBar();
            return;
        }
        var items = sortList(S.items.filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) >= 0; }), true);
        if (!S.items.length) {
            box.innerHTML = '<div class="v-empty"><i class="fas fa-cloud-arrow-up"></i><strong>This folder is empty</strong>Drag files here, or use <em>Upload files</em>.</div>';
            return;
        }
        if (!items.length) { box.innerHTML = '<div class="v-empty"><i class="fas fa-magnifying-glass"></i><strong>No match</strong>Nothing here matches “' + esc(q) + '”.</div>'; return; }
        var html = items.map(function (it) {
            var ic = fileIcon(it);
            var name = it.isFolder
                ? '<button class="v-name" data-open><span class="v-ico"><i class="fas fa-folder"></i></span><span>' + esc(it.name) + '</span></button>'
                : '<a class="v-name" href="' + esc(openUrl(it)) + '" target="_blank" rel="noopener"><span class="v-ico ' + ic[0] + '"><i class="fas ' + ic[1] + '"></i></span><span>' + esc(it.name) + '</span></a>';
            return '<tr data-id="' + esc(it.id) + '"><td class="chk"><input type="checkbox" data-sel aria-label="Select ' + esc(it.name) + '"' + (S.fsel[it.id] ? ' checked' : '') + '></td><td>' + name + '</td>' +
                '<td class="num">' + (it.isFolder ? '—' : bytes(it.size)) + '</td>' +
                '<td class="dim hide-xs">' + date(it.modified) + '</td>' +
                '<td><div class="v-acts">' +
                (it.isFolder ? '' : '<a class="v-act" href="' + esc(openUrl(it)) + '" target="_blank" rel="noopener" title="Open"><i class="fas fa-arrow-up-right-from-square"></i></a>' +
                    (isGoogleDoc(it) ? '' : '<a class="v-act" href="' + esc(downloadUrl(it)) + '" target="_blank" rel="noopener" title="Download"><i class="fas fa-download"></i></a>')) +
                '<button class="v-act" data-rename title="Rename"><i class="fas fa-pen"></i></button>' +
                '<button class="v-act del" data-delete title="Delete"><i class="fas fa-trash-can"></i></button>' +
                '</div></td></tr>';
        }).join('');
        box.innerHTML = '<div class="v-scroll"><table class="v-list"><thead><tr>' + selAllTh(items) + '<th>Name</th><th class="num">Size</th><th class="hide-xs">Modified</th><th></th></tr></thead><tbody>' + html + '</tbody></table></div>';
        var cl = S.client;
        var selOf = function (it) { return { kind: it.isFolder ? 'folder' : 'file', id: it.id, clientId: cl.id, name: it.name, size: it.size || 0 }; };
        box.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var it = S.items.filter(function (x) { return x.id === tr.dataset.id; })[0];
            var on = function (sel, fn) { var b = tr.querySelector(sel); if (b) b.onclick = function () { fn(it); }; };
            on('[data-open]', openFolder); on('[data-rename]', renameItem); on('[data-delete]', deleteItem);
            bindSel(tr, selOf(it));
        });
        bindSelAll(box, items.map(selOf));
        updateFSelBar();
    }

    /* Ticking files, folders or clients (to send them to the office server) */
    function selAllTh(list) {
        var all = list.length && list.every(function (x) { return S.fsel[x.id]; });
        return '<th class="chk"><input type="checkbox" data-selall aria-label="Select all shown"' + (all ? ' checked' : '') + (list.length ? '' : ' disabled') + '></th>';
    }
    function bindSel(tr, info) {
        var cb = tr.querySelector('[data-sel]');
        if (!cb) return;
        cb.onchange = function () { if (cb.checked) S.fsel[info.id] = info; else delete S.fsel[info.id]; updateFSelBar(); };
    }
    function bindSelAll(box, infos) {
        var cb = box.querySelector('[data-selall]');
        if (!cb) return;
        cb.onchange = function () {
            infos.forEach(function (i) { if (cb.checked) S.fsel[i.id] = i; else delete S.fsel[i.id]; });
            renderFilesBody();
        };
    }
    function updateFSelBar() {
        var list = Object.keys(S.fsel).map(function (k) { return S.fsel[k]; });
        $('vFSelBar').hidden = !list.length;
        if (!list.length) return;
        var size = list.reduce(function (a, x) { return a + (x.size || 0); }, 0);
        $('vFSelText').textContent = list.length + ' selected' + (size ? ' · ' + bytes(size) : '');
    }
    $('vFSelClear').addEventListener('click', function () { S.fsel = {}; renderFilesBody(); });
    $('vFSend').addEventListener('click', function () {
        var list = Object.keys(S.fsel).map(function (k) { return S.fsel[k]; });
        if (!list.length) return;
        if (!window.SAVBackup) { toast('Server backup is not available on this page.', true); return; }
        window.SAVBackup.sendSelected(list);
    });

    /* The office's own space (studies, payment records, ledgers, formats) — kept apart from clients */
    function officeSpace() { return S.clients.filter(function (c) { return c.kind === 'office'; })[0]; }
    function clientsOnly() { return S.clients.filter(function (c) { return c.kind !== 'office'; }); }
    function renderOffice() {
        var box = $('vOffice');
        if (!box) return;
        box.hidden = !S.loaded || !!S.client;
        if (box.hidden) return;
        var o = officeSpace();
        if (!o) {
            box.innerHTML = '<div class="v-office-ico"><i class="fas fa-building"></i></div><div class="v-office-text"><strong>Office data</strong>' +
                '<span>A separate space for the office’s own files: studies, payment records, ledgers and formats. Kept apart from client folders.</span></div>' +
                '<button class="v-btn v-btn--ghost" id="vOfficeMake"><i class="fas fa-plus"></i> Set up office space</button>';
            $('vOfficeMake').onclick = function () {
                var b = this; spin(b, true, 'Creating…');
                api('createOffice', {}).then(function (r) {
                    S.clients.push(r.client); toast('Office space created on ' + (r.drive || driveLabel(r.client.driveId)) + '.');
                    loadOverview().catch(function () {}); openClient(r.client);
                }).catch(function (err) { toast(err.message, true); spin(b, false); });
            };
            return;
        }
        box.innerHTML = '<div class="v-office-ico"><i class="fas fa-building"></i></div><div class="v-office-text"><strong>Office data</strong>' +
            '<span>' + bytes(o.sizeBytes) + ' · ' + o.files + ' file' + (o.files === 1 ? '' : 's') + ' · ' + esc(driveLabel(o.driveId)) +
            (o.status === 'moving' ? ' · moving' : '') + '</span></div>' +
            '<button class="v-btn" id="vOfficeOpen"><i class="fas fa-folder-open"></i> Open</button>';
        $('vOfficeOpen').onclick = function () { openClient(o); };
    }

    function newClient() {
        if (!S.drives.length) { toast('Connect a drive in Settings first.', true); return; }
        var nd = nextDrive();
        promptBox('New client folder', 'Client name', '', 'Create',
            nd ? 'It will be created on <strong>' + esc(nd.label) + '</strong>, the first drive below ' + S.settings.threshold + '% right now.' : 'The vault will check each drive for room.')
            .then(function (name) {
                if (!name) return;
                var b = $('vNewClient'); spin(b, true, 'Creating…');
                return api('createClient', { name: name }).then(function (r) {
                    S.clients.push(r.client);
                    toast('“' + r.client.name + '” created on ' + r.drive + '.');
                    loadOverview().catch(function () {});
                    openClient(r.client);
                }).catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
            });
    }
    function renameClient(c) {
        promptBox('Rename client folder', 'New name', c.name, 'Rename').then(function (name) {
            if (!name || name === c.name) return;
            return api('renameClient', { clientId: c.id, name: name }).then(function () {
                c.name = name; toast('Renamed to “' + name + '”.'); render();
            }).catch(function (err) { toast(err.message, true); });
        });
    }
    function deleteClient(c) {
        var wrap = el('<div><p>This moves <strong>' + esc(c.name) + '</strong> (' + bytes(c.sizeBytes) + ', ' + c.files + ' files) to the <strong>vault trash</strong>. ' +
            'You can restore it from Storage → Vault trash for 30 days, after which Google empties it.</p><label class="v-label" for="vConfirmName">Type the name to confirm</label>' +
            '<input class="v-input" id="vConfirmName" autocomplete="off"></div>');
        var input = wrap.querySelector('input');
        modal({ title: 'Delete client folder?', body: wrap, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: null },
            { label: '<i class="fas fa-trash-can"></i> Delete', cls: 'v-btn--danger', value: function () { return input.value.trim(); },
                onClick: function () { if (input.value.trim().toLowerCase() !== c.name.toLowerCase()) { input.focus(); toast('The name does not match.', true); return false; } } }
        ] }).then(function (typed) {
            if (!typed) return;
            return api('deleteClient', { clientId: c.id, confirm: typed }).then(function () {
                S.clients = S.clients.filter(function (x) { return x.id !== c.id; });
                toast('“' + c.name + '” moved to the vault trash. You can restore it from the Storage page.');
                loadOverview().catch(function () {});
                render();
            }).catch(function (err) { toast(err.message, true); });
        });
    }
    function forgetClient(c) {
        confirmBox('Forget this folder?', '<strong>' + esc(c.name) + '</strong> was not found on ' + esc(driveLabel(c.driveId)) +
            '. Forgetting removes it from this list only. If it still exists somewhere, Rescan drives will bring it back.', 'Forget', true)
            .then(function (ok) {
                if (!ok) return;
                return api('deleteClient', { clientId: c.id }).then(function () {
                    S.clients = S.clients.filter(function (x) { return x.id !== c.id; }); render();
                }).catch(function (err) { toast(err.message, true); });
            });
    }
    function newFolder() {
        promptBox('New folder', 'Folder name', '', 'Create').then(function (name) {
            if (!name) return;
            return makeFolder(S.client, currentFolderId(), name, false).then(function () {
                toast('Folder created.'); loadItems();
            }).catch(function (err) { toast(err.message, true); });
        });
    }
    function renameItem(it) {
        promptBox('Rename', 'New name', it.name, 'Rename').then(function (name) {
            if (!name || name === it.name) return;
            return api('renameItem', { clientId: S.client.id, id: it.id, name: name }).then(function () {
                it.name = name; renderFilesBody(); toast('Renamed.');
            }).catch(function (err) { toast(err.message, true); });
        });
    }
    function deleteItem(it) {
        confirmBox('Delete ' + (it.isFolder ? 'folder' : 'file') + '?', '<strong>' + esc(it.name) + '</strong>' + (it.isFolder ? ' and everything inside it' : '') +
            ' will go to the vault trash. You can restore it from Storage → Vault trash for 30 days.', '<i class="fas fa-trash-can"></i> Delete', true)
            .then(function (ok) {
                if (!ok) return;
                var c = S.client;
                return api('deleteItem', { clientId: c.id, id: it.id, name: it.name }).then(function () {
                    S.items = S.items.filter(function (x) { return x.id !== it.id; });
                    if (!it.isFolder) { c.sizeBytes = Math.max(0, c.sizeBytes - it.size); c.files = Math.max(0, c.files - 1); }
                    else refreshClientSize(c);
                    renderFiles(); toast('Moved to the vault trash.');
                }).catch(function (err) { toast(err.message, true); });
            });
    }
    function refreshClientSize(c) {
        return api('refreshSize', { clientId: c.id }).then(function (r) {
            c.sizeBytes = r.sizeBytes; c.files = r.files; c.updatedAt = new Date().toISOString();
            if (S.view === 'files') renderFiles();
        }).catch(function () {});
    }

    /* ---------------------------------------------------------------
       Uploads
       --------------------------------------------------------------- */
    var queue = [], running = 0, upSeq = 0;

    function pickFiles(folder) {
        var input = $('vFileInput');
        input.value = '';
        if (folder) input.setAttribute('webkitdirectory', ''); else input.removeAttribute('webkitdirectory');
        input.click();
    }
    $('vFileInput').addEventListener('change', function () {
        var list = Array.prototype.map.call(this.files, function (f) {
            var parts = (f.webkitRelativePath || '').split('/').filter(Boolean);
            return { file: f, dirs: parts.slice(0, -1) };
        });
        if (S.client) enqueue(list); else homeUpload(list);
        this.value = '';
    });

    /* Drag and drop (files and whole folders) */
    var dragDepth = 0;
    function canDrop() { return S.view === 'files' && !$('vApp').hidden && (!S.client || S.client.status !== 'moving'); }
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
    window.addEventListener('dragenter', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        if (canDrop()) {
            $('vDropText').textContent = !S.client ? 'Drop client folders here' : 'Drop to upload to ' + (S.path.length ? S.path[S.path.length - 1].name : S.client.name);
            $('vDrop').classList.add('show');
        }
    });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = canDrop() ? 'copy' : 'none'; } });
    window.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('vDrop').classList.remove('show'); });
    window.addEventListener('drop', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0; $('vDrop').classList.remove('show');
        if (!canDrop()) return;
        var send = S.client ? enqueue : homeUpload;
        var items = e.dataTransfer.items;
        var entries = [];
        if (items && items.length && items[0].webkitGetAsEntry) {
            for (var i = 0; i < items.length; i++) { var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); if (en) entries.push(en); }
        }
        if (!entries.length) { send(Array.prototype.map.call(e.dataTransfer.files, function (f) { return { file: f, dirs: [] }; })); return; }
        var out = [];
        Promise.all(entries.map(function (en) { return walk(en, [], out); })).then(function () { send(out); })
            .catch(function () { toast('Could not read the dropped folder. Try “Upload folder”.', true); });
    });
    function walk(entry, dirs, out) {
        if (entry.isFile) return new Promise(function (res, rej) { entry.file(function (f) { out.push({ file: f, dirs: dirs }); res(); }, rej); });
        if (!entry.isDirectory) return Promise.resolve();
        var reader = entry.createReader(), all = [];
        return new Promise(function (res, rej) {
            (function more() {
                reader.readEntries(function (batch) {
                    if (!batch.length) { Promise.all(all.map(function (c) { return walk(c, dirs.concat(entry.name), out); })).then(res, rej); return; }
                    all = all.concat(Array.prototype.slice.call(batch)); more();
                }, rej);
            })();
        });
    }

    function junk(x) { return !x.file || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(x.file.name) || /^~\$/.test(x.file.name); }
    /* target: { client, baseId } — when not given, the folder that is open */
    function enqueue(list, target) {
        list = list.filter(function (x) { return !junk(x); });
        if (!list.length) return;
        var c = target ? target.client : S.client, base = target ? target.baseId : currentFolderId(), folders = {};
        var where = target ? target.client.name : (S.path.length ? S.path[S.path.length - 1].name : c.name);
        var batch = { listing: {}, policy: null, size: list.length };          // shared by the files of this upload
        list.forEach(function (x) {
            var job = { id: ++upSeq, file: x.file, name: x.file.name, size: x.file.size, client: c, baseId: base, dirs: x.dirs, where: where,
                folderCache: folders, batch: batch, state: 'wait', sent: 0, msg: '' };
            queue.push(job);
        });
        $('vTray').hidden = false;
        renderTray();
        pump();
    }

    /* ---------------------------------------------------------------
       Uploading from the client list.
       Each folder becomes a client folder (or goes into the client with that name).
       Loose files go to a client you choose.
       --------------------------------------------------------------- */
    function homeUpload(list) {
        list = list.filter(function (x) { return !junk(x); });
        if (!list.length) return;
        var loose = list.filter(function (x) { return !x.dirs.length; });
        var inFolders = list.filter(function (x) { return x.dirs.length; });
        var next = function () { if (loose.length) return chooseClientFor(loose); };
        if (!inFolders.length) return next();
        var tops = {};
        inFolders.forEach(function (x) { tops[x.dirs[0]] = 1; });
        var names = Object.keys(tops);
        // One folder picked that only holds folders (e.g. the whole "Clients" folder): ask what it is
        var single = names.length === 1 && inFolders.every(function (x) { return x.dirs.length > 1; });
        var inner = {};
        if (single) inFolders.forEach(function (x) { inner[x.dirs[1]] = 1; });
        var ask = single && Object.keys(inner).length > 1 ? askParentFolder(names[0], Object.keys(inner).length) : Promise.resolve('one');
        return ask.then(function (how) {
            if (!how) return;
            var depth = how === 'each' ? 1 : 0;
            var groups = {}, order = [];
            inFolders.forEach(function (x) {
                var key = x.dirs[depth].trim();
                var k = key.toLowerCase();
                if (!groups[k]) { groups[k] = { name: key, files: [], bytes: 0 }; order.push(k); }
                groups[k].files.push({ file: x.file, dirs: x.dirs.slice(depth + 1) });
                groups[k].bytes += x.file.size;
            });
            return planFolders(order.map(function (k) { return groups[k]; }));
        }).then(next);
    }

    function askParentFolder(name, count) {
        var body = el('<div><p>The folder <strong>' + esc(name) + '</strong> holds ' + count + ' folders and no files of its own. How should it be added?</p>' +
            '<label class="v-check"><input type="radio" name="vParentHow" value="each" checked> Each folder inside it is a client (' + count + ' client folders)</label>' +
            '<label class="v-check"><input type="radio" name="vParentHow" value="one"> “' + esc(name) + '” is one client</label></div>');
        return modal({ title: 'Add these folders', body: body, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: null },
            { label: 'Continue', id: 'vParentGo', value: function () { return body.querySelector('input[name=vParentHow]:checked').value; } }
        ] });
    }

    function planFolders(groups) {
        var byName = {}, office = officeSpace();
        S.clients.forEach(function (c) { if (c.kind !== 'office') byName[c.name.trim().toLowerCase()] = c; });
        groups.forEach(function (g) {
            var k = g.name.toLowerCase();
            g.client = k === 'office data' ? (office || null) : (byName[k] || null);
            g.office = k === 'office data';
            g.blocked = g.client && g.client.status === 'moving' ? 'being moved to another drive; try after the move' :
                g.client && g.client.status === 'missing' ? 'not found on its drive; rescan drives first' : '';
        });
        var adds = groups.filter(function (g) { return !g.client && !g.blocked; }).length;
        var into = groups.filter(function (g) { return g.client && !g.blocked; }).length;
        var total = groups.reduce(function (a, g) { return a + (g.blocked ? 0 : g.bytes); }, 0);
        var nd = nextDrive();
        var rows = groups.map(function (g) {
            var what = g.blocked ? '<span class="v-badge warn">Not uploaded</span> <span class="v-muted v-small">' + esc(g.blocked) + '</span>' :
                g.client ? '<span class="v-badge">Existing</span> <span class="v-muted v-small">added into it on ' + esc(driveLabel(g.client.driveId)) + '</span>' :
                    '<span class="v-badge ok">New ' + (g.office ? 'office space' : 'client') + '</span>';
            return '<tr><td><i class="fas fa-folder" style="color:var(--gold);margin-right:.4rem"></i>' + esc(g.name) + '</td><td class="num">' +
                g.files.length.toLocaleString('en-IN') + ' file' + (g.files.length === 1 ? '' : 's') + '</td><td class="num">' + bytes(g.bytes) + '</td><td>' + what + '</td></tr>';
        }).join('');
        var body = '<p>' + (adds ? adds + ' new client folder' + (adds === 1 ? '' : 's') + ' will be created' : '') + (adds && into ? ', and ' : '') +
            (into ? into + ' existing client folder' + (into === 1 ? '' : 's') + ' will get the new files' : '') + ' (' + bytes(total) + ').</p>' +
            '<div class="v-plan-wrap"><table class="v-plan-table"><thead><tr><th>Folder</th><th class="num">Files</th><th class="num">Size</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            '<p class="v-small v-muted">' + (adds ? 'New clients go to ' + (nd ? '<strong>' + esc(nd.label) + '</strong> first (the first drive below ' + S.settings.threshold + '%), then the next drive with room. ' : 'the first drive with room. ') : '') +
            (into ? 'A file that already exists in a client asks you to Replace, Keep both or Skip. Nothing is deleted.' : 'Nothing is deleted.') + '</p>';
        if (!adds && !into) return modal({ title: 'Nothing can be uploaded', body: body, wide: true, actions: [{ label: 'Close', value: true }] });
        return modal({ title: 'Upload ' + groups.length + ' folder' + (groups.length === 1 ? '' : 's') + ' to the vault?', body: body, wide: true, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: '<i class="fas fa-cloud-arrow-up"></i> Upload', id: 'vHomeUpGo', value: true }
        ] }).then(function (go) {
            if (!go) return;
            var pending = {}, made = 0, failed = [];
            return groups.filter(function (g) { return !g.blocked; }).reduce(function (p, g) {
                return p.then(function () {
                    if (g.client) return g.client;
                    return api(g.office ? 'createOffice' : 'createClient', { name: g.name, sizeHint: g.bytes, pending: pending }).then(function (r) {
                        if (!r.existed) S.clients.push(r.client);
                        made++;
                        return r.client;
                    });
                }).then(function (c) {
                    pending[c.driveId] = (pending[c.driveId] || 0) + g.bytes;
                    enqueue(g.files, { client: c, baseId: c.folderId });
                }).catch(function (err) { failed.push(g.name + ': ' + err.message); });
            }, Promise.resolve()).then(function () {
                if (made) loadOverview().catch(function () {});
                if (failed.length) toast('Not uploaded — ' + failed.join(' · '), true);
                render();
            });
        });
    }

    function chooseClientFor(files) {
        var size = files.reduce(function (a, x) { return a + x.file.size; }, 0);
        var list = clientsOnly().filter(function (c) { return c.status === 'ok'; }).sort(byName);
        var office = officeSpace();
        var opts = '<option value="">Choose a client…</option>' +
            (office && office.status === 'ok' ? '<option value="' + esc(office.id) + '">Office data</option>' : '') +
            '<optgroup label="Clients">' + list.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('') + '</optgroup>' +
            '<option value="+new">+ New client…</option>';
        var body = el('<div><p>' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' (' + bytes(size) + ') will go into the main folder of the client you choose.</p>' +
            '<label class="v-label" for="vUpTo">Client</label><select class="v-input" id="vUpTo">' + opts + '</select>' +
            '<div id="vUpNewWrap" hidden><label class="v-label" for="vUpNew">New client name</label><input class="v-input" id="vUpNew" autocomplete="off"></div>' +
            '<p class="v-small v-muted">To put them in a sub-folder, open the client and upload there instead.</p></div>');
        var sel = body.querySelector('#vUpTo'), nw = body.querySelector('#vUpNew');
        sel.onchange = function () { body.querySelector('#vUpNewWrap').hidden = sel.value !== '+new'; if (sel.value === '+new') nw.focus(); };
        return modal({ title: 'Upload to which client?', body: body, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: null },
            { label: '<i class="fas fa-cloud-arrow-up"></i> Upload', id: 'vUpToGo', value: function () { return sel.value === '+new' ? { name: nw.value.trim() } : { id: sel.value }; },
                onClick: function () {
                    if (!sel.value) { sel.focus(); toast('Choose a client.', true); return false; }
                    if (sel.value === '+new' && !nw.value.trim()) { nw.focus(); toast('Type the new client’s name.', true); return false; }
                } }
        ] }).then(function (pick) {
            if (!pick) return;
            var get = pick.id ? Promise.resolve(S.clients.filter(function (c) { return c.id === pick.id; })[0]) :
                api('createClient', { name: pick.name, sizeHint: size }).then(function (r) {
                    S.clients.push(r.client); toast('“' + r.client.name + '” created on ' + r.drive + '.'); loadOverview().catch(function () {}); return r.client;
                });
            return get.then(function (c) { enqueue(files, { client: c, baseId: c.folderId }); render(); })
                .catch(function (err) { toast(err.message, true); });
        });
    }

    function pump() {
        while (running < PARALLEL) {
            var job = queue.filter(function (j) { return j.state === 'wait'; })[0];
            if (!job) break;
            running++;
            job.state = 'run';
            runJob(job).then(function (j) { j.state = 'done'; }, function (err) {
                this.state = 'err'; this.msg = err.message || 'Upload failed';
            }.bind(job)).then(function () {
                running--;
                renderTray();
                pump();
                if (!running && !queue.some(function (j) { return j.state === 'wait'; })) uploadsFinished();
            });
        }
        renderTray();
    }

    function ensureFolder(job) {
        if (!job.dirs.length) return Promise.resolve(job.baseId);
        var key = '', parent = Promise.resolve(job.baseId);
        job.dirs.forEach(function (name) {
            key += '/' + name;
            var k = key;
            parent = parent.then(function (pid) {
                if (!job.folderCache[k]) {
                    job.folderCache[k] = makeFolder(job.client, pid, name, true).then(function (r) { return r.id; });
                    job.folderCache[k].catch(function () { delete job.folderCache[k]; });
                }
                return job.folderCache[k];
            });
        });
        return parent;
    }

    /* Files already in a folder (listed once per upload) */
    function folderListing(batch, client, folderId) {
        if (!batch.listing[folderId]) {
            batch.listing[folderId] = (S.client && S.client.id === client.id && S.itemsFor === folderId)
                ? Promise.resolve(S.items.slice())
                : listFolder(client, folderId);
            batch.listing[folderId].catch(function () { delete batch.listing[folderId]; });
        }
        return batch.listing[folderId];
    }

    /* A file with the same name is already there: Replace (default), Keep both, or Skip.
       Questions are asked one at a time; "do the same for the others" answers the rest. */
    var askChain = Promise.resolve();
    function askConflict(job, existing) {
        var ask = askChain.then(function () {
            if (job.batch.policy) return job.batch.policy;
            var more = job.batch.size > 1;
            var body = el('<div><p>A file named <strong>' + esc(existing.name) + '</strong> is already in <strong>' +
                esc(job.dirs.length ? job.dirs[job.dirs.length - 1] : job.where) + '</strong>' +
                ' (' + bytes(existing.size) + ', changed ' + date(existing.modified) + ').</p>' +
                '<p class="v-small v-muted"><strong>Replace</strong> updates that file with your new version. Nothing is lost: Google Drive keeps the previous version ' +
                'in its version history, and the next server backup keeps the old server copy in “SA Vault - replaced files”.</p>' +
                (more ? '<label class="v-check"><input type="checkbox" id="vConflictAll"> Do the same for the other files in this upload that already exist</label>' : '') + '</div>');
            var all = body.querySelector('#vConflictAll');
            var pick = function (v) { return function () { if (all && all.checked) job.batch.policy = v; return v; }; };
            return modal({ title: 'This file already exists', body: body, actions: [
                { label: 'Skip', cls: 'v-btn--ghost', value: pick('skip') },
                { label: 'Keep both', cls: 'v-btn--ghost', value: pick('both') },
                { label: '<i class="fas fa-file-arrow-up"></i> Replace', id: 'vConflictReplace', value: pick('replace') }
            ] }).then(function (v) { return v || 'skip'; });
        });
        askChain = ask.catch(function () {});
        return ask;
    }

    function runJob(job) {
        var c = job.client;
        return ensureFolder(job).then(function (folderId) {
            job.folderId = folderId;
            if (job.choice) return job.choice;                     // a retry keeps the earlier answer
            return folderListing(job.batch, c, folderId).then(function (items) {
                var same = items.filter(function (i) { return !i.isFolder && !isGoogleDoc(i) && i.name.toLowerCase() === job.name.toLowerCase(); })[0];
                if (!same) return 'new';
                job.existing = same;
                job.state = 'ask'; renderTray();
                return askConflict(job, same).then(function (v) { job.choice = v; job.state = 'run'; renderTray(); return v; });
            });
        }).then(function (choice) {
            if (choice === 'skip') { job.skipped = true; return; }
            if (choice === 'replace') {
                return uploadOne({ client: c, folderId: job.folderId, file: job.file, name: job.existing.name, fileId: job.existing.id, oldSize: job.existing.size,
                    onProgress: function (sent) { job.sent = sent; renderTrayThrottled(); } })
                    .then(function (r) { c.sizeBytes += (r.size || 0) - (job.existing.size || 0); c.updatedAt = new Date().toISOString(); job.replaced = true; });
            }
            return uploadNew(job).then(function () {
                job.batch.listing[job.folderId] && job.batch.listing[job.folderId].then(function (l) { l.push({ name: job.name, isFolder: false, id: 'new', size: job.size }); });
            });
        }).then(function () { return job; });
    }
    function uploadNew(job) {
        var c = job.client, folderId = job.folderId;
        if (job.size && direct(c)) {
            return sessionFor(c, { folderId: folderId, name: job.name, size: job.size, mimeType: job.file.type || 'application/octet-stream' })
                .then(function (url) { return inSlot(function () { return resumable(job, url); }); })
                .then(function (f) { var size = Number(f.size) || job.size; bump(c, size); pendSize(c, size, 1); }, function (err) {
                    if (err.network && job.sent === 0 && job.size <= SMALL_LIMIT) return small(job);   // browser blocked the direct path
                    throw err;
                });
        }
        return Promise.resolve().then(function () {
            if (!job.size) return small(job);
            return api('startUpload', {
                clientId: c.id, folderId: folderId, name: job.name, size: job.size,
                mimeType: job.file.type || 'application/octet-stream', origin: location.origin
            }).then(function (r) {
                return inSlot(function () { return resumable(job, r.uploadUrl); }).catch(function (err) {
                    if (err.network && job.sent === 0 && job.size <= SMALL_LIMIT) return small(job);   // browser blocked the direct path
                    throw err;
                });
            }).then(function (f) {
                if (!f) return;
                return api('finishUpload', { clientId: c.id, fileId: f.id }).then(function (r) {
                    bump(c, r.item ? r.item.size : job.size);
                });
            });
        });
    }
    function bump(c, size) {
        c.sizeBytes += Number(size) || 0; c.files += 1; c.updatedAt = new Date().toISOString();
    }

    function small(job) {
        return new Promise(function (res, rej) {
            var fr = new FileReader();
            fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
            fr.onerror = function () { rej(new Error('Could not read the file from your computer.')); };
            fr.readAsDataURL(job.file);
        }).then(function (data) {
            job.sent = job.size / 2; renderTray();
            return api('uploadSmall', { clientId: job.client.id, folderId: job.folderId, name: job.name, mimeType: job.file.type || 'application/octet-stream', data: data });
        }).then(function () { job.sent = job.size; bump(job.client, job.size); return null; });
    }

    /* Sends the file straight to Google in pieces. Resolves with Google's answer: { id, size, md5Checksum, ... }. */
    function resumable(job, url) {
        var size = job.size, tries = 0;
        function put(start) {
            var end = Math.min(start + CHUNK, size);
            return xhrPut(url, job.file.slice(start, end), 'bytes ' + start + '-' + (end - 1) + '/' + size, function (loaded) {
                job.sent = start + loaded; renderTrayThrottled();
            }).then(function (x) {
                if (x.status === 200 || x.status === 201) { job.sent = size; return idFrom(x); }
                if (x.status === 308) { tries = 0; return put(nextFrom(x, end)); }
                if (x.status === 404 || x.status === 410) throw new Error('The upload expired. Please upload this file again.');
                if (x.status >= 500 || x.status === 429) return retry(start);
                throw new Error('Google refused the upload (' + x.status + ').');
            }, function (err) { if (job.sent > 0 || start > 0) return retry(start); throw err; });
        }
        function retry(start) {
            if (++tries > 5) throw new Error('The connection kept failing. Please try this file again.');
            return wait(1000 * Math.pow(2, tries)).then(function () {
                return xhrPut(url, null, 'bytes */' + size).then(function (x) {
                    if (x.status === 200 || x.status === 201) { job.sent = size; return idFrom(x); }
                    if (x.status === 308) return put(nextFrom(x, start));
                    return put(start);
                }, function () { return retry(start); });
            });
        }
        return put(0);
    }
    function nextFrom(x, fallback) {
        var r = null;
        try { r = x.getResponseHeader('Range'); } catch (e) {}
        var m = r && /bytes=0-(\d+)/.exec(r);
        return m ? Number(m[1]) + 1 : (r === null && fallback !== undefined ? fallback : 0);
    }
    function idFrom(x) {
        try { var j = JSON.parse(x.responseText); if (j.id) return j; } catch (e) {}
        throw new Error('Upload finished but Google did not return the file. Refresh to check.');
    }
    function xhrPut(url, blob, range, onProgress) {
        if (window.VAULT_MOCK_PUT) return window.VAULT_MOCK_PUT(url, blob, range, onProgress);      // demo page only
        return new Promise(function (res, rej) {
            var x = new XMLHttpRequest();
            x.open('PUT', url, true);
            x.setRequestHeader('Content-Range', range);
            if (onProgress && x.upload) x.upload.onprogress = function (e) { onProgress(e.loaded); };
            x.onload = function () { res(x); };
            x.onerror = function () { var e = new Error('Could not upload directly to Google.'); e.network = true; rej(e); };
            x.ontimeout = x.onerror;
            x.send(blob);
        });
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    var trayTimer = 0;
    function renderTrayThrottled() { if (!trayTimer) trayTimer = setTimeout(function () { trayTimer = 0; renderTray(); }, 250); }
    function renderTray() {
        if (!queue.length) { $('vTray').hidden = true; return; }
        var done = queue.filter(function (j) { return j.state === 'done'; }).length;
        var failed = queue.filter(function (j) { return j.state === 'err'; }).length;
        var active = queue.length - done - failed;
        var skipped = queue.filter(function (j) { return j.skipped; }).length;
        $('vTrayTitle').textContent = active ? 'Uploading ' + (done + failed + 1) + ' of ' + queue.length :
            failed ? (done - skipped) + ' uploaded · ' + failed + ' failed' :
                skipped ? (done - skipped) + ' uploaded · ' + skipped + ' skipped' : 'All ' + done + ' uploaded';
        $('vTrayList').innerHTML = queue.slice().reverse().map(function (j) {
            var p = j.size ? Math.min(100, j.sent / j.size * 100) : (j.state === 'done' ? 100 : 0);
            var st = j.state === 'done' ? (j.skipped ? '<span class="v-up-state">Skipped</span>' : '<span class="v-up-state ok">' + (j.replaced ? 'Replaced ' : '') + '<i class="fas fa-check"></i></span>') :
                j.state === 'ask' ? '<span class="v-up-state">Already exists…</span>' :
                j.state === 'err' ? '<span class="v-up-state err"><i class="fas fa-circle-exclamation"></i> Failed <button class="v-link" data-retry="' + j.id + '">Retry</button></span>' :
                    j.state === 'wait' ? '<span class="v-up-state">Waiting</span>' : '<span class="v-up-state">' + p.toFixed(0) + '%</span>';
            return '<div class="v-up"><div class="v-up-top"><span class="v-up-name" title="' + esc((j.dirs.length ? j.dirs.join('/') + '/' : '') + j.name) + '">' + esc(j.name) +
                '</span>' + st + '</div>' + (j.state === 'done' || j.state === 'err' || j.state === 'ask' ? '' : '<div class="v-up-bar"><span style="width:' + p + '%"></span></div>') +
                (j.msg ? '<div class="v-up-msg">' + esc(j.msg) + '</div>' : '') + '</div>';
        }).join('');
        $('vTrayRetry').hidden = !failed || !!active;
    }
    function retryUploads(id) {
        queue.forEach(function (j) { if (j.state === 'err' && (!id || j.id === id)) { j.state = 'wait'; j.msg = ''; j.sent = 0; } });
        pump();
    }
    $('vTrayList').addEventListener('click', function (e) {
        var b = e.target.closest('[data-retry]');
        if (b) retryUploads(Number(b.getAttribute('data-retry')));
    });
    $('vTrayRetry').addEventListener('click', function () { retryUploads(); });
    $('vTrayClose').addEventListener('click', function () {
        if (queue.some(function (j) { return j.state === 'wait' || j.state === 'run'; })) { toast('Uploads are still running. The list will close when they finish.'); return; }
        queue = []; $('vTray').hidden = true;
    });
    function uploadsFinished() {
        var failed = queue.filter(function (j) { return j.state === 'err'; }).length;
        flushSizes();
        if (failed) toast(failed + ' file' + (failed === 1 ? '' : 's') + ' could not be uploaded. See the list for the reason.', true);
        else toast('Upload complete.');
        if (S.view === 'files' && S.client) { renderFiles(); loadItems(); }
        else if (S.view === 'files') renderFiles();
        loadOverview().catch(function () {});
    }

    /* Uploads one file into a client folder (new, or replacing an existing file's content).
       Resolves with { id, size, md5 }. Used by the "copy server to vault" run. */
    function uploadOne(o) {
        var c = o.client;
        var job = { file: o.file, name: o.name || o.file.name, size: o.file.size, client: c, folderId: o.folderId, sent: 0, dirs: [] };
        if (o.onProgress) Object.defineProperty(job, 'sent', { get: function () { return this._s || 0; }, set: function (v) { this._s = v; o.onProgress(v); } });
        var mime = o.file.type || 'application/octet-stream';
        var viaScripts = function () {
            return new Promise(function (res, rej) {
                var fr = new FileReader();
                fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
                fr.onerror = function () { rej(new Error('Could not read the file from the server folder.')); };
                fr.readAsDataURL(job.file);
            }).then(function (data) {
                return api('uploadSmall', { clientId: c.id, folderId: o.folderId, name: job.name, mimeType: mime, data: data });
            }).then(function (r) { job.sent = job.size; return { id: r.id, size: r.size, md5: r.md5 }; });
        };
        if (!job.size && !o.fileId) return viaScripts();
        if (direct(c)) {
            return sessionFor(c, { folderId: o.folderId, name: job.name, size: job.size, mimeType: mime, fileId: o.fileId || '' })
                .then(function (url) { return inSlot(function () { return job.size ? resumable(job, url) : xhrPut(url, null, 'bytes */0').then(idFrom); }); })
                .then(function (f) {
                    var size = Number(f.size) || 0;
                    pendSize(c, size - (o.fileId ? Number(o.oldSize) || 0 : 0), o.fileId ? 0 : 1);
                    return { id: f.id, size: size, md5: f.md5Checksum || '' };
                }, function (err) {
                    if (err.network && !o.fileId && job.sent === 0 && job.size <= SMALL_LIMIT) return viaScripts();
                    throw err;
                });
        }
        return api('startUpload', { clientId: c.id, folderId: o.folderId, fileId: o.fileId || '', name: job.name, size: job.size, mimeType: mime, origin: location.origin })
            .then(function (r) {
                var send = inSlot(function () { return job.size ? resumable(job, r.uploadUrl) : xhrPut(r.uploadUrl, null, 'bytes */0').then(idFrom); });
                return send.catch(function (err) {
                    if (err.network && !o.fileId && job.sent === 0 && job.size <= SMALL_LIMIT) return null;   // fall back below
                    throw err;
                });
            })
            .then(function (f) {
                if (!f) return viaScripts();
                return api('finishUpload', { clientId: c.id, fileId: f.id, replaced: !!o.fileId, oldSize: o.oldSize || 0 })
                    .then(function (r) { return { id: r.item.id, size: r.item.size, md5: r.item.md5 }; });
            });
    }

    function activeWork() { return running > 0 || queue.some(function (j) { return j.state === 'wait'; }) || S.busy > 0; }
    window.addEventListener('beforeunload', function (e) {
        if (activeWork()) { e.preventDefault(); e.returnValue = 'Uploads or moves are still running.'; return e.returnValue; }
    });

    /* ---------------------------------------------------------------
       Storage view
       --------------------------------------------------------------- */
    function renderStorage() {
        var t = totals();
        $('vThreshold').textContent = S.settings.threshold + '%';
        $('vStats').innerHTML = [
            ['Total space', gb(t.limit), S.drives.length + ' drive' + (S.drives.length === 1 ? '' : 's')],
            ['Used', gb(t.used), pct(t.pct) + ' of all drives'],
            ['Free', gb(t.free), 'across every drive'],
            ['Client folders', String(clientsOnly().length), bytes(t.vault) + ' in the vault' + (officeSpace() ? ' (with office data)' : '')]
        ].map(function (s) {
            return '<div class="v-panel v-stat"><div class="v-stat-label">' + s[0] + '</div><div class="v-stat-num">' + s[1] + '</div><div class="v-stat-sub">' + s[2] + '</div></div>';
        }).join('');

        var next = nextDrive();
        var box = $('vDrives');
        if (!S.drives.length) {
            box.innerHTML = '<div class="v-panel v-empty"><i class="fas fa-hard-drive"></i><strong>No drives yet</strong>Add your first drive in Settings.</div>';
        } else {
            box.innerHTML = S.drives.map(function (d, i) {
                var lim = d.limit || 1;
                var vault = Math.min(d.vaultBytes, d.used, lim), other = Math.max(0, Math.min(d.used, lim) - vault);
                var chip = !d.online ? '<span class="v-badge bad"><i class="fas fa-plug"></i> Not reachable</span>' :
                    d.status === 'paused' ? '<span class="v-badge idle"><i class="fas fa-pause"></i> Paused</span>' :
                        d.pct >= S.settings.threshold ? '<span class="v-badge warn">Full for new clients</span>' :
                            '<span class="v-badge ok">Taking new clients</span>';
                return '<div class="v-panel v-drive' + (!d.online ? ' off' : '') + '" data-id="' + esc(d.id) + '">' +
                    '<div class="v-drive-head"><span class="v-drive-no">' + (i + 1) + '</span>' +
                    '<div class="v-drive-title"><strong>' + esc(d.label) + '</strong><span title="' + esc(d.email) + '">' + esc(d.email) + '</span></div></div>' +
                    '<div class="v-drive-chip">' + chip + '</div>' +
                    '<div class="v-meter" title="' + pct(d.pct) + ' used"><span class="vault" style="width:' + (vault / lim * 100) + '%"></span>' +
                    '<span class="other" style="width:' + (other / lim * 100) + '%"></span><span class="mark" style="left:' + S.settings.threshold + '%"></span></div>' +
                    '<div class="v-meter-legend"><span><i class="v-dot" style="background:var(--teal)"></i>Vault <b>' + gb(vault) + '</b></span>' +
                    '<span><i class="v-dot" style="background:#b9c9c9"></i>Other <b>' + gb(other) + '</b></span>' +
                    '<span>Free <b>' + gb(Math.max(0, d.limit - d.used)) + '</b> of ' + gb(d.limit) + '</span></div>' +
                    (d.error && !d.online ? '<p class="v-small" style="color:var(--bad);margin:.7rem 0 0">' + esc(d.error) + '</p>' : '') +
                    (d.trashBytes ? '<p class="v-small" style="color:var(--warn);margin:.7rem 0 0"><i class="fas fa-trash-can"></i> ' + bytes(d.trashBytes) + ' of this is in the vault trash (see below)</p>' : '') +
                    (next && next.id === d.id ? '<p class="v-small" style="color:var(--teal);margin:.7rem 0 0"><i class="fas fa-arrow-right"></i> The next new client will be created here.</p>' : '') +
                    '<a class="v-drive-open" href="https://drive.google.com/drive/folders/' + encodeURIComponent(d.rootId || '') + '?authuser=' + encodeURIComponent(d.email) +
                    '" target="_blank" rel="noopener" data-open-drive><i class="fab fa-google-drive"></i> Open this account\'s Drive</a>' +
                    '<div class="v-drive-foot"><span>' + d.clients + ' client' + (d.clients === 1 ? '' : 's') + ' · ' + pct(d.pct) + ' · ' + ago(d.checkedAt) + '</span>' +
                    '<span class="v-acts">' +
                    '<button class="v-act" data-up title="Higher priority"' + (i === 0 ? ' disabled' : '') + '><i class="fas fa-arrow-up"></i></button>' +
                    '<button class="v-act" data-down title="Lower priority"' + (i === S.drives.length - 1 ? ' disabled' : '') + '><i class="fas fa-arrow-down"></i></button>' +
                    '<button class="v-act" data-pause title="' + (d.status === 'paused' ? 'Resume new clients' : 'Pause new clients') + '"><i class="fas ' + (d.status === 'paused' ? 'fa-play' : 'fa-pause') + '"></i></button>' +
                    '<button class="v-act" data-label title="Rename"><i class="fas fa-pen"></i></button>' +
                    '<button class="v-act del" data-remove title="Remove this drive from the vault"><i class="fas fa-link-slash"></i></button>' +
                    '</span></div></div>';
            }).join('') + '<button class="v-panel v-drive v-empty" data-add style="border-style:dashed;cursor:pointer;padding:2rem 1rem"><i class="fas fa-plus"></i><strong>Add a drive</strong>Connect another Gmail account</button>';
            box.querySelectorAll('.v-drive[data-id]').forEach(function (card) {
                var d = driveOf(card.dataset.id);
                card.querySelector('[data-up]').onclick = function () { updateDrive(d, { move: 'up' }); };
                card.querySelector('[data-down]').onclick = function () { updateDrive(d, { move: 'down' }); };
                card.querySelector('[data-pause]').onclick = function () { updateDrive(d, { status: d.status === 'paused' ? 'active' : 'paused' }); };
                card.querySelector('[data-remove]').onclick = function () { removeDrive(d); };
                card.querySelector('[data-label]').onclick = function () {
                    promptBox('Rename drive', 'Drive name', d.label, 'Save').then(function (v) { if (v && v !== d.label) updateDrive(d, { label: v }); });
                };
            });
            box.querySelector('[data-add]').onclick = function () { show('settings'); setTimeout(function () { $('vDLabel').focus(); }, 60); };
        }
        renderDriveFilter();
        renderClientTable();
        loadTrash();
    }

    /* ---------------------------------------------------------------
       Vault trash: everything the vault has put in Google Drive's trash
       --------------------------------------------------------------- */
    function loadTrash() {
        return api('trashList').then(function (r) { S.trash = r.items; renderTrash(); }).catch(function () {});
    }
    function renderTrash() {
        var box = $('vTrash'), list = S.trash || [];
        if (!box) return;
        $('vTrashHead').hidden = !list.length;
        box.hidden = !list.length;
        if (!list.length) return;
        var total = list.reduce(function (a, t) { return a + t.bytes; }, 0);
        $('vTrashSum').textContent = list.length + ' item' + (list.length === 1 ? '' : 's') + ' · ' + bytes(total);
        box.innerHTML = '<div class="v-scroll"><table class="v-list"><thead><tr><th>Item</th><th class="hide-sm">Drive</th><th class="num">Size</th><th class="hide-sm">When</th><th></th></tr></thead><tbody>' +
            list.map(function (t) {
                return '<tr data-id="' + esc(t.id) + '"><td><div class="v-trash-name">' + esc((t.clientName && t.clientName !== t.name ? t.clientName + ' / ' : '') + t.name) +
                    '</div><div class="v-small v-muted">' + esc(t.reason) + ' · Google empties it on ' + date(t.clearsOn) + '</div></td>' +
                    '<td class="hide-sm"><span class="v-badge idle">' + esc(t.driveLabel) + '</span></td><td class="num">' + bytes(t.bytes) + '</td>' +
                    '<td class="dim hide-sm">' + date(t.time) + '</td><td><div class="v-acts">' +
                    (t.restorable ? '<button class="v-btn v-btn--ghost v-btn--sm" data-restore><i class="fas fa-rotate-left"></i> Restore</button>' : '') +
                    '<button class="v-act del" data-purge title="Delete for good"><i class="fas fa-xmark"></i></button></div></td></tr>';
            }).join('') + '</tbody></table></div>';
        box.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var t = list.filter(function (x) { return x.id === tr.dataset.id; })[0];
            var r = tr.querySelector('[data-restore]');
            if (r) r.onclick = function () {
                spin(r, true, 'Restoring…');
                api('trashRestore', { id: t.id }).then(function () { toast('Restored: ' + t.name); return refreshAll(); })
                    .catch(function (err) { toast(err.message, true); spin(r, false); });
            };
            tr.querySelector('[data-purge]').onclick = function () { purgeTrash([t]); };
        });
    }
    function purgeTrash(items) {
        var size = items.reduce(function (a, t) { return a + t.bytes; }, 0);
        var wrap = el('<div><p>' + (items.length === 1 ? '<strong>' + esc(items[0].name) + '</strong>' : items.length + ' items') + ' (' + bytes(size) +
            ') will be <strong>deleted for good</strong> from Google Drive. This cannot be undone.</p>' +
            (items.some(function (t) { return t.restorable; }) ? '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> This includes files you deleted yourself. Make sure you no longer need them.</p>' : '') +
            '<label class="v-label" for="vPurgeType">Type DELETE to confirm</label><input class="v-input" id="vPurgeType" autocomplete="off"></div>');
        var input = wrap.querySelector('input');
        modal({ title: 'Delete for good?', body: wrap, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: '<i class="fas fa-xmark"></i> Delete for good', cls: 'v-btn--danger', value: true,
                onClick: function () { if (input.value.trim().toUpperCase() !== 'DELETE') { toast('Type DELETE to confirm.', true); input.focus(); return false; } } }
        ] }).then(function (ok) {
            if (!ok) return;
            return api('trashPurge', { ids: items.map(function (t) { return t.id; }) }).then(function (r) {
                toast(r.done + ' deleted for good.' + (r.failed.length ? ' ' + r.failed.length + ' could not be deleted.' : ''), !!r.failed.length);
                return refreshAll();
            }).catch(function (err) { toast(err.message, true); });
        });
    }
    $('vTrashMoves').addEventListener('click', function () {
        var olds = (S.trash || []).filter(function (t) { return !t.restorable; });
        if (!olds.length) { toast('There are no old copies from moves in the trash.'); return; }
        purgeTrash(olds);
    });
    /* Taking a drive out of the vault. Allowed only when nothing of the vault is left on it. */
    function removeDrive(d) {
        var on = S.clients.filter(function (c) { return c.driveId === d.id; });
        var incoming = S.clients.filter(function (c) { return c.moveTo === d.id; });
        var trash = (S.trash || []).filter(function (t) { return t.driveId === d.id; });
        var others = S.drives.filter(function (x) { return x.id !== d.id; });
        var row = function (ok, text) { return '<li class="' + (ok ? 'ok' : 'no') + '"><i class="fas ' + (ok ? 'fa-circle-check' : 'fa-circle-xmark') + '"></i><span>' + text + '</span></li>'; };
        var ready = !on.length && !incoming.length && !trash.length && others.length;
        var html = '<p>To take <strong>' + esc(d.label) + '</strong> (' + esc(d.email) + ') out of the vault, nothing of the vault may be left on it:</p><ul class="v-check-list">' +
            row(!on.length, on.length ? on.length + ' folder' + (on.length === 1 ? '' : 's') + ' still on it. Move them to another drive first.' : 'No client folders (or office space) on it') +
            row(!incoming.length, incoming.length ? 'A move to this drive is in progress. Finish or cancel it first.' : 'No moves to this drive in progress') +
            row(!trash.length, trash.length ? trash.length + ' item' + (trash.length === 1 ? '' : 's') + ' in the vault trash are on it. Restore them or delete them for good first.' : 'Nothing in the vault trash on it') +
            row(!!others.length, others.length ? 'Other drives stay connected' : 'This is the only drive. Add another one first.') + '</ul>';
        if (!ready) {
            var acts = [{ label: 'Close', cls: 'v-btn--ghost', value: null }];
            if (on.length) acts.push({ label: '<i class="fas fa-list"></i> Show its folders', value: 'show' });
            if (on.length && d.status === 'active') acts.splice(1, 0, { label: '<i class="fas fa-pause"></i> Stop new clients going there', cls: 'v-btn--ghost', value: 'pause' });
            html += '<p class="v-small v-muted">Tip: pause the drive so no new clients go there, then in the client table filter by this drive, tick all, choose another drive and press Move. The old copies then wait in the vault trash until you free the space.</p>';
            modal({ title: 'Remove ' + d.label + '?', body: html, wide: true, actions: acts }).then(function (v) {
                if (v === 'pause') updateDrive(d, { status: 'paused' });
                if (v === 'show') {
                    S.cDrive = d.id; S.selected = {};
                    on.forEach(function (c) { if (c.status === 'ok') S.selected[c.id] = true; });
                    renderStorage();
                    var t = $('vClientTable'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
            return;
        }
        var wrap = el('<div>' + html + '<p>What happens: the drive leaves this list, and the other accounts stop sharing their SA Vault folders with it. <strong>Nothing is deleted</strong>: the Gmail account, ' +
            'its (empty) SA Vault folder and its agent script stay as they are. You can add it again later from Settings.</p>' +
            '<label class="v-label" for="vRemoveType">Type the drive name (' + esc(d.label) + ') to confirm</label><input class="v-input" id="vRemoveType" autocomplete="off"></div>');
        var input = wrap.querySelector('input');
        modal({ title: 'Remove ' + d.label + '?', body: wrap, wide: true, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: '<i class="fas fa-link-slash"></i> Remove drive', cls: 'v-btn--danger', id: 'vRemoveGo', value: function () { return input.value.trim(); },
                onClick: function () { if (input.value.trim().toLowerCase() !== d.label.toLowerCase()) { toast('Type the drive name exactly to confirm.', true); input.focus(); return false; } } }
        ] }).then(function (typed) {
            if (!typed) return;
            return api('removeDrive', { driveId: d.id, confirm: typed }).then(function (r) {
                toast(r.removed + ' removed from the vault.' + (r.notes.length ? ' ' + r.notes.join(' ') : ''), !!r.notes.length);
                return refreshAll().then(renderStorage);
            }).catch(function (err) { toast(err.message, true); });
        });
    }

    function updateDrive(d, patch) {
        api('updateDrive', Object.assign({ driveId: d.id }, patch)).then(loadOverview).then(function () {
            renderStorage(); toast('Drive updated.');
        }).catch(function (err) { toast(err.message, true); });
    }

    function renderDriveFilter() {
        var sel = $('vCDrive');
        sel.innerHTML = '<option value="">All drives</option>' + S.drives.map(function (d) {
            return '<option value="' + esc(d.id) + '">' + esc(d.label) + '</option>';
        }).join('');
        sel.value = S.cDrive;
        var mv = $('vMoveTo'), keep = mv.value;
        mv.innerHTML = S.drives.filter(function (d) { return d.online; }).map(function (d) {
            return '<option value="' + esc(d.id) + '">' + esc(d.label) + ' · ' + gb(Math.max(0, d.limit - d.used)) + ' free</option>';
        }).join('');
        if (keep && driveOf(keep)) mv.value = keep;
        else { var last = S.drives.filter(function (d) { return d.online; }).slice(-1)[0]; if (last) mv.value = last.id; }
    }
    $('vCDrive').addEventListener('change', function () { S.cDrive = this.value; renderClientTable(); });
    $('vCSearch').addEventListener('input', function () { S.cSearch = this.value.trim().toLowerCase(); renderClientTable(); });

    function visibleClients() {
        var k = S.cSort.key, dir = S.cSort.dir;
        return S.clients.filter(function (c) {
            return (!S.cDrive || c.driveId === S.cDrive) && (!S.cSearch || c.name.toLowerCase().indexOf(S.cSearch) >= 0);
        }).sort(function (a, b) {
            var r = 0;
            if (k === 'name') r = byName(a, b);
            else if (k === 'drive') r = (driveOf(a.driveId) || { order: 99 }).order - (driveOf(b.driveId) || { order: 99 }).order;
            else if (k === 'size') r = a.sizeBytes - b.sizeBytes;
            else if (k === 'files') r = a.files - b.files;
            else if (k === 'updated') r = String(a.updatedAt).localeCompare(String(b.updatedAt));
            return r * dir || byName(a, b);
        });
    }

    function renderClientTable() {
        var box = $('vClientTable');
        if (!S.loaded) { box.innerHTML = '<div class="v-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>'; return; }
        var list = visibleClients();
        if (!list.length) {
            box.innerHTML = '<div class="v-empty"><i class="fas fa-folder-open"></i><strong>' + (S.clients.length ? 'No match' : 'No client folders yet') + '</strong>' +
                (S.clients.length ? 'Try another search or drive.' : 'Client folders appear here once created.') + '</div>';
            updateSelBar();
            return;
        }
        var th = function (key, label, cls) {
            var on = S.cSort.key === key;
            return '<th class="sortable ' + (cls || '') + '" data-sort="' + key + '">' + label +
                (on ? '<i class="fas ' + (S.cSort.dir > 0 ? 'fa-sort-up' : 'fa-sort-down') + '"></i>' : '') + '</th>';
        };
        var allOn = list.every(function (c) { return S.selected[c.id]; });
        box.innerHTML = '<div class="v-scroll"><table class="v-list"><thead><tr>' +
            '<th class="chk"><input type="checkbox" id="vSelAll" aria-label="Select all shown"' + (allOn ? ' checked' : '') + '></th>' +
            th('name', 'Client') + th('drive', 'Drive') + th('size', 'Size', 'num') + th('files', 'Files', 'num hide-sm') + th('updated', 'Updated', 'hide-sm') +
            '</tr></thead><tbody>' + list.map(function (c) {
                var status = '';
                if (c.status === 'moving') {
                    status = '<div class="v-small" style="margin-top:.3rem"><span class="v-badge warn"><i class="fas fa-right-left"></i> Moving to ' + esc(driveLabel(c.moveTo)) + '</span> ' +
                        '<button class="v-link" data-resume>Resume</button><button class="v-link" data-cancel style="color:var(--bad)">Cancel</button></div>';
                } else if (c.status === 'missing') status = ' <span class="v-badge bad">Not found</span>';
                return '<tr data-id="' + esc(c.id) + '"><td class="chk"><input type="checkbox" aria-label="Select ' + esc(c.name) + '"' + (S.selected[c.id] ? ' checked' : '') +
                    (c.status !== 'ok' ? ' disabled' : '') + '></td>' +
                    '<td><button class="v-name" data-open><span class="v-ico' + (c.kind === 'office' ? ' office' : '') + '"><i class="fas ' + (c.kind === 'office' ? 'fa-building' : 'fa-folder') + '"></i></span><span>' + esc(c.name) + '</span>' +
                    (c.kind === 'office' ? '<span class="v-badge" style="flex:0 0 auto">Office</span>' : '') + '</button>' + status + '</td>' +
                    '<td><span class="v-badge idle">' + esc(driveLabel(c.driveId)) + '</span></td>' +
                    '<td class="num">' + bytes(c.sizeBytes) + '</td><td class="num hide-sm">' + c.files + '</td><td class="dim hide-sm">' + date(c.updatedAt) + '</td></tr>';
            }).join('') + '</tbody></table></div>';

        box.querySelectorAll('th[data-sort]').forEach(function (h) {
            h.onclick = function () {
                var k = h.dataset.sort;
                if (S.cSort.key === k) S.cSort.dir *= -1; else S.cSort = { key: k, dir: (k === 'name' || k === 'drive') ? 1 : -1 };
                renderClientTable();
            };
        });
        $('vSelAll').onchange = function () {
            var on = this.checked;
            list.forEach(function (c) { if (c.status === 'ok') { if (on) S.selected[c.id] = true; else delete S.selected[c.id]; } });
            renderClientTable();
        };
        box.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var c = S.clients.filter(function (x) { return x.id === tr.dataset.id; })[0];
            tr.querySelector('input').onchange = function () { if (this.checked) S.selected[c.id] = true; else delete S.selected[c.id]; updateSelBar(); };
            tr.querySelector('[data-open]').onclick = function () { openClient(c); };
            var r = tr.querySelector('[data-resume]'); if (r) r.onclick = function () { runMoves([c], c.moveTo); };
            var x = tr.querySelector('[data-cancel]'); if (x) x.onclick = function () { cancelMove(c); };
        });
        updateSelBar();
    }

    function selectedClients() { return S.clients.filter(function (c) { return S.selected[c.id] && c.status === 'ok'; }); }
    function updateSelBar() {
        var sel = selectedClients();
        $('vSelBar').hidden = !sel.length;
        if (!sel.length) return;
        var size = sel.reduce(function (a, c) { return a + c.sizeBytes; }, 0);
        $('vSelText').textContent = sel.length + ' selected · ' + bytes(size);
    }
    $('vSelClear').addEventListener('click', function () { S.selected = {}; renderClientTable(); });

    $('vMoveBtn').addEventListener('click', function () {
        var target = driveOf($('vMoveTo').value);
        if (!target) return;
        var sel = selectedClients();
        var already = sel.filter(function (c) { return c.driveId === target.id; });
        sel = sel.filter(function (c) { return c.driveId !== target.id; });
        if (!sel.length) { toast('The selected folders are already on ' + target.label + '.', true); return; }
        var size = sel.reduce(function (a, c) { return a + c.sizeBytes; }, 0);
        var free = Math.max(0, target.limit - target.used);
        var html = '<p>Move <strong>' + sel.length + ' client folder' + (sel.length === 1 ? '' : 's') + '</strong> (' + bytes(size) + ') to <strong>' + esc(target.label) + '</strong>, which has ' + gb(free) + ' free.</p>' +
            '<p class="v-muted v-small">Each folder is copied whole and checked (files, folders and total size). Only then is the old copy deleted, so its space is freed at once. Keep this page open until it finishes. Uploads to these clients wait until their move is done.</p>' +
            (already.length ? '<p class="v-muted v-small">' + already.length + ' selected folder(s) are already on ' + esc(target.label) + ' and will be skipped.</p>' : '') +
            (size > free ? '<p style="color:var(--bad)">These folders are larger than the free space on ' + esc(target.label) + '. Some moves will be refused.</p>' : '');
        modal({ title: 'Move to ' + target.label + '?', body: html, actions: [
            { label: 'Cancel', cls: 'v-btn--ghost', value: false },
            { label: '<i class="fas fa-right-left"></i> Start moving', value: true }
        ] }).then(function (ok) { if (ok) runMoves(sel, target.id); });
    });

    function runMoves(list, targetId) {
        var target = driveOf(targetId);
        var stop = false;
        var body = el('<div><p>Moving to <strong>' + esc(target ? target.label : 'drive') + '</strong>. Please keep this page open.</p><ul class="v-moves"></ul></div>');
        var ul = body.querySelector('ul');
        list.forEach(function (c) {
            ul.appendChild(el('<li data-id="' + esc(c.id) + '"><span>' + esc(c.name) + ' <span class="v-muted v-small">' + bytes(c.sizeBytes) + '</span></span><span class="st">Waiting</span></li>'));
        });
        var setSt = function (c, html, cls) { var s = ul.querySelector('li[data-id="' + c.id + '"] .st'); s.innerHTML = html; s.className = 'st ' + (cls || ''); };
        S.busy++;
        modal({ title: 'Moving client folders', body: body, wide: true, locked: true, actions: [
            { label: 'Stop after this one', cls: 'v-btn--ghost', id: 'vMoveStop', onClick: function (b) { stop = true; b.disabled = true; b.textContent = 'Stopping…'; return false; } },
            { label: 'Close', id: 'vMoveClose', value: true }
        ] });
        $('vMoveClose').disabled = true;
        var okCount = 0, failCount = 0, trashIds = [];

        var chain = Promise.resolve();
        list.forEach(function (c) {
            chain = chain.then(function () {
                if (stop) { setSt(c, 'Not started'); return; }
                setSt(c, '<i class="fas fa-spinner fa-spin"></i> Copying…');
                var copied = 0, skipped = 0;
                var step = function (n) {
                    return api('moveStep', { clientId: c.id, targetDriveId: targetId }).then(function (r) {
                        c.status = 'moving'; c.moveTo = targetId;
                        if (r.done) return r;
                        copied += r.copied || 0; skipped += r.skipped || 0;
                        setSt(c, '<i class="fas fa-spinner fa-spin"></i> ' + (copied + skipped) + ' files copied…');
                        return step(n + 1);
                    }, function (err) {
                        if (n < 2 && /reach|answered with an error/i.test(err.message)) return wait(3000).then(function () { return step(n + 1); });
                        throw err;
                    });
                };
                return step(0).then(function (r) {
                    if (r && r.trashId) trashIds.push(r.trashId);
                    okCount++;
                    c.status = 'ok'; c.driveId = targetId; c.moveTo = ''; delete S.selected[c.id];
                    setSt(c, '<i class="fas fa-check"></i> Moved', 'ok');
                }, function (err) {
                    failCount++;
                    setSt(c, esc(err.message), 'err');
                });
            });
        });
        chain.then(function () {
            S.busy--;
            modalLocked = false;
            $('vMoveClose').disabled = false;
            var st = $('vMoveStop'); if (st) st.remove();
            $('vModalTitle').textContent = failCount ? 'Moves finished with problems' : 'Moves finished';
            body.firstChild.innerHTML = (failCount ? 'Folders marked in red were <strong>not</strong> moved and are still safe on their old drive. ' :
                'Every folder was copied, checked and is now on <strong>' + esc(target ? target.label : 'the new drive') + '</strong>. ') +
                (trashIds.length ? 'The old copies are in the <strong>vault trash</strong> and still use space on the old drive until you free it.' : '');
            if (trashIds.length) {
                var free = el('<button class="v-btn v-btn--ghost" id="vMoveFree"><i class="fas fa-broom"></i> Free up space now</button>');
                $('vModalActions').insertBefore(free, $('vMoveClose'));
                free.onclick = function () {
                    confirmBox('Delete the old copies for good?', 'The ' + trashIds.length + ' old cop' + (trashIds.length === 1 ? 'y' : 'ies') +
                        ' left on the old drive will be deleted for good. The checked copies on <strong>' + esc(target ? target.label : 'the new drive') + '</strong> are not touched.',
                        'Delete old copies', true).then(function (ok) {
                        if (!ok) return;
                        return api('trashPurge', { ids: trashIds }).then(function (r) {
                            toast('Space freed: ' + r.done + ' old cop' + (r.done === 1 ? 'y' : 'ies') + ' deleted.' + (r.failed.length ? ' ' + r.failed.length + ' could not be deleted.' : ''), !!r.failed.length);
                            return refreshAll();
                        }).catch(function (err) { toast(err.message, true); });
                    });
                };
            }
            toast(okCount + ' moved' + (failCount ? ', ' + failCount + ' not moved' : '') + '.', !!failCount);
            return refreshAll();
        });
    }

    function cancelMove(c) {
        confirmBox('Cancel this move?', '<strong>' + esc(c.name) + '</strong> stays on ' + esc(driveLabel(c.driveId)) + '. The half-finished copy on ' + esc(driveLabel(c.moveTo)) + ' is deleted (the original is untouched).', 'Cancel move', true)
            .then(function (ok) {
                if (!ok) return;
                return api('cancelMove', { clientId: c.id }).then(function () { toast('Move cancelled.'); return refreshAll(); })
                    .catch(function (err) { toast(err.message, true); });
            });
    }

    $('vRescan').addEventListener('click', function () {
        var b = this; spin(b, true, 'Scanning…');
        api('rescan').then(function (r) {
            var msg = 'Rescan done: ' + r.added + ' new, ' + r.updated + ' updated, ' + r.missing + ' not found.';
            if (r.offline && r.offline.length) msg += ' Not reachable: ' + r.offline.join(', ') + '.';
            return refreshAll().then(function () { return countSizes(msg); });
        }).catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
    });

    $('vSizes').addEventListener('click', function () { countSizes(''); });

    /* Counts the real size of every client folder. With the new agent each drive is counted in one sweep
       (seconds, a few calls); older agents are counted folder by folder through the master. */
    function countSizes(intro) {
        var drives = S.drives.filter(function (d) { return d.online !== false; });
        if (!drives.length) { toast('No drive can be reached right now.', true); return Promise.resolve(); }
        var rows = {}, stop = false, foreign = [];
        var line = function (d, html) { rows[d.id] = html; paintRows(); };
        var body = el('<div>' + (intro ? '<p>' + esc(intro) + '</p>' : '') + '<p>Counting the real size of each client folder.</p><ul class="v-check-list" id="vSzList"></ul><div id="vSzForeign"></div></div>');
        function paintRows() {
            var ul = body.querySelector('#vSzList');
            if (ul) ul.innerHTML = drives.map(function (d) { return '<li>' + (rows[d.id] || '<i class="fas fa-circle-notch fa-spin"></i> ' + esc(d.label) + ': waiting…') + '</li>'; }).join('');
        }
        paintRows();
        S.busy++;
        modal({ title: 'Counting sizes', body: body, locked: true, wide: true, actions: [
            { label: 'Stop', cls: 'v-btn--ghost', id: 'vSzStop', onClick: function (b) { stop = true; b.disabled = true; return false; } },
            { label: 'Close', id: 'vSzClose', value: true }
        ] });
        $('vSzClose').disabled = true;
        var one = function (d) {
            if (stop) { line(d, '<i class="fas fa-minus"></i> ' + esc(d.label) + ': stopped'); return Promise.resolve(); }
            line(d, '<i class="fas fa-circle-notch fa-spin"></i> ' + esc(d.label) + ': counting…');
            if (Number(d.v) >= 4) {
                return agentApi(d.id, 'sizes', {}).then(function (r) {
                    return api('saveSizes', { driveId: d.id, sizes: r.sizes }).then(function (sv) {
                        if (r.foreign && r.foreign.files) foreign.push({ d: d, f: r.foreign });
                        line(d, '<i class="fas fa-check" style="color:var(--teal)"></i> ' + esc(d.label) + ': ' + sv.updated + ' client folder' + (sv.updated === 1 ? '' : 's') + ' counted');
                    });
                }).catch(function (err) { line(d, '<i class="fas fa-triangle-exclamation" style="color:#b7791f"></i> ' + esc(d.label) + ': ' + esc(err.message)); });
            }
            // older agent: one folder at a time through the master
            var list = S.clients.filter(function (c) { return c.driveId === d.id && c.status === 'ok'; }), idx = 0, done = 0, failed = 0;
            var worker = function () {
                if (stop || idx >= list.length) return Promise.resolve();
                var c = list[idx++];
                return api('refreshSize', { clientId: c.id }).then(function (r) { c.sizeBytes = r.sizeBytes; c.files = r.files; }, function () { failed++; })
                    .then(function () { done++; line(d, '<i class="fas fa-circle-notch fa-spin"></i> ' + esc(d.label) + ': ' + done + ' of ' + list.length + ' counted' + (failed ? ' · ' + failed + ' could not be read' : '')); return worker(); });
            };
            return Promise.all([worker(), worker(), worker()]).then(function () {
                line(d, '<i class="fas fa-check" style="color:var(--teal)"></i> ' + esc(d.label) + ': ' + (done - failed) + ' client folders counted' + (failed ? ' · ' + failed + ' could not be read' : '') +
                    ' <span class="v-muted v-small">(update this drive’s agent to count in one go)</span>');
            });
        };
        return Promise.all(drives.map(one)).then(function () {
            if (foreign.length) {
                var box = body.querySelector('#vSzForeign');
                box.innerHTML = foreign.map(function (x) {
                    var owners = x.f.list.map(function (i) { return i.owner; }).filter(function (e, i, a) { return e && a.indexOf(e) === i; });
                    return '<p class="v-bk-warn"><i class="fas fa-triangle-exclamation"></i> ' + x.f.files.toLocaleString('en-IN') + ' file' + (x.f.files === 1 ? '' : 's') +
                        ' (' + bytes(x.f.bytes) + ') inside ' + esc(x.d.label) + (x.f.files === 1 ? ' belongs' : ' belong') + ' to another Google account (' + owners.map(esc).join(', ') + '), so ' +
                        (x.f.files === 1 ? 'it uses' : 'they use') + ' that account’s storage, not ' + esc(x.d.label) + '’s. ' + (x.f.files === 1 ? 'It is' : 'They are') + ' still in the vault and in the backups. ' +
                        'This happens when files are put into a drive’s “SA Vault” folder while signed in to a different account.</p>' +
                        '<details><summary class="v-small">Show the files</summary><ul class="v-small">' + x.f.list.map(function (i) {
                            return '<li>' + esc(i.client) + ' › ' + esc(i.name) + ' <span class="v-muted">(' + bytes(i.size) + ', ' + esc(i.owner) + ')</span></li>';
                        }).join('') + (x.f.files > x.f.list.length ? '<li>…and ' + (x.f.files - x.f.list.length) + ' more</li>' : '') + '</ul></details>';
                }).join('');
            }
            S.busy--;
            modalLocked = false;
            $('vSzClose').disabled = false;
            var st = $('vSzStop'); if (st) st.remove();
            $('vModalTitle').textContent = 'Sizes updated';
            return refreshAll();
        });
    }

    $('vExport').addEventListener('click', function () {
        var rows = [['Name', 'Type', 'Drive', 'Drive account', 'Size (MB)', 'Files', 'Status', 'Updated']];
        S.clients.slice().sort(function (a, b) { return (a.kind === 'office') - (b.kind === 'office') || byName(a, b); }).forEach(function (c) {
            var d = driveOf(c.driveId) || {};
            rows.push([c.name, c.kind === 'office' ? 'Office' : 'Client', d.label || '', d.email || '', (c.sizeBytes / 1048576).toFixed(1), c.files, c.status, (c.updatedAt || '').slice(0, 10)]);
        });
        var csv = '﻿' + rows.map(function (r) {
            return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
        }).join('\r\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'SA-Vault-clients-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });

    /* ---------------------------------------------------------------
       Activity
       --------------------------------------------------------------- */
    var ACT_ICON = { 'sign-in': 'fa-right-to-bracket', 'create client': 'fa-folder-plus', 'delete': 'fa-trash-can', 'delete client': 'fa-trash-can',
        'move started': 'fa-right-left', 'move finished': 'fa-circle-check', 'move cancelled': 'fa-ban', 'rescan': 'fa-rotate', 'add drive': 'fa-hard-drive',
        'settings': 'fa-gear', 'password changed': 'fa-key', 'rename client': 'fa-pen', 'update drive': 'fa-hard-drive' };
    function loadActivity() {
        var box = $('vActivity');
        box.innerHTML = '<div class="v-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
        api('activity').then(function (r) {
            if (!r.items.length) { box.innerHTML = '<div class="v-empty"><i class="fas fa-clock-rotate-left"></i><strong>Nothing yet</strong>Changes will be listed here.</div>'; return; }
            box.innerHTML = '<ul class="v-feed">' + r.items.map(function (a) {
                return '<li><span class="when">' + date(a.time, true) + '</span><span class="what"><strong><i class="fas ' + (ACT_ICON[a.action] || 'fa-circle-dot') +
                    '" style="color:var(--teal);margin-right:.45rem;width:1rem"></i>' + esc(a.action) + '</strong><span>' + esc(a.detail || '') + (a.user ? ' · ' + esc(a.user) : '') + '</span></span></li>';
            }).join('') + '</ul>';
        }).catch(function (err) { box.innerHTML = '<div class="v-empty"><i class="fas fa-triangle-exclamation"></i><strong>Could not load</strong>' + esc(err.message) + '</div>'; });
    }

    /* ---------------------------------------------------------------
       Settings
       --------------------------------------------------------------- */
    function renderSettings() {
        if (document.activeElement !== $('vTh')) { $('vTh').value = S.settings.threshold; $('vThOut').textContent = S.settings.threshold + '%'; }
        if (document.activeElement !== $('vEmails')) $('vEmails').value = S.settings.extraEmails || '';
        if (!$('vDLabel').value) $('vDLabel').placeholder = 'e.g. Drive ' + (S.drives.length + 1);
    }
    $('vTh').addEventListener('input', function () { $('vThOut').textContent = this.value + '%'; });

    $('vAddDrive').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = $('vDAdd');
        var url = $('vDUrl').value.trim(), secret = $('vDSecret').value.trim();
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { toast('Paste the agent link. It starts with https://script.google.com/macros/s/ and ends with /exec.', true); $('vDUrl').focus(); return; }
        if (!secret) { toast('Paste the secret from the agent setup.', true); $('vDSecret').focus(); return; }
        spin(b, true, 'Connecting…');
        api('addDrive', { label: $('vDLabel').value.trim(), agentUrl: url, secret: secret }).then(function (r) {
            $('vDLabel').value = ''; $('vDUrl').value = ''; $('vDSecret').value = '';
            var bad = (r.sharing || []).filter(function (s) { return !s.ok; });
            toast(r.drive.label + ' connected (' + gb(r.drive.limit) + ').' + (bad.length ? ' Sharing failed on ' + bad.map(function (s) { return s.drive; }).join(', ') + '.' : ''), !!bad.length);
            return loadOverview().then(function () { show('storage'); });
        }).catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
    });

    $('vSettingsForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = this.querySelector('[type=submit]');
        var emails = $('vEmails').value.trim();
        var bad = emails.split(/[,\s]+/).filter(function (x) { return x && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
        if (bad.length) { toast('Check this email: ' + bad[0], true); return; }
        var changedEmails = emails !== (S.settings.extraEmails || '');
        spin(b, true, 'Saving…');
        api('saveSettings', { threshold: Number($('vTh').value), extraEmails: emails }).then(function (r) {
            S.settings = r.settings;
            toast('Saved.' + (changedEmails ? ' Sharing the drives with the new list…' : ''));
            if (changedEmails) return reshare();
        }).catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
    });
    function reshare() {
        return api('syncSharing').then(function (r) {
            var bad = (r.results || []).filter(function (s) { return !s.ok; });
            toast(bad.length ? 'Could not share ' + bad.map(function (s) { return s.drive; }).join(', ') + '.' : 'All drives are shared with every connected account.', !!bad.length);
        });
    }
    $('vReshare').addEventListener('click', function () {
        var b = this; spin(b, true, 'Sharing…');
        reshare().catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
    });

    $('vPwForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = this.querySelector('[type=submit]');
        var cur = $('vPwOld').value, next = $('vPwNew').value;
        if (!cur) { toast('Enter your current password.', true); return; }
        if (next.length < 10) { toast('Use at least 10 characters for the new password.', true); return; }
        spin(b, true, 'Saving…');
        api('changePassword', { current: cur, next: next }).then(function () {
            $('vPwOld').value = ''; $('vPwNew').value = '';
            toast('Password changed.');
        }).catch(function (err) { toast(err.message, true); }).then(function () { spin(b, false); });
    });

    /* Shared with assets/vault-backup.js */
    window.SAV = {
        S: S, api: api, toast: toast, modal: modal, closeModal: closeModal, confirmBox: confirmBox, esc: esc, bytes: bytes, date: date,
        el: el, spin: spin, show: show, uploadOne: uploadOne, refreshAll: refreshAll, loadOverview: loadOverview, driveLabel: driveLabel,
        makeFolder: makeFolder, flushSizes: flushSizes, direct: direct, agentApi: agentApi, UPLOAD_JOBS: PARALLEL,
        driveOf: driveOf, wait: wait, unlockModal: function () { modalLocked = false; }
    };

    /* ---------------------------------------------------------------
       Start
       --------------------------------------------------------------- */
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
    setTimeout(function () {                      // lets assets/vault-backup.js load first
        if (saved && saved.t) { S.token = saved.t; S.user = saved.u; boot(); }
        else showLogin();
    }, 0);
})();
