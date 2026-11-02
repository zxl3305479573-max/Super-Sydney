import test from 'node:test';
import assert from 'node:assert/strict';
import type { IpRenderKit } from '../shared.ts';
import { WECHAT_COVER_SIZE, WECHAT_SHARE_SIZE, emptyWechatIpCoverInput, normalizeWechatIpCoverInput, renderWechatIpCover, wechatCoverPose } from '../services/wechat-ip-cover.ts';
import { buildFrameHtml, settledMotion } from '../services/video-compose.ts';
import { FRAME_TEMPLATE_VERSION } from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, normalizeRenderOptions, parseRenderOptions } from '../services/video-production.ts';

const KIT: IpRenderKit = {
  id: 'k1', name: '某某工作室', tagline: '',
  colors: { primary: '#112233', accent: '#FFEE00', secondary: '#00AA55' },
  avatar: 'data:image/png;base64,AV',
  poses: [{ id: 'p1', label: '打字', src: 'data:image/png;base64,TY' }, { id: 'p2', label: '团队', src: 'data:image/png;base64,TE' }]
};

test('公众号：2.35:1 封面与 1:1 分享图尺寸正确，配色取自 IP，不放头像和品牌名', () => {
  assert.ok(Math.abs(WECHAT_COVER_SIZE.width / WECHAT_COVER_SIZE.height - 2.35) < 0.01);
  assert.equal(WECHAT_SHARE_SIZE.width, WECHAT_SHARE_SIZE.height);
  for (const shape of ['cover', 'share'] as const) {
    const size = shape === 'cover' ? WECHAT_COVER_SIZE : WECHAT_SHARE_SIZE;
    for (const style of ['light', 'dark'] as const) {
      const html = renderWechatIpCover({ ...emptyWechatIpCoverInput('一个人|也能【做公众号】'), style, tag: '复盘' }, KIT, shape);
      assert.ok(html.includes(`width:${size.width}px;height:${size.height}px`));
      assert.ok(html.includes('<mark>做公众号</mark>') && html.includes('#112233'));
      assert.ok(!html.includes('某某工作室') && !html.includes(KIT.avatar) && !html.includes('class="brand"'));
      assert.ok(html.includes('base64,TE'), '默认挑合影类动作');
    }
  }
  assert.equal(wechatCoverPose({ ...emptyWechatIpCoverInput(), pose: 'p1' }, KIT)?.id, 'p1');
  const bare = renderWechatIpCover(emptyWechatIpCoverInput('标题'), { ...KIT, poses: [], avatar: '' }, 'cover');
  assert.ok(!bare.includes('class="hero"') && !bare.includes('<img'));
  assert.deepEqual(normalizeWechatIpCoverInput({ style: 'neon', title: ' 标题 ', extra: 1 }), { style: 'light', pose: '', title: '标题', sub: '', tag: '' });
});

test('视频帧不包含个人 IP 角色或品牌元素', () => {
  const base = {
    template: 'warm' as const, title: '血压怎么量才准', keyText: '先坐五分钟', subtitle: '量之前先静坐', imageUrl: '',
    shotNumber: 1, shotCount: 3, footer: '', role: '' as const, lead: '', motion: settledMotion('量之前先静坐', { karaoke: false, pushIn: false })
  };
  const plain = buildFrameHtml(base);
  assert.ok(!plain.includes('ip-badge') && !plain.includes('class="ip-hero"'));
  assert.ok(FRAME_TEMPLATE_VERSION >= 5, '改了帧模板排版，版本号要加一');
});

test('视频渲染选项不包含个人 IP 选择', () => {
  assert.equal('ipId' in VIDEO_RENDER_DEFAULTS, false);
  assert.equal(parseRenderOptions('{"template":"clean"}').footer, '');
  assert.equal('ipId' in normalizeRenderOptions({ ipId: 'legacy' } as never), false);
});
