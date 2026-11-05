// 더보기 (mobile): every non-tab destination from the registry, grouped.
import { html, render } from '../../core/dom.js';
import { card, icon } from '../../ui/components.js';

export default {
  id: 'more',
  resources: [],
  mount(root, ctx) {
    const items = ctx.registry.moreItems();
    const groups = [...new Set(items.map(item => item.group))];
    render(root, html`<div class="cp-page">${groups.map((group, index) => card({
      index,
      title: group,
      body: html`<div class="cp-more-grid">${items.filter(item => item.group === group).map(item => html`<a class="cp-more-item" href="#/${item.id}">${icon(item.icon, { size: 24 })}<strong>${item.label}</strong></a>`)}</div>`
    }))}</div>`);
  }
};
