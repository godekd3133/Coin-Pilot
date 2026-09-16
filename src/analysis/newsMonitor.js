import axios from 'axios';
import * as cheerio from 'cheerio';
import Sentiment from 'sentiment';

class NewsMonitor {
  constructor() {
    this.sentiment = new Sentiment();
    this.newsCache = new Map();
    this.coinNewsCache = new Map(); // 코인별 뉴스 캐시
    this.coinSentimentCache = new Map(); // 코인별 감성 캐시
    this.lastCheckTime = null;

    // 코인 이름 매핑 (검색용)
    this.coinNames = {
      'KRW-BTC': { en: 'Bitcoin', ko: '비트코인', symbol: 'BTC', twitter: '$BTC' },
      'KRW-ETH': { en: 'Ethereum', ko: '이더리움', symbol: 'ETH', twitter: '$ETH' },
      'KRW-XRP': { en: 'Ripple XRP', ko: '리플', symbol: 'XRP', twitter: '$XRP' },
      'KRW-SOL': { en: 'Solana', ko: '솔라나', symbol: 'SOL', twitter: '$SOL' },
      'KRW-DOGE': { en: 'Dogecoin', ko: '도지코인', symbol: 'DOGE', twitter: '$DOGE' },
      'KRW-ADA': { en: 'Cardano', ko: '에이다', symbol: 'ADA', twitter: '$ADA' },
      'KRW-AVAX': { en: 'Avalanche', ko: '아발란체', symbol: 'AVAX', twitter: '$AVAX' },
      'KRW-DOT': { en: 'Polkadot', ko: '폴카닷', symbol: 'DOT', twitter: '$DOT' },
      'KRW-POL': { en: 'Polygon', ko: '폴리곤', symbol: 'POL', twitter: '$POL' },
      'KRW-LINK': { en: 'Chainlink', ko: '체인링크', symbol: 'LINK', twitter: '$LINK' },
      'KRW-ATOM': { en: 'Cosmos', ko: '코스모스', symbol: 'ATOM', twitter: '$ATOM' },
      'KRW-TRX': { en: 'Tron', ko: '트론', symbol: 'TRX', twitter: '$TRX' },
      'KRW-SHIB': { en: 'Shiba Inu', ko: '시바이누', symbol: 'SHIB', twitter: '$SHIB' },
      'KRW-NEAR': { en: 'NEAR Protocol', ko: '니어프로토콜', symbol: 'NEAR', twitter: '$NEAR' },
      'KRW-APT': { en: 'Aptos', ko: '앱토스', symbol: 'APT', twitter: '$APT' },
      'KRW-ARB': { en: 'Arbitrum', ko: '아비트럼', symbol: 'ARB', twitter: '$ARB' },
      'KRW-OP': { en: 'Optimism', ko: '옵티미즘', symbol: 'OP', twitter: '$OP' },
      'KRW-SUI': { en: 'Sui', ko: '수이', symbol: 'SUI', twitter: '$SUI' },
      'KRW-SEI': { en: 'Sei', ko: '세이', symbol: 'SEI', twitter: '$SEI' },
      'KRW-PEPE': { en: 'Pepe', ko: '페페', symbol: 'PEPE', twitter: '$PEPE' }
    };
  }

  /**
   * 코인 이름 정보 가져오기 (없으면 동적 생성)
   */
  getCoinInfo(coin) {
    if (this.coinNames[coin]) {
      return this.coinNames[coin];
    }
    // 동적 생성
    const symbol = coin.replace('KRW-', '');
    return {
      en: symbol,
      ko: symbol,
      symbol: symbol,
      twitter: `$${symbol}`
    };
  }

  /**
   * Twitter/X 뉴스 수집 (Nitter 미러 및 RSS 사용)
   * @param {string} query - 검색 쿼리 ($BTC, $ETH 등)
   */
  async fetchTwitterNews(query = '$BTC OR $ETH cryptocurrency') {
    const articles = [];

    // 여러 Nitter 미러 시도
    const nitterMirrors = [
      'nitter.net',
      'nitter.privacydev.net',
      'nitter.poast.org'
    ];

    for (const mirror of nitterMirrors) {
      try {
        const searchUrl = `https://${mirror}/search?f=tweets&q=${encodeURIComponent(query)}`;

        const response = await axios.get(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 8000
        });

        const $ = cheerio.load(response.data);

        // Nitter 트윗 파싱
        $('.timeline-item').each((i, element) => {
          const content = $(element).find('.tweet-content').text().trim();
          const username = $(element).find('.username').text().trim();
          const tweetLink = $(element).find('.tweet-link').attr('href');
          const timestamp = $(element).find('.tweet-date a').attr('title');

          if (content && content.length > 20) {
            articles.push({
              title: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
              link: tweetLink ? `https://twitter.com${tweetLink.replace('/status/', '/status/')}` : '',
              source: `X/@${username || 'unknown'}`,
              timestamp: timestamp ? new Date(timestamp) : new Date(),
              isTwitter: true
            });
          }
        });

        if (articles.length > 0) {
          console.log(`✓ Twitter/X (${mirror}): ${articles.length}개 트윗 수집`);
          break; // 성공하면 다음 미러 시도 안함
        }
      } catch {
        // 조용히 다음 미러 시도
        continue;
      }
    }

    // Nitter 실패 시 대체 소스 시도 (crypto Twitter aggregator)
    if (articles.length === 0) {
      try {
        // CryptoPanic Twitter feed (public API)
        const response = await axios.get('https://cryptopanic.com/api/v1/posts/?auth_token=free&filter=hot&kind=news', {
          headers: {
            'User-Agent': 'Mozilla/5.0'
          },
          timeout: 8000
        });

        if (response.data?.results) {
          response.data.results.slice(0, 15).forEach(item => {
            if (item.source?.domain?.includes('twitter') || item.kind === 'media') {
              articles.push({
                title: item.title,
                link: item.url,
                source: `X/${item.source?.title || 'Crypto'}`,
                timestamp: new Date(item.published_at),
                isTwitter: true
              });
            }
          });
        }
      } catch {
        // CryptoPanic도 실패시 무시
      }
    }

    return articles.slice(0, 15);
  }

  /**
   * 코인별 뉴스 수집
   * @param {string} coin - 마켓 코드 (예: KRW-BTC)
   */
  async fetchCoinSpecificNews(coin) {
    const coinInfo = this.getCoinInfo(coin);
    const allNews = [];

    try {
      // 병렬로 여러 소스에서 뉴스 수집
      const results = await Promise.allSettled([
        // 영문 Google News
        this.fetchGoogleNews(`${coinInfo.en} cryptocurrency news`),
        // 한글 Google News
        this.fetchGoogleNewsKR(`${coinInfo.ko} 암호화폐`),
        // Twitter/X
        this.fetchTwitterNews(`${coinInfo.twitter} OR ${coinInfo.symbol}`)
      ]);

      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value?.length > 0) {
          allNews.push(...result.value);
        }
      });

      // 중복 제거
      const uniqueNews = Array.from(
        new Map(allNews.map(item => [item.title, item])).values()
      );

      // 감성 분석 추가
      const analyzedNews = uniqueNews.map(news => ({
        ...news,
        coin: coin,
        sentiment: this.analyzeSentiment(news.title)
      }));

      // 코인별 캐시에 저장
      this.coinNewsCache.set(coin, {
        news: analyzedNews,
        timestamp: new Date()
      });

      return analyzedNews;
    } catch (error) {
      console.error(`${coin} 뉴스 수집 오류:`, error.message);
      return [];
    }
  }

  /**
   * 코인별 감성 점수 조회 (캐시 활용)
   * @param {string} coin - 마켓 코드
   * @param {number} maxAgeMs - 캐시 유효시간 (기본 10분)
   */
  async getCoinSentiment(coin, maxAgeMs = 600000) {
    // 캐시 확인
    const cached = this.coinSentimentCache.get(coin);
    if (cached && (Date.now() - cached.timestamp.getTime()) < maxAgeMs) {
      return cached.sentiment;
    }

    // 뉴스 수집 (캐시된 뉴스 사용 또는 새로 수집)
    let news;
    const cachedNews = this.coinNewsCache.get(coin);

    if (cachedNews && (Date.now() - cachedNews.timestamp.getTime()) < maxAgeMs) {
      news = cachedNews.news;
    } else {
      news = await this.fetchCoinSpecificNews(coin);
    }

    if (news.length === 0) {
      return {
        coin: coin,
        overall: 'neutral',
        score: 0,
        newsCount: 0,
        recommendation: 'HOLD',
        confidence: 0
      };
    }

    // 감성 분석
    const sentiment = this.analyzeMarketSentiment(news);
    const result = {
      coin: coin,
      ...sentiment,
      lastUpdate: new Date()
    };

    // 캐시 저장
    this.coinSentimentCache.set(coin, {
      sentiment: result,
      timestamp: new Date()
    });

    return result;
  }

  /**
   * 여러 코인의 감성을 한번에 분석
   * @param {Array<string>} coins - 코인 목록
   */
  async getMultiCoinSentiment(coins) {
    const results = {};

    // 병렬로 처리하되 너무 많으면 배치로 나눔
    const batchSize = 5;
    for (let i = 0; i < coins.length; i += batchSize) {
      const batch = coins.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(coin => this.getCoinSentiment(coin))
      );

      batchResults.forEach((result, idx) => {
        const coin = batch[idx];
        if (result.status === 'fulfilled') {
          results[coin] = result.value;
        } else {
          results[coin] = {
            coin: coin,
            overall: 'neutral',
            score: 0,
            newsCount: 0,
            recommendation: 'HOLD',
            error: result.reason?.message
          };
        }
      });

      // 배치 간 잠시 대기 (rate limiting 방지)
      if (i + batchSize < coins.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }

  /**
   * 코인데스크 뉴스 크롤링
   */
  async fetchCoinDeskNews() {
    try {
      const response = await axios.get('https://www.coindesk.com/tag/bitcoin/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const articles = [];

      $('.card-title').each((i, element) => {
        const title = $(element).text().trim();
        const link = $(element).find('a').attr('href');

        if (title && link) {
          articles.push({
            title,
            link: link.startsWith('http') ? link : `https://www.coindesk.com${link}`,
            source: 'CoinDesk',
            timestamp: new Date()
          });
        }
      });

      return articles.slice(0, 10);
    } catch (error) {
      console.error('CoinDesk 뉴스 크롤링 오류:', error.message);
      return [];
    }
  }

  /**
   * 코인텔레그래프 뉴스 크롤링
   */
  async fetchCoinTelegraphNews() {
    try {
      const response = await axios.get('https://cointelegraph.com/tags/bitcoin', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const articles = [];

      $('article').each((i, element) => {
        const title = $(element).find('.post-card-inline__title').text().trim();
        const link = $(element).find('a').attr('href');

        if (title && link) {
          articles.push({
            title,
            link: link.startsWith('http') ? link : `https://cointelegraph.com${link}`,
            source: 'CoinTelegraph',
            timestamp: new Date()
          });
        }
      });

      return articles.slice(0, 10);
    } catch (error) {
      console.error('CoinTelegraph 뉴스 크롤링 오류:', error.message);
      return [];
    }
  }

  /**
   * 네이버 뉴스 검색 (업데이트된 URL)
   */
  async fetchNaverNews(query = '비트코인') {
    try {
      // 네이버 뉴스 검색 URL (업데이트됨)
      const response = await axios.get(`https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(query)}&sm=tab_opt&sort=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const articles = [];

      // 네이버 뉴스 검색 결과 파싱
      $('.news_tit').each((i, element) => {
        const title = $(element).attr('title') || $(element).text().trim();
        const link = $(element).attr('href');

        if (title && link) {
          articles.push({
            title,
            link,
            source: 'Naver',
            timestamp: new Date()
          });
        }
      });

      // 대체 선택자 시도
      if (articles.length === 0) {
        $('a.news_tit, .news_area a.news_tit, .list_news a.news_tit').each((i, element) => {
          const title = $(element).attr('title') || $(element).text().trim();
          const link = $(element).attr('href');

          if (title && link) {
            articles.push({
              title,
              link,
              source: 'Naver',
              timestamp: new Date()
            });
          }
        });
      }

      return articles.slice(0, 10);
    } catch (error) {
      console.error('네이버 뉴스 크롤링 오류:', error.message);
      return [];
    }
  }

  /**
   * Google News RSS 크롤링
   */
  async fetchGoogleNews(query = 'bitcoin cryptocurrency') {
    try {
      // Google News RSS 피드 사용
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

      const response = await axios.get(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      const articles = [];

      $('item').each((i, element) => {
        const title = $(element).find('title').text().trim();
        const link = $(element).find('link').text().trim();
        const pubDate = $(element).find('pubDate').text().trim();

        if (title && link) {
          articles.push({
            title,
            link,
            source: 'Google News',
            timestamp: pubDate ? new Date(pubDate) : new Date()
          });
        }
      });

      return articles.slice(0, 10);
    } catch (error) {
      console.error('Google News 크롤링 오류:', error.message);
      return [];
    }
  }

  /**
   * Google News 한국어 뉴스 크롤링
   */
  async fetchGoogleNewsKR(query = '비트코인 암호화폐') {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;

      const response = await axios.get(rssUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      const articles = [];

      $('item').each((i, element) => {
        const title = $(element).find('title').text().trim();
        const link = $(element).find('link').text().trim();
        const pubDate = $(element).find('pubDate').text().trim();

        if (title && link) {
          articles.push({
            title,
            link,
            source: 'Google News KR',
            timestamp: pubDate ? new Date(pubDate) : new Date()
          });
        }
      });

      return articles.slice(0, 10);
    } catch (error) {
      console.error('Google News KR 크롤링 오류:', error.message);
      return [];
    }
  }

  /**
   * 감성 분석 수행
   * @param {string} text - 분석할 텍스트
   * @returns {Object} 감성 분석 결과
   */
  analyzeSentiment(text) {
    const result = this.sentiment.analyze(text);

    // 키워드 기반 추가 분석 (한글 지원)
    const positiveKeywords = ['상승', '호재', '급등', '강세', '랠리', '돌파', '상향', '긍정', '투자', '채택', 'bullish', 'surge', 'gain', 'positive', 'adoption'];
    const negativeKeywords = ['하락', '악재', '급락', '약세', '폭락', '붕괴', '하향', '부정', '규제', '금지', 'bearish', 'crash', 'drop', 'negative', 'regulation', 'ban'];

    let additionalScore = 0;
    const lowerText = text.toLowerCase();

    positiveKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) additionalScore += 1;
    });

    negativeKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) additionalScore -= 1;
    });

    const totalScore = result.score + additionalScore;
    const comparative = result.comparative + (additionalScore / text.split(' ').length);

    return {
      score: totalScore,
      comparative: comparative,
      sentiment: totalScore > 0 ? 'positive' : totalScore < 0 ? 'negative' : 'neutral',
      confidence: Math.abs(comparative)
    };
  }

  /**
   * 모든 뉴스 소스에서 뉴스 수집 및 분석
   */
  async collectAndAnalyzeNews() {
    console.log('\n=== 뉴스 수집 및 분석 시작 ===');
    this.lastCheckTime = new Date();

    const allNews = [];

    // 여러 소스에서 동시에 뉴스 수집 (Twitter/X 추가)
    const results = await Promise.allSettled([
      this.fetchCoinDeskNews(),
      this.fetchCoinTelegraphNews(),
      this.fetchNaverNews(),
      this.fetchGoogleNews(),
      this.fetchGoogleNewsKR(),
      this.fetchTwitterNews('$BTC OR $ETH OR crypto')
    ]);

    // 성공한 결과만 수집
    results.forEach((result, index) => {
      const sourceNames = ['CoinDesk', 'CoinTelegraph', 'Naver', 'Google News', 'Google News KR', 'Twitter/X'];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        console.log(`✓ ${sourceNames[index]}: ${result.value.length}개 뉴스 수집`);
        allNews.push(...result.value);
      } else if (result.status === 'rejected') {
        console.log(`✗ ${sourceNames[index]}: 수집 실패`);
      }
    });

    // 중복 제거 (제목 기준)
    const uniqueNews = Array.from(
      new Map(allNews.map(item => [item.title, item])).values()
    );

    // 각 뉴스에 감성 분석 추가
    const analyzedNews = uniqueNews.map(news => {
      const sentimentResult = this.analyzeSentiment(news.title);

      return {
        ...news,
        sentiment: sentimentResult
      };
    });

    // 캐시에 저장
    analyzedNews.forEach(news => {
      this.newsCache.set(news.title, news);
    });

    // 캐시 크기 제한 (최근 100개만 유지)
    if (this.newsCache.size > 100) {
      const keysToDelete = Array.from(this.newsCache.keys()).slice(0, this.newsCache.size - 100);
      keysToDelete.forEach(key => this.newsCache.delete(key));
    }

    return analyzedNews;
  }

  /**
   * 모든 소스에서 뉴스만 가져오기 (분석 없이, 누적용)
   * @returns {Array} 수집된 뉴스 배열
   */
  async fetchAllNews() {
    console.log('[NewsMonitor] 전체 뉴스 수집 시작...');

    const allNews = [];

    // 여러 소스에서 동시에 뉴스 수집
    const results = await Promise.allSettled([
      this.fetchCoinDeskNews(),
      this.fetchCoinTelegraphNews(),
      this.fetchNaverNews(),
      this.fetchGoogleNews(),
      this.fetchGoogleNewsKR(),
      this.fetchTwitterNews('$BTC OR $ETH OR crypto')
    ]);

    const sourceNames = ['CoinDesk', 'CoinTelegraph', 'Naver', 'Google News', 'Google News KR', 'Twitter/X'];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        // 소스 정보 추가
        const newsWithSource = result.value.map(news => ({
          ...news,
          sourceCategory: sourceNames[index]
        }));
        allNews.push(...newsWithSource);
      }
    });

    console.log(`[NewsMonitor] 총 ${allNews.length}개 뉴스 수집 완료`);
    return allNews;
  }

  /**
   * 뉴스 기반 시장 심리 분석
   * @param {Array} news - 분석할 뉴스 배열
   * @returns {Object} 시장 심리 분석 결과
   */
  analyzeMarketSentiment(news) {
    if (!news || news.length === 0) {
      return {
        overall: 'neutral',
        score: 0,
        positiveCount: 0,
        negativeCount: 0,
        neutralCount: 0,
        recommendation: 'HOLD'
      };
    }

    let totalScore = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;

    news.forEach(item => {
      // sentiment가 없으면 실시간 분석
      let sentimentData = item.sentiment;
      if (!sentimentData && item.title) {
        sentimentData = this.analyzeSentiment(item.title);
      }

      if (!sentimentData) {
        neutralCount++;
        return;
      }

      totalScore += sentimentData.score || 0;

      if (sentimentData.sentiment === 'positive') {
        positiveCount++;
      } else if (sentimentData.sentiment === 'negative') {
        negativeCount++;
      } else {
        neutralCount++;
      }
    });

    const avgScore = totalScore / news.length;
    const positiveRatio = positiveCount / news.length;
    const negativeRatio = negativeCount / news.length;

    let overall = 'neutral';
    let recommendation = 'HOLD';

    if (avgScore > 2 && positiveRatio > 0.6) {
      overall = 'very positive';
      recommendation = 'BUY';
    } else if (avgScore > 0 && positiveRatio > 0.5) {
      overall = 'positive';
      recommendation = 'BUY';
    } else if (avgScore < -2 && negativeRatio > 0.6) {
      overall = 'very negative';
      recommendation = 'SELL';
    } else if (avgScore < 0 && negativeRatio > 0.5) {
      overall = 'negative';
      recommendation = 'SELL';
    }

    return {
      overall,
      score: avgScore.toFixed(2),
      positiveCount,
      negativeCount,
      neutralCount,
      positiveRatio: (positiveRatio * 100).toFixed(1) + '%',
      negativeRatio: (negativeRatio * 100).toFixed(1) + '%',
      recommendation,
      totalNews: news.length
    };
  }

  /**
   * 최근 뉴스 요약 출력
   */
  printNewsSummary(news, limit = 5) {
    console.log('\n📰 최근 암호화폐 뉴스:');
    console.log('─'.repeat(80));

    news.slice(0, limit).forEach((item, index) => {
      const sentimentEmoji =
        item.sentiment.sentiment === 'positive' ? '📈' :
        item.sentiment.sentiment === 'negative' ? '📉' : '➖';

      console.log(`\n${index + 1}. ${sentimentEmoji} [${item.source}] ${item.title}`);
      console.log(`   감성: ${item.sentiment.sentiment} (점수: ${item.sentiment.score.toFixed(2)})`);
      console.log(`   링크: ${item.link}`);
    });

    console.log('\n' + '─'.repeat(80));
  }

  /**
   * 긴급 뉴스 감지 (큰 가격 변동 예상)
   */
  detectUrgentNews(news) {
    const urgentKeywords = [
      '급등', '급락', '폭등', '폭락', '규제', '금지', '승인', '채택',
      'crash', 'surge', 'ban', 'regulation', 'approval', 'adoption'
    ];

    return news.filter(item => {
      const title = item.title.toLowerCase();
      return urgentKeywords.some(keyword => title.includes(keyword));
    });
  }
}

export default NewsMonitor;
