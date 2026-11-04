// 뉴스: collected crypto news with sentiment filter and an article sheet.
import { html, render } from '../../core/dom.js';
import { fullDateTime, hasFiniteValue } from '../../core/format.js';
import { card, button, emptyState, skeleton, segmented, list, listRow, badge, notice } from '../../ui/components.js';
import { articleSentimentInfo, sentimentInfo, toUserText } from '../../domain/text.js';

const FILTERS = [{ value: 'all', label: '전체' }, { value: 'positive', label: '긍정' }, { value: 'neutral', label: '중립' }, { value: 'negative', label: '부정' }];
const SAFE_LINK = /^https?:\/\//i;

export default {
  id: 'news',
  resources: [],
  mount(root, ctx) {
    let filter = 'all';
    ctx.use(['news']);
    render(root, html`<div class="cp-page"><div data-slot="sentiment"></div><div data-slot="list"></div></div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function filtered() {
      const all = Array.isArray(ctx.data('news')?.news) ? ctx.data('news').news : [];
      return { all, rows: all.filter(item => filter === 'all' || articleSentimentInfo(item)?.key === filter) };
    }

    function renderAll() {
      const state = ctx.resource('news');
      const data = state.data;
      const { all, rows } = filtered();
      const raw = data?.sentiment;
      const overall = typeof raw === 'string' ? raw : raw?.overall || raw?.label;
      const score = raw?.score ?? raw?.sentimentScore ?? data?.sentimentScore;
      const info = all.length && (overall || hasFiniteValue(score)) ? sentimentInfo({ overall, score }) : null;
      render(slot('sentiment'), card({
        index: 0,
        title: '시장 분위기',
        action: button({ label: state.status === 'loading' ? '수집 중…' : '새로고침', size: 'sm', iconName: 'refresh', attrs: { 'data-action': 'reload' }, disabled: state.status === 'loading' }),
        body: !data ? (state.status === 'error' ? emptyState({ iconName: 'alert', title: '뉴스를 불러오지 못했어요', body: '연결 상태를 확인한 뒤 새로고침해 주세요.' }) : skeleton({ lines: 2 }))
          : html`<div class="cp-row-between"><div><p class="cp-headline">${info ? `${info.label} 기사 분위기` : all.length ? '기사 분위기 미제공' : '분석할 뉴스가 없어요'}</p><p class="cp-caption">${info ? `${info.copy} · 기사 ${all.length}건` : ''}</p></div>${hasFiniteValue(score) && all.length ? html`<strong class="cp-num cp-${Number(score) > 0 ? 'up' : Number(score) < 0 ? 'down' : ''}" style="font-size:24px">${Number(score) >= 0 ? '+' : ''}${Number(score).toFixed(2)}</strong>` : ''}</div>
            ${state.status === 'error' ? html`<div style="margin-top:8px">${notice({ tone: 'warning', body: '최신 뉴스를 확인하지 못해 마지막 자료를 표시해요.' })}</div>` : ''}`
      }));
      render(slot('list'), card({
        index: 1,
        title: '뉴스',
        action: segmented({ name: 'sentiment', label: '분위기 필터', value: filter, options: FILTERS }),
        body: !data ? skeleton({ lines: 6 }) : list(rows.slice(0, 80).map((item, index) => {
          const itemInfo = articleSentimentInfo(item);
          return listRow({
            as: 'button',
            attrs: { 'data-news': index },
            title: item.title || '제목 없음',
            subtitle: `${item.source || item.publisher || '출처 미상'} · ${fullDateTime(item.timestamp || item.pubDate || item.publishedAt)}`,
            trailing: badge(itemInfo?.label || '분류 없음', itemInfo?.key === 'positive' ? 'up' : itemInfo?.key === 'negative' ? 'down' : 'neutral')
          });
        }), { empty: emptyState({ iconName: 'news', title: all.length ? '선택한 분류의 뉴스가 없어요' : '표시할 뉴스가 없어요' }) })
      }));
    }

    function openArticle(index) {
      const item = filtered().rows[index];
      if (!item) return;
      const link = item.link || item.url;
      const info = articleSentimentInfo(item);
      ctx.ui.openSheet({
        title: '뉴스 확인',
        content: String(html`<p class="cp-caption">${item.source || '출처 미상'} · ${fullDateTime(item.timestamp || item.pubDate || item.publishedAt)}</p><h3 class="cp-headline">${item.title || '제목 없음'}</h3><p>${toUserText(item.description || item.content || '요약이 없습니다.')}</p><p class="cp-caption">기사 분위기: ${info?.label || '분류 자료 없음'}</p>`),
        footer: link && SAFE_LINK.test(link) ? String(html`<a class="cp-btn is-primary" href="${link}" target="_blank" rel="noopener noreferrer">원문 보기</a><button type="button" class="cp-btn is-secondary" data-sheet-close>닫기</button>`) : undefined
      });
    }

    ctx.watch([ctx.res('news')], renderAll);
    if (ctx.resource('news').status === 'idle') ctx.resources.refresh('news');
    ctx.on('click', '[data-action="reload"]', () => ctx.resources.refresh('news'));
    ctx.on('click', '[data-segment="sentiment"]', (event, target) => { filter = target.dataset.value; renderAll(); });
    ctx.on('click', '[data-news]', (event, target) => openArticle(Number(target.dataset.news)));
  }
};
