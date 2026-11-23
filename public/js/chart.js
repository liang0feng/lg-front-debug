/* chart.js — 把 ```chart / ```echarts 围栏里的 ECharts 子集渲染为内联 SVG。
 * 零依赖、无脚本执行；只读取数据与样式字段。
 * 支持：bar / line / pie；横向条形；多系列分组；stack；line 面积；负值。
 */

const W = 720;
const H = 320;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toVal(d) {
  if (d === null || d === undefined || d === '') return null;
  if (typeof d === 'number') return Number.isFinite(d) ? d : null;
  if (typeof d === 'string') {
    const n = Number(d);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof d === 'object') {
    if (typeof d.value === 'number' && Number.isFinite(d.value)) return d.value;
    if (typeof d.value === 'string' && Number.isFinite(Number(d.value))) return Number(d.value);
  }
  return null;
}

function trimNum(x) {
  return String(Math.round(x * 100) / 100);
}

function fmtCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  if (a >= 1e8) return trimNum(n / 1e8) + '亿';
  if (a >= 1e4) return trimNum(n / 1e4) + '万';
  return trimNum(n);
}

function fmtFull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function niceScale(min, max, count) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    if (min === 0) max = 1;
    else { min = Math.min(0, min); max = Math.max(0, max); }
  }
  const range = max - min || 1;
  const step0 = range / (count || 4);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toFixed(10)));
  }
  return { min: lo, max: hi === lo ? lo + step : hi, ticks };
}

function firstAxis(a) {
  if (Array.isArray(a)) return a[0] || null;
  return a && typeof a === 'object' ? a : null;
}

function normSeries(opt) {
  const list = Array.isArray(opt.series) ? opt.series : [];
  return list.map((s, i) => {
    const type = String(s.type || 'bar').toLowerCase();
    const color =
      s.itemStyle && typeof s.itemStyle.color === 'string' ? s.itemStyle.color : '';
    return {
      name: s.name || '系列 ' + (i + 1),
      type,
      data: Array.isArray(s.data) ? s.data : [],
      stack: s.stack || '',
      color,
      area: !!s.areaStyle,
      smooth: !!s.smooth,
    };
  });
}

function seriesColor(opt, s, i) {
  if (s.color) return s.color;
  if (Array.isArray(opt.color) && typeof opt.color[i] === 'string') return opt.color[i];
  return 'var(--chart-' + ((i % 8) + 1) + ')';
}

function tipAttr(text) {
  return ' data-chart-tip="' + esc(text) + '"';
}

/* ---------------- 直角坐标系（bar / line） ---------------- */

function renderCartesian(opt, series, title) {
  const ax = firstAxis(opt.xAxis);
  const ay = firstAxis(opt.yAxis);
  const xData = ax && Array.isArray(ax.data) ? ax.data.map(String) : null;
  const yData = ay && Array.isArray(ay.data) ? ay.data.map(String) : null;
  const xCat = !!(xData && xData.length && (!ax || ax.type !== 'value'));
  const yCat = !!(yData && yData.length && (!ay || ay.type !== 'value'));
  let horizontal = false;
  let categories;
  if (xCat) categories = xData;
  else if (yCat) { categories = yData; horizontal = true; }
  else categories = [];

  const maxLen = Math.max(categories.length, ...series.map((s) => s.data.length), 0);
  if (!maxLen) return '';
  while (categories.length < maxLen) categories.push(String(categories.length + 1));

  const values = series.map((s) => categories.map((_, i) => toVal(s.data[i])));
  const n = categories.length;

  let max = 0;
  let min = 0;
  values.forEach((row) => row.forEach((v) => {
    if (v == null) return;
    if (v > max) max = v;
    if (v < min) min = v;
  }));

  const stackKeys = new Set(series.filter((s) => s.stack).map((s) => s.stack));
  stackKeys.forEach((key) => {
    const rows = series.map((s, si) => ({ s, row: values[si] })).filter((x) => x.s.stack === key);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      rows.forEach((x) => { if (x.row[i] != null) sum += x.row[i]; });
      if (sum > max) max = sum;
      if (sum < min) min = sum;
    }
  });

  const stacked = series.length > 0 && series.every((s) => s.stack);
  const scale = niceScale(min, max, 4);
  const tickLabels = scale.ticks.map(fmtCompact);
  const maxTickLen = Math.max(...tickLabels.map((t) => t.length), 1);

  const catMaxLen = Math.max(...categories.map((c) => String(c).length), 1);
  const left = horizontal
    ? Math.min(180, Math.max(72, catMaxLen * 12 + 18))
    : Math.max(44, maxTickLen * 7 + 18);
  const right = 22;
  const top = 14;
  const bottom = horizontal ? 30 : catMaxLen > 8 && n > 3 ? 64 : 40;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const yPix = (v) => top + plotH * ((scale.max - v) / (scale.max - scale.min || 1));
  const xPix = (v) => left + plotW * ((v - scale.min) / (scale.max - scale.min || 1));
  const zeroV = Math.min(scale.max, Math.max(scale.min, 0));

  const grid = [];
  const axisText = [];
  scale.ticks.forEach((t, ti) => {
    if (horizontal) {
      const x = xPix(t);
      grid.push('<line x1="' + x + '" y1="' + top + '" x2="' + x + '" y2="' + (top + plotH) + '"/>');
      axisText.push('<text x="' + x + '" y="' + (top + plotH + 18) + '" text-anchor="middle">' + esc(tickLabels[ti]) + '</text>');
    } else {
      const y = yPix(t);
      grid.push('<line x1="' + left + '" y1="' + y + '" x2="' + (left + plotW) + '" y2="' + y + '"/>');
      axisText.push('<text x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(tickLabels[ti]) + '</text>');
    }
  });

  const band = (horizontal ? plotH : plotW) / n;
  const catLabels = [];
  const rotate = !horizontal && (n > 6 || catMaxLen > 8);
  categories.forEach((c, i) => {
    if (horizontal) {
      catLabels.push(
        '<text x="' + (left - 10) + '" y="' + (top + band * i + band / 2 + 4) + '" text-anchor="end">' + esc(c) + '</text>'
      );
    } else {
      const x = left + band * i + band / 2;
      const y = top + plotH + (rotate ? 16 : 22);
      const tr = rotate
        ? ' transform="rotate(-32 ' + x + ' ' + y + ')"'
        : '';
      catLabels.push(
        '<text x="' + x + '" y="' + y + '" text-anchor="' + (rotate ? 'end' : 'middle') + '"' + tr + '>' + esc(c) + '</text>'
      );
    }
  });

  const marks = [];
  const labels = [];

  if (horizontal) {
    const barH = Math.max(4, Math.min(24, band * 0.46));
    series.forEach((s, si) => {
      const color = seriesColor(opt, s, si);
      values[si].forEach((v, i) => {
        if (v == null) return;
        const cy = top + band * i + band / 2;
        const x0 = xPix(zeroV);
        const x1 = xPix(v);
        const x = Math.min(x0, x1);
        const w = Math.abs(x1 - x0);
        if (w < 0.5) return;
        marks.push(
          '<path class="cbar" d="' + roundedRectH(x, cy - barH / 2, w, barH, v >= 0) + '" fill="' + color + '"' +
          tipAttr(s.name + ' · ' + categories[i] + '：' + fmtFull(v)) + '></path>'
        );
        const place = n * series.length <= 8 || si === 0;
        if (place) {
          labels.push(
            '<text x="' + (v >= 0 ? x1 + 5 : x1 - 5) + '" y="' + (cy + 4) + '" text-anchor="' + (v >= 0 ? 'start' : 'end') + '">' +
            esc(fmtCompact(v)) + '</text>'
          );
        }
      });
    });
  } else {
    const stacked2 = stacked;
    const seriesSlots = stacked2 ? 1 : series.length;
    const gap = 2;
    const groupW = band * (stacked2 ? 0.5 : 0.64);
    const barW = Math.max(4, Math.min(24, (groupW - gap * (seriesSlots - 1)) / seriesSlots));
    const groupStart = (i) => left + band * i + (band - (barW * seriesSlots + gap * (seriesSlots - 1))) / 2;
    const cum = new Map();

    series.forEach((s, si) => {
      const color = seriesColor(opt, s, si);
      const slot = stacked2 ? 0 : si;
      values[si].forEach((v, i) => {
        if (v == null) return;
        const x = groupStart(i) + slot * (barW + gap);
        let startV = 0;
        if (stacked2) {
          if (!cum.has(i)) cum.set(i, 0);
          startV = cum.get(i);
          cum.set(i, startV + v);
        }
        const y0 = yPix(startV);
        const y1 = yPix(startV + v);
        const topY = Math.min(y0, y1);
        const h = Math.abs(y1 - y0);
        if (h < 0.5) return;
        const r = Math.min(4, barW / 2, h);
        marks.push(
          '<path class="cbar" d="' + roundedBarV(x, topY, barW, h, r, v >= 0) + '" fill="' + color + '"' +
          tipAttr(s.name + ' · ' + categories[i] + '：' + fmtFull(v)) + '></path>'
        );
        const place = n * series.length <= 8 || si === 0;
        if (place) {
          const ty = v >= 0 ? topY - 5 : topY + h + 13;
          labels.push(
            '<text x="' + (x + barW / 2) + '" y="' + ty + '" text-anchor="middle">' + esc(fmtCompact(v)) + '</text>'
          );
        }
      });
    });
  }

  // 折线 / 面积
  const lineSeries = series.filter((s) => s.type === 'line');
  if (lineSeries.length) {
    lineSeries.forEach((s) => {
      const si = series.indexOf(s);
      const color = seriesColor(opt, s, si);
      const pts = [];
      values[si].forEach((v, i) => {
        if (v == null) return;
        const cx = left + band * i + band / 2;
        const cy = yPix(v);
        pts.push([cx, cy, v, i]);
      });
      if (!pts.length) return;
      if (s.area) {
        const base = yPix(zeroV);
        const d =
          'M' + pts[0][0] + ',' + base +
          pts.map((p) => ' L' + p[0] + ',' + p[1]).join('') +
          ' L' + pts[pts.length - 1][0] + ',' + base + ' Z';
        marks.push('<path d="' + d + '" fill="' + color + '" fill-opacity="0.12"></path>');
      }
      marks.push(
        '<polyline d="' + pts.map((p, i) => (i ? '' : 'M') + p[0] + ',' + p[1]).join(' L') +
        '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>'
      );
      pts.forEach((p) => {
        marks.push(
          '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="4.5" fill="' + color +
          '" stroke="var(--surface)" stroke-width="2"' +
          tipAttr(s.name + ' · ' + categories[p[3]] + '：' + fmtFull(p[2])) + '></circle>'
        );
      });
      const last = pts[pts.length - 1];
      labels.push(
        '<text x="' + (last[0] + 6) + '" y="' + (last[1] - 6) + '" text-anchor="start">' + esc(fmtCompact(last[2])) + '</text>'
      );
    });
  }

  const hasAxes = !!(ax || ay);
  const aria = title || '图表';
  const svg =
    '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(aria) + '">' +
    '<g class="chart-grid">' + grid.join('') + '</g>' +
    (hasAxes ? '<line class="chart-zero" x1="' + (horizontal ? xPix(zeroV) : left) + '" y1="' + (horizontal ? top : yPix(zeroV)) +
      '" x2="' + (horizontal ? xPix(zeroV) : left + plotW) + '" y2="' + (horizontal ? top + plotH : yPix(zeroV)) + '"></line>' : '') +
    '<g class="chart-axis">' + axisText.join('') + catLabels.join('') + '</g>' +
    '<g class="chart-marks">' + marks.join('') + '</g>' +
    '<g class="chart-labels">' + labels.join('') + '</g>' +
    '</svg>';

  return {
    svg,
    series,
    categories,
    values,
    colors: series.map((s, i) => seriesColor(opt, s, i)),
    title,
    legend: series.length >= 2,
  };
}

function roundedBarV(x, y, w, h, r, positive) {
  r = Math.min(r, w / 2, h);
  if (h <= 0.5) return '';
  if (positive) {
    return 'M' + x + ',' + (y + h) + ' L' + x + ',' + (y + r) +
      ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      ' L' + (x + w - r) + ',' + y + ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      ' L' + (x + w) + ',' + (y + h) + ' Z';
  }
  return 'M' + x + ',' + y + ' L' + x + ',' + (y + h - r) +
    ' Q' + x + ',' + (y + h) + ' ' + (x + r) + ',' + (y + h) +
    ' L' + (x + w - r) + ',' + (y + h) + ' Q' + (x + w) + ',' + (y + h) + ' ' + (x + w) + ',' + (y + h - r) +
    ' L' + (x + w) + ',' + y + ' Z';
}

function roundedRectH(x, y, w, h, positive) {
  const r = Math.min(4, h / 2, w);
  if (positive) {
    return 'M' + x + ',' + y + ' L' + (x + w - r) + ',' + y +
      ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      ' L' + (x + w) + ',' + (y + h - r) + ' Q' + (x + w) + ',' + (y + h) + ' ' + (x + w - r) + ',' + (y + h) +
      ' L' + x + ',' + (y + h) + ' Z';
  }
  return 'M' + (x + w) + ',' + y + ' L' + (x + r) + ',' + y +
    ' Q' + x + ',' + y + ' ' + x + ',' + (y + r) +
    ' L' + x + ',' + (y + h - r) + ' Q' + x + ',' + (y + h) + ' ' + (x + r) + ',' + (y + h) +
    ' L' + (x + w) + ',' + (y + h) + ' Z';
}

/* ---------------- 饼图 ---------------- */

function renderPie(opt, series, title) {
  const s = series[0];
  if (!s || !Array.isArray(s.data) || !s.data.length) return '';
  let items = s.data
    .map((d) => {
      if (d && typeof d === 'object') return { name: String(d.name || ''), value: toVal(d) };
      return { name: '', value: toVal(d) };
    })
    .filter((d) => d.value != null);
  if (!items.length) return '';

  const sorted = items.slice().sort((a, b) => b.value - a.value);
  if (sorted.length > 9) {
    const head = sorted.slice(0, 8);
    const rest = sorted.slice(8).reduce((a, b) => a + b.value, 0);
    items = head.concat([{ name: '其他', value: rest }]);
  }
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!(total > 0)) return '';

  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) * 0.34;
  let angle = -Math.PI / 2;
  const marks = [];
  const legend = [];
  const colors = [];

  items.forEach((d, i) => {
    const frac = d.value / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const color = seriesColor(opt, s, i);
    colors.push(color);
    const pct = (frac * 100).toFixed(1) + '%';
    const dPath = frac >= 0.9999
      ? 'M' + (cx - r) + ',' + cy + ' a' + r + ',' + r + ' 0 1,0 ' + (r * 2) + ',0 a' + r + ',' + r + ' 0 1,0 ' + (-r * 2) + ',0'
      : 'M' + cx + ',' + cy +
        ' L' + (cx + r * Math.cos(a0)) + ',' + (cy + r * Math.sin(a0)) +
        ' A' + r + ',' + r + ' 0 ' + (frac > 0.5 ? 1 : 0) + ' 1 ' +
        (cx + r * Math.cos(a1)) + ',' + (cy + r * Math.sin(a1)) + ' Z';
    marks.push(
      '<path d="' + dPath + '" fill="' + color + '" stroke="var(--surface)" stroke-width="2"' +
      tipAttr((d.name || '数值') + '：' + fmtFull(d.value) + '（' + pct + '）') + '></path>'
    );
    legend.push(
      '<span class="chart-key"><i style="background:' + color + '"></i>' +
      esc(d.name || '系列 ' + (i + 1)) + '<em>' + fmtFull(d.value) + ' · ' + pct + '</em></span>'
    );
  });

  const svg =
    '<svg class="chart-svg chart-pie" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title || '饼图') + '">' +
    '<g class="chart-marks">' + marks.join('') + '</g>' +
    '</svg>';

  return {
    svg,
    series,
    categories: items.map((d) => d.name),
    values: [items.map((d) => d.value)],
    colors,
    title,
    legend: true,
    pie: true,
    legendHtml: legend.join(''),
    items,
    total,
  };
}

/* ---------------- 对外入口 ---------------- */

export function renderChartFence(code) {
  let json;
  try {
    json = JSON.parse(String(code || '').trim());
  } catch (e) {
    return '';
  }
  let opt = json && typeof json === 'object' ? json : null;
  if (opt && !opt.series && opt.option && opt.option.series) opt = opt.option;
  if (opt && !opt.series && opt.chart && opt.chart.series) opt = opt.chart;
  if (!opt || !Array.isArray(opt.series) || !opt.series.length) return '';

  const series = normSeries(opt);
  if (!series.length) return '';
  const types = new Set(series.map((s) => s.type));
  if (Array.from(types).some((t) => ['bar', 'line', 'pie'].indexOf(t) < 0)) return '';

  const title =
    typeof opt.title === 'string'
      ? opt.title
      : (opt.title && (opt.title.text || opt.title.subtext)) || '';

  const isPie = types.has('pie');
  if (isPie && (series.length > 1 || Array.from(types).some((t) => t !== 'pie'))) return '';

  const model = isPie ? renderPie(opt, series, title) : renderCartesian(opt, series, title);
  if (!model) return '';

  const legendHtml = model.legend
    ? '<div class="chart-legend">' +
      (model.legendHtml ||
        model.series
          .map((s, i) => '<span class="chart-key"><i style="background:' + model.colors[i] + '"></i>' + esc(s.name) + '</span>')
          .join('')) +
      '</div>'
    : '';

  // 数据表
  let table = '';
  if (model.pie) {
    table =
      '<table><thead><tr><th>名称</th><th>数值</th><th>占比</th></tr></thead><tbody>' +
      model.items
        .map(
          (d) =>
            '<tr><td>' + esc(d.name || '—') + '</td><td>' + fmtFull(d.value) + '</td><td>' +
            (model.total ? ((d.value / model.total) * 100).toFixed(1) + '%' : '—') + '</td></tr>'
        )
        .join('') +
      '</tbody></table>';
  } else {
    const head =
      '<tr><th>类别</th>' +
      model.series.map((s) => '<th>' + esc(s.name) + '</th>').join('') +
      '</tr>';
    const rows = model.categories
      .map((c, i) => {
        const cells = model.values
          .map((row) => '<td>' + (row[i] == null ? '—' : fmtFull(row[i])) + '</td>')
          .join('');
        return '<tr><td>' + esc(c) + '</td>' + cells + '</tr>';
      })
      .join('');
    table = '<table><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
  }

  const seriesNames = model.series.map((s) => s.name).join('、');
  const subtitle =
    !model.legend && !model.pie && model.series.length === 1
      ? '<span class="chart-series">' + esc(model.series[0].name) + '</span>'
      : '';

  const raw = JSON.stringify(opt);
  return (
    '<div class="chart-block" data-chart-src="' + esc(raw) + '">' +
    '<div class="chart-head"><span class="chart-kicker">图表</span>' +
    (subtitle || '<span class="chart-series">' + esc(seriesNames) + '</span>') +
    '<button type="button" class="link-btn chart-copy" data-chart-copy>复制 JSON</button></div>' +
    (title ? '<div class="chart-title">' + esc(title) + '</div>' : '') +
    '<div class="chart-scroll">' + model.svg + '</div>' +
    legendHtml +
    '<details class="chart-data"><summary>数据表</summary>' + table + '</details>' +
    '<div class="chart-tip" hidden></div>' +
    '</div>'
  );
}