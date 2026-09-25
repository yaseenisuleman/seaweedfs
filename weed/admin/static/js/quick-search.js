// Quick page search in the top bar.
//
// Indexes the sidebar's navigation links and lets the user jump to any admin
// page by name. Opens with Ctrl+K / Cmd+K or "/". No libraries, no requests.
(function () {
    'use strict';

    function buildIndex() {
        var items = [];
        var section = '';
        var sidebar = document.getElementById('sidebarMenu');
        if (!sidebar) {
            return items;
        }
        sidebar.querySelectorAll('.sidebar-heading, a.nav-link').forEach(function (el) {
            if (el.classList.contains('sidebar-heading')) {
                section = el.textContent.trim();
                return;
            }
            var href = el.getAttribute('href');
            if (!href || href === '#') {
                return;
            }
            var icon = el.querySelector('i.bi');
            items.push({
                label: el.textContent.trim(),
                section: section.charAt(0) + section.slice(1).toLowerCase(),
                href: href,
                icon: icon ? icon.className.replace(/\bme-\d\b/, '').trim() : 'bi bi-file-earmark'
            });
        });
        return items;
    }

    function escapeHtml(s) {
        return s.replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function init() {
        var input = document.getElementById('app-search-input');
        var results = document.getElementById('app-search-results');
        if (!input || !results) {
            return;
        }
        var index = buildIndex();
        var matches = [];
        var selected = 0;

        function close() {
            results.hidden = true;
        }

        function render() {
            var q = input.value.trim().toLowerCase();
            matches = index.filter(function (it) {
                return !q || it.label.toLowerCase().indexOf(q) !== -1 || it.section.toLowerCase().indexOf(q) !== -1;
            }).slice(0, 8);
            selected = Math.min(selected, Math.max(0, matches.length - 1));
            if (!matches.length) {
                results.innerHTML = '<div class="app-search-empty">No pages match "' + escapeHtml(input.value) + '"</div>';
            } else {
                results.innerHTML = matches.map(function (it, i) {
                    return '<a class="app-search-item' + (i === selected ? ' active' : '') + '" href="' + escapeHtml(it.href) + '">' +
                        '<i class="' + escapeHtml(it.icon) + '"></i><span>' + escapeHtml(it.label) + '</span>' +
                        '<small>' + escapeHtml(it.section) + '</small></a>';
                }).join('');
            }
            results.hidden = false;
        }

        input.addEventListener('focus', render);
        input.addEventListener('input', function () {
            selected = 0;
            render();
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                if (matches.length) {
                    selected = (selected + (ev.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
                    render();
                }
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                if (matches[selected]) {
                    window.location.href = matches[selected].href;
                }
            } else if (ev.key === 'Escape') {
                input.blur();
                close();
            }
        });
        document.addEventListener('click', function (ev) {
            if (!results.contains(ev.target) && ev.target !== input) {
                close();
            }
        });
        document.addEventListener('keydown', function (ev) {
            var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') ||
                (document.activeElement && document.activeElement.isContentEditable);
            if ((ev.key === 'k' && (ev.ctrlKey || ev.metaKey)) || (ev.key === '/' && !typing)) {
                ev.preventDefault();
                input.focus();
                input.select();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
