// SVG charts (no canvas, no library). Colours come from CSS tokens through
// classes, so light/dark switches need no redraw.
import { html, raw } from '../core/dom.js';

function finitePoints(values) {
  return (values || []).map(Number).filter(Number.isFinite);
}

function scale(values, width, height, pad = 2) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((value, index) => [pad + index * step, pad + (height - pad * 2) * (1 - (value - min) / span)]);
}

const pathOf = coords => coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

export function sparkline(values, { width = 96, height = 32, tone = 'auto', label = '추이' } = {}) {
  const points = finitePoints(values);
  if (points.length < 2) return html`<span class="cp-spark is-empty" aria-hidden="true"></span>`;
  const resolved = tone === 'auto' ? (points.at(-1) > points[0] ? 'up' : points.at(-1) < points[0] ? 'down' : 'flat') : tone;
  const coords = scale(points, width, height);
  return html`<svg class="cp-spark is-${resolved}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}" preserveAspectRatio="none"><path d="${pathOf(coords)}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Area chart for an asset/price series. points: [{t, v}] */
export function areaChart(points, { height = 168, tone = 'auto', label = '자산 추이', formatValue = value => String(value) } = {}) {
  const rows = (points || []).filter(point => Number.isFinite(Number(point?.v)));
  if (rows.length < 2) return html`<div class="cp-area is-empty" style="height:${height}px"></div>`;
  const width = 600;
  const values = rows.map(point => Number(point.v));
  const resolved = tone === 'auto' ? (values.at(-1) > values[0] ? 'up' : values.at(-1) < values[0] ? 'down' : 'flat') : tone;
  const coords = scale(values, width, height, 6);
  const line = pathOf(coords);
  const area = `${line} L${coords.at(-1)[0].toFixed(1)} ${height} L${coords[0][0].toFixed(1)} ${height} Z`;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return html`<figure class="cp-area is-${resolved}" style="height:${height}px">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}: 최저 ${formatValue(min)}, 최고 ${formatValue(max)}">
      <defs><linearGradient id="cp-area-fill-${resolved}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="cp-area-stop-a"/><stop offset="1" class="cp-area-stop-b"/></linearGradient></defs>
      <path class="cp-area-fill" d="${area}" fill="url(#cp-area-fill-${resolved})"/>
      <path class="cp-area-line" d="${line}" vector-effect="non-scaling-stroke"/>
    </svg>
    <figcaption class="cp-area-scale"><span>${formatValue(max)}</span><span>${formatValue(min)}</span></figcaption>
  </figure>`;
}

/** Candlestick chart. candles: [{open, high, low, close}] (already validated). */
export function candleChart(candles, { height = 220, label = '가격 차트', formatValue = value => String(value) } = {}) {
  const rows = candles || [];
  if (rows.length < 2) return html`<div class="cp-area is-empty" style="height:${height}px"></div>`;
  const width = 600;
  const pad = 8;
  const highs = rows.map(row => Number(row.high));
  const lows = rows.map(row => Number(row.low));
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const span = max - min || max || 1;
  const y = value => pad + (height - pad * 2) * (1 - (value - min) / span);
  const slot = (width - pad * 2) / rows.length;
  const body = Math.max(1.5, slot * 0.62);
  const marks = rows.map((row, index) => {
    const x = pad + slot * index + slot / 2;
    const open = Number(row.open);
    const close = Number(row.close);
    const rising = close >= open;
    const top = y(Math.max(open, close));
    const bottom = y(Math.min(open, close));
    return `<g class="${rising ? 'is-up' : 'is-down'}"><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(Number(row.high)).toFixed(1)}" y2="${y(Number(row.low)).toFixed(1)}"/><rect x="${(x - body / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${body.toFixed(1)}" height="${Math.max(1, bottom - top).toFixed(1)}" rx="1"/></g>`;
  }).join('');
  return html`<figure class="cp-candles" style="height:${height}px">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}: 최저 ${formatValue(min)}, 최고 ${formatValue(max)}">${raw(marks)}</svg>
    <figcaption class="cp-area-scale"><span>${formatValue(max)}</span><span>${formatValue(min)}</span></figcaption>
  </figure>`;
}
