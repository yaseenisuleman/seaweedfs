// Dashboard charts and interactions.
//
// Reads the trend series the server embeds as JSON (#dashboard-series, see
// DashboardSeries in weed/admin/dash/dashboard_metrics.go) and draws the
// dashboard charts, recent-change chips, the series switcher and the table
// filter. The dashboard content refreshes itself through htmx; everything
// here re-initialises after each swap. No libraries.
(function () {
    'use strict';

    var uid = 0;

    // ---- data and formatting ---------------------------------------------

    function loadSeries() {
        var el = document.getElementById('dashboard-series');
        if (!el) {
            return null;
        }
        try {
            return JSON.parse(el.textContent);
        } catch (e) {
            return null;
        }
    }

    // Matches formatBytes in weed/admin/view/app/template_helpers.go.
    function formatBytes(v) {
        if (!v) {
            return '0 B';
        }
        var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        var i = 0;
        var n = Math.abs(v);
        while (n >= 1024 && i < units.length - 1) {
            n /= 1024;
            i++;
        }
        var s = i === 0 ? n.toFixed(0) : n.toFixed(1);
        return (v < 0 ? '-' : '') + s + ' ' + units[i];
    }

    function formatCount(v) {
        var n = Math.round(v);
        var abs = Math.abs(n);
        if (abs >= 1e9) { return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'; }
        if (abs >= 1e6) { return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; }
        if (abs >= 1e4) { return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; }
        return n.toLocaleString();
    }

    function formatValue(v, format) {
        return format === 'bytes' ? formatBytes(v) : formatCount(v);
    }

    function formatClock(unix) {
        var d = new Date(unix * 1000);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatSpan(seconds) {
        if (seconds < 90) {
            return Math.max(1, Math.round(seconds)) + 's';
        }
        if (seconds < 5400) {
            return Math.round(seconds / 60) + 'm';
        }
        return (seconds / 3600).toFixed(1).replace(/\.0$/, '') + 'h';
    }

    // "Nice" axis ticks covering [min, max]; byte axes step in powers of 1024.
    function niceTicks(min, max, count, format) {
        if (min === max) {
            var pad = format === 'bytes' ? Math.max(1024, Math.abs(max) * 0.1) : Math.max(1, Math.abs(max) * 0.1);
            min = Math.max(0, min - pad);
            max = max + pad;
        }
        var raw = (max - min) / Math.max(1, count - 1);
        var base = format === 'bytes' ? Math.pow(1024, Math.max(0, Math.floor(Math.log(raw) / Math.log(1024)))) : 1;
        var scaled = raw / base;
        var mag = Math.pow(10, Math.floor(Math.log10(scaled)));
        var steps = [1, 2, 2.5, 5, 10];
        var step = 10 * mag;
        for (var i = 0; i < steps.length; i++) {
            if (steps[i] * mag >= scaled) {
                step = steps[i] * mag;
                break;
            }
        }
        if (format !== 'bytes') {
            step = Math.max(1, step);
        }
        step *= base;
        var lo = Math.floor(min / step) * step;
        var hi = Math.ceil(max / step) * step;
        if (hi === lo) {
            hi = lo + step;
        }
        var ticks = [];
        for (var t = lo; t <= hi + step / 2; t += step) {
            ticks.push(t);
        }
        return ticks;
    }

    function cssVar(name, fallback) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    }

    // Approximate width of one axis-label character; .chart-axis is 0.6875rem.
    function axisCharWidth() {
        var rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        return rootPx * 0.6875 * 0.62;
    }

    function accentOf(el) {
        return getComputedStyle(el).getPropertyValue('--accent').trim() || '#5a8dee';
    }

    // ---- drawing -----------------------------------------------------------

    // Catmull-Rom spline through the points, as cubic Bezier segments, with
    // control points clamped to the plot so the curve never overshoots.
    function smoothPath(xy, top, bottom) {
        var clamp = function (v) { return Math.max(top, Math.min(bottom, v)); };
        var d = 'M' + xy[0][0].toFixed(1) + ' ' + xy[0][1].toFixed(1);
        for (var i = 0; i < xy.length - 1; i++) {
            var p0 = xy[i - 1] || xy[i];
            var p1 = xy[i];
            var p2 = xy[i + 1];
            var p3 = xy[i + 2] || p2;
            d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + clamp(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) +
                ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + clamp(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) +
                ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
        }
        return d;
    }

    function svgOpen(w, h) {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
            '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
    }

    // Large area chart with value axis, time axis and a hover tooltip.
    function drawArea(el, times, values, format, color) {
        var w = Math.floor(el.clientWidth);
        var h = Math.floor(el.clientHeight);
        if (!w || !h) {
            return;
        }
        if (values.length < 2) {
            el.innerHTML = '<div class="chart-empty"><span class="spinner-grow spinner-grow-sm me-2"></span>' +
                'Collecting data — this chart fills in over the next few minutes</div>';
            return;
        }
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var ticks = niceTicks(min, max, 5, format);
        var lo = ticks[0];
        var hi = ticks[ticks.length - 1];
        var labels = ticks.map(function (t) { return formatValue(t, format); });
        var charW = axisCharWidth();
        var left = Math.max.apply(null, labels.map(function (l) { return l.length; })) * charW + 16;
        var right = w - 10;
        var top = 10;
        var bottom = h - 28;
        var plotW = right - left;
        var plotH = bottom - top;
        var n = values.length;
        var x = function (i) { return left + (i / (n - 1)) * plotW; };
        var y = function (v) { return bottom - ((v - lo) / (hi - lo || 1)) * plotH; };
        var xy = values.map(function (v, i) { return [x(i), y(v)]; });
        var id = 'dash-grad-' + (++uid);

        var s = svgOpen(w, h);
        s += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
            '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
        ticks.forEach(function (t, i) {
            var ty = y(t);
            s += '<line x1="' + left + '" x2="' + right + '" y1="' + ty.toFixed(1) + '" y2="' + ty.toFixed(1) +
                '" stroke="' + cssVar('--app-grid', '#e9ecf0') + '"' + (i === 0 ? '' : ' stroke-dasharray="3 4"') + '/>';
            s += '<text x="' + (left - 10) + '" y="' + (ty + 4).toFixed(1) + '" text-anchor="end" class="chart-axis">' +
                labels[i] + '</text>';
        });
        // Short windows need seconds to keep the time labels distinct.
        var withSeconds = times[n - 1] - times[0] < 600;
        var labelW = (withSeconds ? 8 : 5) * charW + 12;
        var tickCount = Math.max(2, Math.min(6, n, Math.floor(plotW / (labelW + 16))));
        for (var k = 0; k < tickCount; k++) {
            var idx = Math.round((k / (tickCount - 1)) * (n - 1));
            var anchor = k === 0 ? 'start' : (k === tickCount - 1 ? 'end' : 'middle');
            s += '<text x="' + x(idx).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="' + anchor +
                '" class="chart-axis">' + (withSeconds ? formatClock(times[idx]) : formatClock(times[idx]).slice(0, 5)) + '</text>';
        }
        var line = smoothPath(xy, top, bottom);
        s += '<path d="' + line + ' L' + right + ' ' + bottom + ' L' + left + ' ' + bottom + ' Z" fill="url(#' + id + ')"/>';
        s += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
        var last = xy[n - 1];
        s += '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="5" fill="' +
            cssVar('--app-surface', '#fff') + '" stroke="' + color + '" stroke-width="3"/>';
        s += '<g class="chart-hover" style="display:none"><line class="chart-crosshair" y1="' + top + '" y2="' + bottom +
            '"/><circle r="5" fill="' + color + '" stroke="#fff" stroke-width="2"/></g>';
        s += '<rect class="chart-overlay" x="' + left + '" y="' + top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent"/>';
        s += '</svg><div class="chart-tooltip" hidden></div>';
        el.innerHTML = s;

        var svg = el.querySelector('svg');
        var hover = svg.querySelector('.chart-hover');
        var cross = hover.querySelector('line');
        var dot = hover.querySelector('circle');
        var tip = el.querySelector('.chart-tooltip');
        var overlay = svg.querySelector('.chart-overlay');
        overlay.addEventListener('mousemove', function (ev) {
            var rect = svg.getBoundingClientRect();
            var i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - rect.left - left) / plotW) * (n - 1))));
            var p = xy[i];
            hover.style.display = '';
            cross.setAttribute('x1', p[0]);
            cross.setAttribute('x2', p[0]);
            dot.setAttribute('cx', p[0]);
            dot.setAttribute('cy', p[1]);
            tip.hidden = false;
            tip.innerHTML = '<div class="chart-tooltip-time">' + formatClock(times[i]) + '</div>' +
                '<div class="chart-tooltip-value">' + formatValue(values[i], format) + '</div>';
            var tx = p[0] + 14;
            if (tx + tip.offsetWidth > w) {
                tx = p[0] - 14 - tip.offsetWidth;
            }
            tip.style.left = tx + 'px';
            tip.style.top = Math.max(0, p[1] - tip.offsetHeight / 2) + 'px';
        });
        overlay.addEventListener('mouseleave', function () {
            hover.style.display = 'none';
            tip.hidden = true;
        });
    }

    // Small smooth line with a soft fill.
    function drawSpark(el, values, color) {
        var w = Math.floor(el.clientWidth);
        var h = Math.floor(el.clientHeight);
        if (!w || !h) {
            return;
        }
        if (values.length < 2) {
            el.innerHTML = '';
            return;
        }
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var span = max - min;
        var n = values.length;
        var xy = values.map(function (v, i) {
            var t = span ? (v - min) / span : 0.5;
            return [(i / (n - 1)) * w, h - 2 - t * (h - 4)];
        });
        var id = 'dash-grad-' + (++uid);
        var line = smoothPath(xy, 2, h - 2);
        var s = svgOpen(w, h);
        s += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.25"/>' +
            '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
        s += '<path d="' + line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z" fill="url(#' + id + ')"/>';
        s += '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        el.innerHTML = s + '</svg>';
    }

    // Thin bars over light tracks; short histories fill slots from the right.
    function drawBars(el, values, color) {
        var w = Math.floor(el.clientWidth);
        var h = Math.floor(el.clientHeight);
        if (!w || !h) {
            return;
        }
        var slots = Math.max(8, Math.floor(w / 12));
        var pts = values.slice(-slots);
        var max = Math.max.apply(null, pts.concat([0]));
        var gap = w / slots;
        var bw = Math.max(3, Math.min(6, gap * 0.45));
        var track = cssVar('--app-grid', '#e9ecf0');
        var s = svgOpen(w, h);
        for (var i = 0; i < slots; i++) {
            var x = ((i + 0.5) * gap - bw / 2).toFixed(1);
            var v = pts[i - (slots - pts.length)];
            s += '<rect x="' + x + '" y="0" width="' + bw.toFixed(1) + '" height="' + h + '" rx="1.5" fill="' + track + '"/>';
            if (v === undefined) {
                continue;
            }
            var bh = max > 0 ? Math.max(2, (v / max) * h) : 2;
            s += '<rect x="' + x + '" y="' + (h - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) +
                '" rx="1.5" fill="' + color + '"><title>' + formatCount(v) + '</title></rect>';
        }
        el.innerHTML = s + '</svg>';
    }

    // ---- page wiring ---------------------------------------------------------

    function renderCharts(series) {
        document.querySelectorAll('.dashboard .chart[data-series]').forEach(function (el) {
            var values = (series && series[el.getAttribute('data-series')]) || [];
            var color = accentOf(el);
            var kind = el.getAttribute('data-kind');
            if (kind === 'area') {
                drawArea(el, (series && series.t) || [], values, el.getAttribute('data-format') || 'count', color);
            } else if (kind === 'bars') {
                drawBars(el, values, color);
            } else {
                drawSpark(el, values, color);
            }
        });
    }

    // "+12 · 15m" chips comparing the newest sample with the oldest.
    function renderDeltas(series) {
        document.querySelectorAll('.dashboard [data-delta]').forEach(function (el) {
            var values = series && series[el.getAttribute('data-delta')];
            var times = series && series.t;
            if (!values || values.length < 2 || !times) {
                el.className = 'kpi-delta';
                el.textContent = '';
                return;
            }
            var diff = values[values.length - 1] - values[0];
            var span = formatSpan(times[times.length - 1] - times[0]);
            var format = el.getAttribute('data-format');
            var cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat');
            var icon = diff > 0 ? 'bi-arrow-up-short' : (diff < 0 ? 'bi-arrow-down-short' : 'bi-dash');
            var text = diff === 0 ? 'No change' : (diff > 0 ? '+' : '-') + formatValue(Math.abs(diff), format);
            el.className = 'kpi-delta ' + cls;
            el.innerHTML = '<i class="bi ' + icon + '"></i>' + text + '<span>' + span + '</span>';
            el.title = 'Change over the last ' + span;
        });
    }

    // Least-squares slope of the series, in units per second.
    function slopePerSecond(times, values) {
        var n = values.length;
        if (n < 2 || times[n - 1] === times[0]) {
            return 0;
        }
        var mt = 0;
        var mv = 0;
        for (var i = 0; i < n; i++) {
            mt += times[i];
            mv += values[i];
        }
        mt /= n;
        mv /= n;
        var num = 0;
        var den = 0;
        for (var j = 0; j < n; j++) {
            num += (times[j] - mt) * (values[j] - mv);
            den += (times[j] - mt) * (times[j] - mt);
        }
        return den ? num / den : 0;
    }

    function formatDuration(seconds) {
        var days = seconds / 86400;
        if (days >= 365) {
            return 'over a year';
        }
        if (days >= 2) {
            return '~' + Math.round(days) + ' days';
        }
        var hours = seconds / 3600;
        if (hours >= 2) {
            return '~' + Math.round(hours) + ' hours';
        }
        return '~' + Math.max(1, Math.round(seconds / 60)) + ' min';
    }

    // Write rate ("+2.1 GB/h") and time until the free space runs out.
    function renderCapacity(series) {
        document.querySelectorAll('.dashboard [data-rate], .dashboard [data-projection]').forEach(function (el) {
            var key = el.getAttribute('data-rate') || el.getAttribute('data-projection');
            var values = series && series[key];
            var times = series && series.t;
            if (!values || values.length < 3 || !times) {
                el.textContent = 'Collecting…';
                el.classList.add('ops-dim');
                return;
            }
            el.classList.remove('ops-dim');
            var rate = slopePerSecond(times, values);
            if (el.hasAttribute('data-rate')) {
                var perHour = rate * 3600;
                el.textContent = Math.abs(perHour) < 1 ? 'Flat' : (perHour > 0 ? '+' : '-') + formatBytes(Math.abs(perHour)) + '/h';
                return;
            }
            var free = parseFloat(el.getAttribute('data-free')) || 0;
            if (rate <= 0) {
                el.textContent = 'Not growing';
                el.classList.remove('ops-text-crit', 'ops-text-warn');
                return;
            }
            var seconds = free / rate;
            el.textContent = formatDuration(seconds);
            el.classList.toggle('ops-text-crit', seconds < 7 * 86400);
            el.classList.toggle('ops-text-warn', seconds >= 7 * 86400 && seconds < 30 * 86400);
        });
    }

    function sortTable(table, col, dir) {
        var tbody = table.tBodies[0];
        var rows = Array.prototype.filter.call(tbody.rows, function (r) {
            return !r.classList.contains('filter-empty') && r.cells.length > col && !r.querySelector('td[colspan]');
        });
        var key = function (row) {
            var cell = row.cells[col];
            var v = cell.getAttribute('data-sort-value');
            if (v !== null && v !== '' && !isNaN(v)) {
                return parseFloat(v);
            }
            return cell.textContent.trim().toLowerCase();
        };
        rows.sort(function (a, b) {
            var ka = key(a);
            var kb = key(b);
            var c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
            return dir === 'desc' ? -c : c;
        });
        var tail = tbody.querySelector('.filter-empty');
        rows.forEach(function (r) { tbody.insertBefore(r, tail); });
        Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, i) {
            th.removeAttribute('aria-sort');
            if (i === col) {
                th.setAttribute('aria-sort', dir === 'desc' ? 'descending' : 'ascending');
            }
        });
    }

    function wireSorting() {
        document.querySelectorAll('.dashboard table').forEach(function (table) {
            if (!table.tHead) {
                return;
            }
            Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, col) {
                if (!th.hasAttribute('data-sort')) {
                    return;
                }
                th.tabIndex = 0;
                var go = function () {
                    var dir = th.getAttribute('aria-sort') === 'ascending' ? 'desc' : 'asc';
                    sortTable(table, col, dir);
                    if (table.id) {
                        saved.sorts = saved.sorts || {};
                        saved.sorts[table.id] = { col: col, dir: dir };
                    }
                };
                th.addEventListener('click', go);
                th.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        go();
                    }
                });
            });
        });
    }

    function applyDensity() {
        var compact = false;
        try { compact = localStorage.getItem('sw-density') === 'compact'; } catch (e) {}
        document.querySelectorAll('.dashboard.ops').forEach(function (el) {
            el.classList.toggle('ops-compact', compact);
        });
        document.querySelectorAll('.dashboard [data-density-toggle]').forEach(function (btn) {
            btn.classList.toggle('active', compact);
            btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
        });
    }

    function wireDensity() {
        document.querySelectorAll('.dashboard [data-density-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var compact = !document.querySelector('.dashboard.ops.ops-compact');
                try { localStorage.setItem('sw-density', compact ? 'compact' : 'comfortable'); } catch (e) {}
                applyDensity();
                renderCharts(current);
            });
        });
        applyDensity();
    }

    function wireSwitches() {
        document.querySelectorAll('.dashboard .chart-switch').forEach(function (group) {
            group.querySelectorAll('[data-chart-target]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var target = document.querySelector(btn.getAttribute('data-chart-target'));
                    if (!target) {
                        return;
                    }
                    group.querySelectorAll('.btn').forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    target.setAttribute('data-series', btn.getAttribute('data-series'));
                    target.setAttribute('data-format', btn.getAttribute('data-format'));
                    renderCharts(current);
                });
            });
        });
    }

    function wireFilters() {
        document.querySelectorAll('.dashboard [data-table-filter]').forEach(function (input) {
            var apply = function () {
                var table = document.querySelector(input.getAttribute('data-table-filter'));
                if (!table) {
                    return;
                }
                var q = input.value.trim().toLowerCase();
                var shown = 0;
                var rows = table.querySelectorAll('tbody tr:not(.filter-empty)');
                rows.forEach(function (row) {
                    var match = !q || row.textContent.toLowerCase().indexOf(q) !== -1;
                    row.hidden = !match;
                    if (match) {
                        shown++;
                    }
                });
                var empty = table.querySelector('.filter-empty');
                if (empty) {
                    empty.hidden = shown > 0 || rows.length === 0;
                }
            };
            input.addEventListener('input', apply);
        });
    }

    // State that survives the periodic refresh swap.
    var saved = {};

    function saveState(content) {
        saved.tab = (content.querySelector('.dash-tabs .nav-link.active') || {}).id;
        var sw = content.querySelector('.chart-switch .btn.active');
        saved.series = sw && sw.getAttribute('data-series');
        saved.filters = {};
        content.querySelectorAll('[data-table-filter]').forEach(function (i) {
            saved.filters[i.getAttribute('data-table-filter')] = i.value;
        });
    }

    // Don't swap the content out from under an open menu or a focused input.
    function isBusy(content) {
        var active = document.activeElement;
        return !!content.querySelector('.dropdown-menu.show') ||
            !!(active && content.contains(active) && active.tagName === 'INPUT');
    }

    function restoreState() {
        if (saved.tab && window.bootstrap) {
            var tab = document.getElementById(saved.tab);
            if (tab) {
                bootstrap.Tab.getOrCreateInstance(tab).show();
            }
        }
        if (saved.series) {
            var btn = document.querySelector('.dashboard .chart-switch [data-series="' + saved.series + '"]');
            if (btn && !btn.classList.contains('active')) {
                btn.click();
            }
        }
        Object.keys(saved.sorts || {}).forEach(function (id) {
            var table = document.getElementById(id);
            if (table) {
                sortTable(table, saved.sorts[id].col, saved.sorts[id].dir);
            }
        });
        Object.keys(saved.filters || {}).forEach(function (sel) {
            var input = document.querySelector('.dashboard [data-table-filter="' + sel + '"]');
            if (input && saved.filters[sel]) {
                input.value = saved.filters[sel];
                input.dispatchEvent(new Event('input'));
            }
        });
    }

    var current = null;

    function init() {
        current = loadSeries();
        renderCharts(current);
        renderDeltas(current);
        renderCapacity(current);
        wireSwitches();
        wireFilters();
        wireSorting();
        wireDensity();
    }

    var resizeTimer;
    window.addEventListener('sw-theme-change', function () { renderCharts(current); });
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { renderCharts(current); }, 150);
    });

    document.body.addEventListener('htmx:beforeRequest', function (ev) {
        var content = ev.detail.elt;
        if (content && content.id === 'dashboard-content') {
            if (isBusy(content)) {
                ev.preventDefault();
                return;
            }
            saveState(content);
        }
    });
    document.body.addEventListener('htmx:afterSettle', function () {
        var content = document.getElementById('dashboard-content');
        if (content && !content.hasAttribute('data-dash-ready')) {
            content.setAttribute('data-dash-ready', '');
            init();
            restoreState();
        }
    });

    function start() {
        var content = document.getElementById('dashboard-content');
        if (content) {
            content.setAttribute('data-dash-ready', '');
        }
        init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
