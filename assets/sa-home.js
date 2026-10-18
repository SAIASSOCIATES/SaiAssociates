/* =====================================================================
   Sai Associates — home page touches: scroll reveal, counters, heading lines
   ===================================================================== */
(function () {
    'use strict';
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var canObserve = 'IntersectionObserver' in window;

    // Headings that get the small drawn line
    var headings = document.querySelectorAll('#services > h2, #pricing > h2, #about .container > h2, #contact > h2');
    headings.forEach(function (h) { h.classList.add('sa-heading-line'); });
    var serveH = document.querySelector('#about .col-lg-6 > h2');
    if (serveH) serveH.classList.add('sa-heading-line');
    var aboutH = document.querySelector('.sa-about-title');
    if (aboutH) { aboutH.classList.add('sa-heading-line', 'sa-left'); headings = Array.prototype.slice.call(headings).concat([aboutH]); }

    // Blocks that fade up as they scroll into view (column wrappers, so card hover effects stay untouched)
    var groups = [
        '#services .row > [class*="col-"]',
        '#pricing .row > [class*="col-"]',
        '#about .container.mb-5 .row > [class*="col-"]',
        '#about .container.py-5 .row.align-items-center > [class*="col-"]',
        '#about .container.py-5 .row.justify-content-center > [class*="col-"]',
        '#contact > .row > [class*="col-"]',
        '.sa-stats .row > [class*="col-"]'
    ];
    var reveal = [];
    groups.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el, i) {
            el.classList.add('sa-reveal');
            el.style.transitionDelay = (i % 3) * 90 + 'ms';
            reveal.push(el);
        });
    });

    // Count-up numbers
    var counters = document.querySelectorAll('.sa-stat-num[data-count]');
    function runCounter(el) {
        var end = parseInt(el.getAttribute('data-count'), 10) || 0;
        var suffix = el.getAttribute('data-suffix') || '';
        if (reduce) { el.textContent = end + suffix; return; }
        var start = null, dur = 1400;
        function step(t) {
            if (!start) start = t;
            var p = Math.min((t - start) / dur, 1);
            var eased = 1 - Math.pow(1 - p, 3);
            el.textContent = Math.round(end * eased) + suffix;
            if (p < 1) window.requestAnimationFrame(step);
        }
        el.textContent = '0' + suffix;
        window.requestAnimationFrame(step);
    }

    if (!canObserve || reduce) {
        headings.forEach(function (h) { h.classList.add('is-in'); });
        if (serveH) serveH.classList.add('is-in');
        return; // numbers already show their final values in the HTML
    }

    document.documentElement.classList.add('sa-js');
    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            if (!e.isIntersecting) return;
            e.target.classList.add('is-in');
            if (e.target.matches && e.target.matches('.sa-stat-num[data-count]')) runCounter(e.target);
            io.unobserve(e.target);
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    reveal.forEach(function (el) { io.observe(el); });
    headings.forEach(function (h) { io.observe(h); });
    if (serveH) io.observe(serveH);
    counters.forEach(function (c) { io.observe(c); });
})();
