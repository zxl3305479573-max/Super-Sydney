import test from 'node:test';
import assert from 'node:assert/strict';
import { XHS_CARD_LAYOUTS, XHS_CARD_STYLES } from '../services/xhs-catalog.ts';
import {
  buildQuickCardPlan, cardPageLines, linesToCardItems, parsePointLine, renderCardDocument, renderCardsPreview, resolveCardLayout, richCardText
} from '../services/xhs-cards.ts';

test('全部主题骨架与 8 种分镜母版均可稳定渲染 1080×1440 内聚画框', () => {
  for (const style of XHS_CARD_STYLES) {
    for (const layout of XHS_CARD_LAYOUTS) {
      const html = renderCardDocument({
        style: style.key,
        pages: [{
          layout: layout.key,
          kicker: '路径 01 · 开店门槛',
          heading: '千帆开店【硬性条件】',
          lead: '有自有货源且能履约售后的人再选开店，否则先走商单或买手。',
          stats: [{ value: '>180天', label: '账号入驻时长' }, { value: '≥1000粉', label: '粉丝门槛' }],
          items: [
            { title: '❌ 盲目新照秒交', detail: '新办个体户工商同步慢，当天提报会提示【系统未查到】', badge: '避坑' },
            { title: '✅ 等满 14 天提报', detail: '到 `千帆电脑端` 自荐提报，电子资源另需月流水【>6000元】证明', badge: '实操' },
            { title: '企业蓝V认证', detail: '目前仅企业专业号支持开设个体店，审核约 14 个工作日', badge: '硬门槛' },
            { title: '商机中心激励', detail: '开店后发商品笔记可拿潜力商品流量扶持', badge: '红利' }
          ],
          points: [],
          emphasis: '开店本身不限流也不白送流量，核心仍看内容转化力'
        }]
      }, 0, '小红书五大变现途径');
      assert.match(html, /^<!doctype html>/);
      assert.match(html, /width:1080px;height:1440px/);
      assert.ok(html.includes(`layout-${layout.key}`), `${style.key}/${layout.key} 应带对应版式类名`);
      assert.ok(html.includes('<mark>硬性条件</mark>'), '标题支持荧光笔高亮');
      assert.ok(html.includes('<code>千帆电脑端</code>'), '细节支持路径胶囊');
      assert.ok(html.includes('&gt;6000元'), '保留具体门槛数字并正确做 HTML 转义');
    }
  }
});

test('轻量富文本：转义危险标签，同时解析【高亮】、**加粗** 与 `代码胶囊`', () => {
  const rendered = richCardText('<script>alert(1)</script> 满【1000粉】开通 **蒲公英**，入口在 `创作中心→博主合作`');
  assert.ok(!rendered.includes('<script>'));
  assert.ok(rendered.includes('&lt;script&gt;'));
  assert.ok(rendered.includes('<mark>1000粉</mark>'));
  assert.ok(rendered.includes('<strong>蒲公英</strong>'));
  assert.ok(rendered.includes('<code>创作中心→博主合作</code>'));
});

test('逐页文本行与结构化条目无损互转，老笔记纯字符串也能拆出小标题', () => {
  assert.deepEqual(parsePointLine('[≥1000粉] 蒲公英商单：图文与视频分开报价'), {
    badge: '≥1000粉',
    title: '蒲公英商单',
    detail: '图文与视频分开报价'
  });
  const roundtrip = linesToCardItems([
    '[免保证金] 个人售卖：注册满【30天】无违规即可在私信闭环收款',
    '纯单句干货不带冒号也能保留'
  ]);
  assert.equal(roundtrip.items.length, 2);
  assert.equal(roundtrip.items[0].badge, '免保证金');
  assert.equal(roundtrip.items[0].title, '个人售卖');
  assert.equal(roundtrip.items[1].title, '');
  assert.deepEqual(cardPageLines({ heading: 'H', points: roundtrip.points, items: roundtrip.items, emphasis: '' }), roundtrip.points);
});

test('版式自动推断与单页放大预览', () => {
  const singlePlan = {
    style: 'bento',
    pages: [
      { heading: '一图看懂', points: ['路径一：商单', '路径二：买手', '路径三：开店', '路径四：咨询'], emphasis: '' },
      { heading: '正反对比', points: ['❌ 误区：没跑通就投薯条', '✅ 正解：挑高收藏笔记投聚光搜索'], emphasis: '' }
    ]
  };
  assert.equal(resolveCardLayout(singlePlan.pages[0], 0, 1), 'bento');
  assert.equal(resolveCardLayout(singlePlan.pages[1], 1, 2), 'compare');
  const allPreview = renderCardsPreview(singlePlan, '测试标题');
  assert.equal(allPreview.split('class="frame"').length - 1, 2);
  const focusedPreview = renderCardsPreview(singlePlan, '测试标题', 0.25, null, 1);
  assert.equal(focusedPreview.split('class="frame"').length - 1, 1, '聚焦单页预览只渲染选中的那一页');
  assert.ok(focusedPreview.includes('正反对比') && !focusedPreview.includes('一图看懂'));
});

test('IP 角色出现频率（bookends / none）与联动 IP 品牌强调色生效', () => {
  const kit = {
    id: 'ip1', name: '测试IP', tagline: '口号',
    colors: { primary: '#122334', accent: '#AA33CC', secondary: '#22AA88' },
    avatar: '',
    poses: [{ id: 'p1', label: '指', src: 'data:image/png;base64,AA' }]
  };
  const basePages = [0, 1, 2, 3].map(idx => ({ heading: `P${idx + 1}`, points: ['要点'], emphasis: '' }));
  const bookendsPlan = { style: 'swiss', mascotMode: 'bookends' as const, useIpPalette: true, pages: basePages };
  const firstHtml = renderCardDocument(bookendsPlan, 0, '标题', kit);
  const middleHtml = renderCardDocument(bookendsPlan, 1, '标题', kit);
  const lastHtml = renderCardDocument(bookendsPlan, 3, '标题', kit);
  assert.ok(firstHtml.includes('ip-mascot') && lastHtml.includes('ip-mascot'), '首尾页保留角色');
  assert.ok(!middleHtml.includes('ip-mascot'), 'bookends 模式下中间页不放角色');
  assert.ok(middleHtml.includes('#AA33CC'), 'useIpPalette 开启时注入 IP 强调色');

  const noneHtml = renderCardDocument({ ...bookendsPlan, mascotMode: 'none' }, 0, '标题', kit);
  assert.ok(!noneHtml.includes('ip-mascot'), 'none 模式下不放角色');
});

test('13 套多骨架卡片风格与新增 qa / quote 母版及免 AI 快速拆卡均可正常工作', () => {
  assert.ok(XHS_CARD_STYLES.length >= 13, '提供至少 13 套差异化卡片风格');
  assert.ok(XHS_CARD_LAYOUTS.some(item => item.key === 'qa') && XHS_CARD_LAYOUTS.some(item => item.key === 'quote'));

  const qaPage = {
    heading: '高频答疑',
    points: ['Q：低粉期要不要投薯条？ :: 先把自然点击率跑到 10% 以上再测付费', 'Q：没有货源怎么起步？ :: 走专业号 0 粉买手橱窗或个人售卖副业'],
    emphasis: '先测单点转化'
  };
  assert.equal(resolveCardLayout(qaPage, 1, 4), 'qa');
  const qaHtml = renderCardDocument({ style: 'poster', pages: [qaPage] }, 0, '答疑');
  assert.ok(qaHtml.includes('layout-qa') && qaHtml.includes('qa-pill'));

  const sampleQuick = buildQuickCardPlan({ title: '护膝选购', topic: '', body: '', material: '', writerJson: '' }, 'grid', 4);
  assert.equal(sampleQuick.style, 'grid');
  assert.ok(sampleQuick.pages.length >= 2, '空正文也能生成实时预览样张');

  const bodyQuick = buildQuickCardPlan({
    title: '冬天护膝怎么选',
    topic: '护膝',
    body: '冬天买护膝最怕往下掉和勒腿。\n1. 防滑硅胶条：宽度至少 ≥1cm 走路才不滑脱\n2. 膝弯剪裁：蹲下 90 度腘窝不堆褶不卡肉\n3. 内里材质：选透气羊羔绒避免久戴闷汗起疹\n4. 尺码测量：站立量膝盖上方 10cm 腿围最准',
    material: '',
    writerJson: JSON.stringify({ coreTakeaway: '只看防滑条宽度与腘窝剪裁两个硬指标' })
  }, 'memo', 4);
  assert.equal(bodyQuick.style, 'memo');
  assert.ok(bodyQuick.pages.length >= 2);
  assert.ok(bodyQuick.pages[0].items && bodyQuick.pages[0].items.length >= 2);
});
