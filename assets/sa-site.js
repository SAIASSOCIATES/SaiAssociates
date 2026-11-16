/* =====================================================================
   Sai Associates — shared site behaviour (header, footer)
   - header shadow on scroll
   - current-page highlight (home page follows the section you are on)
   - closes the mobile menu after a tap
   - back-to-top button, footer year
   ===================================================================== */
(function () {
    'use strict';

    var nav = document.getElementById('saNav');
    var menu = document.getElementById('saNavLinks');
    var toTop = document.querySelector('.sa-to-top');
    var page = document.body.getAttribute('data-sa-page') || '';

    // Footer year
    var year = String(new Date().getFullYear());
    document.querySelectorAll('[data-sa-year]').forEach(function (el) { el.textContent = year; });

    // Keep back-to-top clear of a floating WhatsApp button
    if (toTop && document.querySelector('.whatsapp-float')) toTop.classList.add('sa-to-top--raised');

    // Highlight helper
    var links = nav ? nav.querySelectorAll('.nav-link[data-nav]') : [];
    function setActive(key) {
        links.forEach(function (a) {
            var on = a.getAttribute('data-nav') === key;
            a.classList.toggle('active', on);
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
    }

    // Home page: highlight follows the section in view
    var spy = null;
    if (page === 'home') {
        var sections = [
            ['home', 'home'], ['services', 'services'], ['pricing', 'services'],
            ['about', 'about'], ['contact', 'contact']
        ];
        spy = function () {
            var line = window.scrollY + window.innerHeight * 0.35;
            var current = 'home';
            sections.forEach(function (s) {
                var el = document.getElementById(s[0]);
                if (el && el.offsetParent !== null && el.getBoundingClientRect().top + window.scrollY <= line) current = s[1];
            });
            if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = 'contact';
            setActive(current);
        };
    }

    // Scroll effects
    var ticking = false;
    function onScroll() {
        var y = window.scrollY;
        if (nav) nav.classList.toggle('sa-scrolled', y > 8);
        if (toTop) toTop.classList.toggle('show', y > 500);
        if (spy) spy();
        ticking = false;
    }
    window.addEventListener('scroll', function () {
        if (!ticking) { window.requestAnimationFrame(onScroll); ticking = true; }
    }, { passive: true });
    window.addEventListener('load', onScroll);
    onScroll();

    if (toTop) toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    // Short pages: keep the footer at the bottom of the screen instead of floating mid-page
    var footer = document.querySelector('.sa-footer');
    function fitFooter() {
        if (!footer) return;
        var current = parseFloat(footer.style.marginTop) || 0;
        var footerEnd = footer.getBoundingClientRect().bottom + window.scrollY - current;
        var gap = Math.floor(window.innerHeight - footerEnd);
        var next = gap > 0 ? gap : 0;
        if (Math.abs(next - current) > 1) footer.style.marginTop = next ? next + 'px' : '';
    }
    window.addEventListener('load', fitFooter);
    window.addEventListener('resize', fitFooter);
    if (window.ResizeObserver) new ResizeObserver(fitFooter).observe(document.body); // portal steps change height
    fitFooter();

    // Close the mobile menu after choosing a link
    if (menu) {
        menu.querySelectorAll('a.nav-link').forEach(function (a) {
            a.addEventListener('click', function () {
                if (menu.classList.contains('show') && window.bootstrap && window.bootstrap.Collapse) {
                    window.bootstrap.Collapse.getOrCreateInstance(menu).hide();
                }
            });
        });
    }
})();

/* Clickable non-button elements that open a pop-up (e.g. team photos): allow Enter / Space */
document.querySelectorAll('[role="button"][data-bs-toggle]').forEach(function (el) {
    el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
});

/* =====================================================================
   Show / hide password (eye button) on every password box, including
   boxes a page adds later (e.g. "new password" after an OTP step).
   ===================================================================== */
(function () {
    'use strict';
    var MARGIN_CLASS = /^m[tbsexy]?-(?:auto|\d)$/;

    function enhance(input) {
        if (!input || input.dataset.saPw) return;
        input.dataset.saPw = '1';
        var parent = input.parentElement;
        if (!parent) return;
        var host;

        if (parent.classList.contains('form-floating') ||
            (parent.classList.contains('input-group') && parent.lastElementChild === input)) {
            host = parent;                                   // already positioned: keep layout intact
        } else {
            host = document.createElement('span');           // wrap the box; spacing moves to the wrapper
            host.className = 'sa-pw-wrap';
            Array.prototype.slice.call(input.classList).forEach(function (c) {
                if (MARGIN_CLASS.test(c)) { input.classList.remove(c); host.classList.add(c); }
            });
            parent.insertBefore(host, input);
            host.appendChild(input);
        }
        host.classList.add('sa-pw');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sa-pw-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Show password';
        btn.innerHTML = '<i class="far fa-eye" aria-hidden="true"></i>';
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the cursor in the box
        btn.addEventListener('click', function () {
            var show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.innerHTML = '<i class="far ' + (show ? 'fa-eye-slash' : 'fa-eye') + '" aria-hidden="true"></i>';
            btn.setAttribute('aria-pressed', show ? 'true' : 'false');
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            btn.title = show ? 'Hide password' : 'Show password';
        });
        host.appendChild(btn);
    }

    function scan(root) {
        if (!root || !root.querySelectorAll) return;
        if (root.matches && root.matches('input[type="password"]')) enhance(root);
        root.querySelectorAll('input[type="password"]').forEach(enhance);
    }

    scan(document);
    if (window.MutationObserver) {
        new MutationObserver(function (list) {
            list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); }); });
        }).observe(document.body, { childList: true, subtree: true });
    }
})();
