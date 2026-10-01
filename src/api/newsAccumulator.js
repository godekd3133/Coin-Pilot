/**
 * 뉴스 누적 저장소 — 서버 시작 이후 유입된 뉴스를 중복 제거해 보존한다.
 * HTTP/소켓 의존이 없는 순수 저장소이며, 정렬·퇴거·필터만 담당한다.
 */
export const MAX_NEWS_RETENTION_LIMIT = 2000;
const NEWS_ACCUMULATION_BATCH_SIZE = 2000;

export class NewsAccumulator {
  constructor({ retentionLimit = MAX_NEWS_RETENTION_LIMIT } = {}) {
    if (!Number.isSafeInteger(retentionLimit) ||
      retentionLimit < 1 || retentionLimit > MAX_NEWS_RETENTION_LIMIT) {
      throw new RangeError(`newsRetentionLimit must be an integer from 1 to ${MAX_NEWS_RETENTION_LIMIT}`);
    }
    this.retentionLimit = retentionLimit;
    this.items = [];                // 최신순으로 정렬된 보존 뉴스
    this.seenKeys = new Set();      // 보존 뉴스의 중복 키 (title+link)
    this.startedAt = new Date();
  }

  generateKey(news) {
    const title = (news.title || '').toLowerCase().trim().slice(0, 100);
    const link = (news.link || '').toLowerCase().trim();
    return `${title}::${link}`;
  }

  /** 뉴스 누적 (중복 제거). 추가된 개수를 반환한다. */
  add(newsList, source = 'general') {
    if (!Array.isArray(newsList)) return 0;

    let addedCount = 0;
    const now = new Date();

    for (let batchStart = 0; batchStart < newsList.length; batchStart += NEWS_ACCUMULATION_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + NEWS_ACCUMULATION_BATCH_SIZE, newsList.length);
      let batchAdded = false;

      for (let index = batchStart; index < batchEnd; index++) {
        const news = newsList[index];
        if (!news || !news.title) continue;

        const key = this.generateKey(news);
        if (this.seenKeys.has(key)) continue;

        this.seenKeys.add(key);
        this.items.push({
          ...news,
          accumulatedAt: now,
          sourceCategory: source,
          id: `news_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        });
        addedCount++;
        batchAdded = true;
      }

      // Bound temporary rows and sort/evict once per input batch, rather than
      // sorting the retained array after every incoming article.
      if (batchAdded) {
        this.items.sort((a, b) => {
          const timeA = new Date(a.timestamp || a.accumulatedAt);
          const timeB = new Date(b.timestamp || b.accumulatedAt);
          return timeB - timeA;
        });

        while (this.items.length > this.retentionLimit) {
          const evicted = this.items.pop();
          this.seenKeys.delete(this.generateKey(evicted));
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[NewsAccumulator] ${addedCount}개 뉴스 추가됨 (총 ${this.items.length}개)`);
    }

    return addedCount;
  }

  getNews(options = {}) {
    const { limit = 100, coin = null, source = null } = options;

    let filtered = this.items;

    if (coin) {
      const symbol = coin.replace('KRW-', '').toLowerCase();
      filtered = filtered.filter(news => {
        const title = (news.title || '').toLowerCase();
        const content = (news.content || '').toLowerCase();
        return title.includes(symbol) || content.includes(symbol);
      });
    }

    if (source) {
      filtered = filtered.filter(news =>
        (news.source || '').toLowerCase().includes(source.toLowerCase()) ||
        (news.sourceCategory || '').toLowerCase().includes(source.toLowerCase())
      );
    }

    return {
      news: filtered.slice(0, limit),
      total: filtered.length,
      totalAccumulated: this.items.length,
      accumulatorStartTime: this.startedAt
    };
  }
}

export default NewsAccumulator;
