import { useEffect, useMemo, useState } from 'react';
import type { ArticleMetricKey, ArticleStatRecord, ArticleStatsView } from '../shared';
import { ConfirmButton, EmptyState, Icon, readableError, relativeTime } from './ui';

const METRIC_LABELS: Record<ArticleMetricKey, string> = {
  readUsers: '阅读人数', reads: '阅读次数', shareUsers: '分享人数', shares: '分享次数', likes: '点赞',
  wows: '在看', favorites: '收藏', comments: '留言', delivered: '送达人数', follows: '阅读后关注'
};

type SortKey = 'publishDate' | 'reads' | 'shareRate' | 'engageRate';

function count(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('zh-CN');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function readBase(record: ArticleStatRecord): number | null {
  return record.metrics.readUsers ?? record.metrics.reads;
}

export default function WeWriteStats({ notify }: { notify: (message: string) => void }) {
  const [view, setView] = useState<ArticleStatsView | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [sort, setSort] = useState<SortKey>('publishDate');

  useEffect(() => {
    let alive = true;
    window.sydney.getArticleStats().then(next => { if (alive) setView(next); }).catch(issue => { if (alive) setError(readableError(issue)); });
    return () => { alive = false; };
  }, []);

  const importFile = async () => {
    setImporting(true);
    try {
      const result = await window.sydney.importArticleStats();
      if (!result) return;
      setView(result.view);
      setError('');
      notify(`已导入 ${result.file}：新增 ${result.added} 篇，更新 ${result.updated} 篇`);
    } catch (issue) {
      // 解析失败的信息里带着文件实际的列名，直接展示在页面上，方便对照。
      setError(readableError(issue));
    } finally {
      setImporting(false);
    }
  };

  const remove = async (id: number) => {
    try {
      setView(await window.sydney.deleteArticleStat(id));
    } catch (issue) {
      notify(readableError(issue));
    }
  };

  const records = useMemo(() => {
    const list = [...(view?.records ?? [])];
    const value = (record: ArticleStatRecord): number => {
      if (sort === 'reads') return readBase(record) ?? -1;
      if (sort === 'shareRate') return record.shareRate ?? -1;
      return record.engageRate ?? -1;
    };
    if (sort === 'publishDate') return list;
    return list.sort((a, b) => value(b) - value(a));
  }, [view, sort]);

  const metricColumns = (view?.availableMetrics ?? []).filter(key => key !== 'delivered');
  const hasRecords = Boolean(view?.records.length);

  return <div className="ww-config">
    <section className="ww-group">
      <div className="ww-group-head">
        <div>
          <h3>导入文章数据</h3>
          <p className="ww-muted">当前公众号未认证，接口取不到数据。请在「公众号后台 → 数据分析 → 内容分析」下载单篇文章的数据明细，再在这里导入。支持 xlsx / csv；同一篇重复导入时用新数据覆盖。</p>
        </div>
        <button className="button button-primary" disabled={importing} onClick={() => void importFile()}>
          <Icon name="chart" />{importing ? '导入中…' : '选择文件导入'}
        </button>
      </div>
      {error && <p className="stats-error"><Icon name="alert" /> {error}</p>}
      {view?.lastImportedAt && <p className="ww-muted">最近一次导入：{relativeTime(view.lastImportedAt)}</p>}
    </section>

    {!view && !error && <p className="ww-muted">读取中…</p>}
    {view && !hasRecords && <EmptyState icon="chart" title="还没有文章数据">导入一份后台导出的数据表后，这里会按篇、按内容方向汇总。</EmptyState>}

    {view && hasRecords && <>
      <div className="stats-overview">
        <div className="metric"><span className="metric-label">文章数</span><strong>{view.overview.articles}</strong><small>已关联创作任务 {view.overview.matched} 篇</small></div>
        <div className="metric"><span className="metric-label">阅读中位数</span><strong>{count(view.overview.medianReads)}</strong><small>优先按阅读人数</small></div>
        <div className="metric"><span className="metric-label">累计阅读</span><strong>{count(view.overview.totalReads)}</strong><small>所有已导入文章</small></div>
        <div className="metric"><span className="metric-label">平均分享率</span><strong>{percent(view.overview.meanShareRate)}</strong><small>分享 ÷ 阅读</small></div>
      </div>

      <section className="ww-group">
        <div className="ww-group-head"><h3>按内容方向</h3><p className="ww-muted">按阅读中位数排序；篇数少时只作参考</p></div>
        <div className="stats-table-wrap">
          <table className="flow-table stats-table">
            <thead><tr><th>方向</th><th>篇数</th><th>阅读中位数</th><th>平均分享率</th><th>平均互动率</th></tr></thead>
            <tbody>{view.groups.map(group => <tr key={group.name}>
              <td>{group.name}</td><td className="num">{group.count}</td><td className="num">{count(group.medianReads)}</td>
              <td className="num">{percent(group.meanShareRate)}</td><td className="num">{percent(group.meanEngageRate)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="ww-group">
        <div className="ww-group-head">
          <h3>单篇数据</h3>
          <label className="stats-sort">排序
            <select className="input" value={sort} onChange={event => setSort(event.target.value as SortKey)}>
              <option value="publishDate">发表日期</option>
              <option value="reads">阅读</option>
              <option value="shareRate">分享率</option>
              <option value="engageRate">互动率</option>
            </select>
          </label>
        </div>
        <div className="stats-table-wrap">
          <table className="flow-table stats-table">
            <thead><tr>
              <th>标题</th><th>发表</th><th>方向</th>
              {metricColumns.map(key => <th key={key}>{METRIC_LABELS[key]}</th>)}
              <th>分享率</th><th>互动率</th>{view.availableMetrics.includes('delivered') && <th>打开率</th>}<th />
            </tr></thead>
            <tbody>{records.map(record => <tr key={record.id}>
              <td className="stats-title">{record.title}</td>
              <td className="num">{record.publishDate}</td>
              <td>{record.subdirectionName || <span className="ww-muted">未关联</span>}</td>
              {metricColumns.map(key => <td key={key} className="num">{count(record.metrics[key])}</td>)}
              <td className="num">{percent(record.shareRate)}</td>
              <td className="num">{percent(record.engageRate)}</td>
              {view.availableMetrics.includes('delivered') && <td className="num">{percent(record.openRate)}</td>}
              <td><ConfirmButton className="button button-quiet button-small" armedLabel="确认删除？" onConfirm={() => void remove(record.id)}>删除</ConfirmButton></td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="ww-muted">互动率 =（点赞 + 在看 + 收藏）÷ 阅读；打开率 = 阅读人数 ÷ 送达人数。"未关联"表示标题对不上本应用里的创作任务。</p>
      </section>
    </>}
  </div>;
}
