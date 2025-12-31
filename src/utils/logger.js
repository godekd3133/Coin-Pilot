import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Logger {
  constructor(logLevel = 'info') {
    this.logLevel = logLevel;
    this.logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };

    // 로그 디렉토리 생성
    this.logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // 오늘 날짜로 로그 파일명 생성
    const today = new Date().toISOString().split('T')[0];
    this.logFile = path.join(this.logDir, `trading-${today}.log`);
    this.errorFile = path.join(this.logDir, `error-${today}.log`);
  }

  /**
   * 로그 메시지 포맷팅
   */
  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let formatted = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    if (data) {
      formatted += '\n' + JSON.stringify(data, null, 2);
    }

    return formatted;
  }

  /**
   * 파일에 로그 쓰기
   */
  writeToFile(filename, message) {
    try {
      fs.appendFileSync(filename, message + '\n', 'utf8');
    } catch (error) {
      console.error('로그 파일 쓰기 실패:', error.message);
    }
  }

  /**
   * 로그 출력 여부 확인
   */
  shouldLog(level) {
    return this.logLevels[level] <= this.logLevels[this.logLevel];
  }

  /**
   * 에러 로그
   */
  error(message, data = null) {
    if (!this.shouldLog('error')) return;

    const formatted = this.formatMessage('error', message, data);
    console.error('❌', message);

    if (data) {
      console.error(data);
    }

    this.writeToFile(this.errorFile, formatted);
    this.writeToFile(this.logFile, formatted);
  }

  /**
   * 경고 로그
   */
  warn(message, data = null) {
    if (!this.shouldLog('warn')) return;

    const formatted = this.formatMessage('warn', message, data);
    console.warn('⚠️ ', message);

    if (data) {
      console.warn(data);
    }

    this.writeToFile(this.logFile, formatted);
  }

  /**
   * 정보 로그
   */
  info(message, data = null) {
    if (!this.shouldLog('info')) return;

    const formatted = this.formatMessage('info', message, data);
    console.log('ℹ️ ', message);

    if (data) {
      console.log(data);
    }

    this.writeToFile(this.logFile, formatted);
  }

  /**
   * 디버그 로그
   */
  debug(message, data = null) {
    if (!this.shouldLog('debug')) return;

    const formatted = this.formatMessage('debug', message, data);
    console.log('🔍', message);

    if (data) {
      console.log(data);
    }

    this.writeToFile(this.logFile, formatted);
  }

  /**
   * 거래 로그 (별도 파일)
   */
  trade(action, data) {
    const timestamp = new Date().toISOString();
    const tradeFile = path.join(this.logDir, 'trades.log');

    const logEntry = {
      timestamp,
      action,
      ...data
    };

    const formatted = JSON.stringify(logEntry);
    this.writeToFile(tradeFile, formatted);

    // 콘솔에도 출력
    console.log(`\n📝 거래 기록: ${action}`);
    console.log(data);
  }

  /**
   * 성과 로그 (일일 리포트)
   */
  performance(stats) {
    const performanceFile = path.join(this.logDir, 'performance.log');
    const timestamp = new Date().toISOString();

    const logEntry = {
      timestamp,
      ...stats
    };

    const formatted = JSON.stringify(logEntry);
    this.writeToFile(performanceFile, formatted);

    console.log('\n📊 성과 기록');
    console.log(stats);
  }

  /**
   * 로그 파일 정리 (7일 이상 된 파일 삭제)
   */
  cleanOldLogs(daysToKeep = 7) {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

      files.forEach(file => {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          fs.unlinkSync(filePath);
          console.log(`오래된 로그 파일 삭제: ${file}`);
        }
      });
    } catch (error) {
      console.error('로그 정리 실패:', error.message);
    }
  }

  /**
   * 일일 리포트 생성
   */
  generateDailyReport(stats) {
    const reportFile = path.join(this.logDir, `report-${new Date().toISOString().split('T')[0]}.txt`);

    let report = '='.repeat(80) + '\n';
    report += '일일 거래 리포트\n';
    report += `생성 시간: ${new Date().toLocaleString('ko-KR')}\n`;
    report += '='.repeat(80) + '\n\n';

    report += '📊 거래 통계\n';
    report += `  총 거래 횟수: ${stats.totalTrades || 0}\n`;
    report += `  승률: ${stats.winRate || '0%'}\n`;
    report += `  총 손익: ${stats.totalProfit || '0 KRW'}\n`;
    report += `  평균 손익: ${stats.avgProfit || '0 KRW'}\n\n`;

    if (stats.bestTrade) {
      report += '🏆 최고 수익 거래\n';
      report += `  수익: ${stats.bestTrade.profit} KRW\n`;
      report += `  수익률: ${stats.bestTrade.profitPercent}%\n\n`;
    }

    if (stats.worstTrade) {
      report += '📉 최대 손실 거래\n';
      report += `  손실: ${stats.worstTrade.profit} KRW\n`;
      report += `  손실률: ${stats.worstTrade.profitPercent}%\n\n`;
    }

    report += '='.repeat(80) + '\n';

    try {
      fs.writeFileSync(reportFile, report, 'utf8');
      console.log(`\n📄 일일 리포트 생성: ${reportFile}`);
    } catch (error) {
      console.error('리포트 생성 실패:', error.message);
    }

    return report;
  }
}

export default Logger;
