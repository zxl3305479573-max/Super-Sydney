import type { Cookie, CookiesSetDetails, Session } from 'electron';

/**
 * 让嵌入网页的登录在重启应用后仍然有效（公众号后台、闲鱼、16688、小红书窗口、AI 代充站点）。
 *
 * 不少站点把登录态放在不带过期时间的会话 cookie 里，Electron 的持久分区重启后会丢掉这类
 * cookie，于是每次打开应用都要重新登录。这里把站点自己的会话 cookie 原样再写一份，只多一个
 * 过期时间，让它和普通 cookie 一样落盘；站点退出登录时会删掉同名 cookie，退出照样生效，
 * 服务端让登录失效时也照样要求重新登录。应用不另存账号或 cookie 文件。
 */
export const KEEP_LOGIN_DAYS = 30;

/** cookie 所属的主机名（去掉表示子域通配的前导点）。 */
export function cookieHost(cookie: Pick<Cookie, 'domain'>): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
}

/**
 * cookie 是否属于这些站点：主机相同、是站点的子域，或是站点的父域
 * （登录 cookie 常写在父域上，例如 login.taobao.com 写给 .taobao.com）。
 * 父域至少要有两段，避免把 .com 这类顶级域算进来。
 */
export function cookieBelongsTo(host: string, siteHosts: readonly string[]): boolean {
  const name = host.toLowerCase();
  if (!name.includes('.')) return false;
  return siteHosts.some(raw => {
    const site = raw.toLowerCase();
    return name === site || name.endsWith(`.${site}`) || site.endsWith(`.${name}`);
  });
}

/** 同一个 cookie 的持久版本：名字、值、作用域、安全属性都不变，只加上过期时间。 */
export function persistentCopy(cookie: Cookie, nowMs: number, days = KEEP_LOGIN_DAYS): CookiesSetDetails {
  const host = cookieHost(cookie);
  const path = cookie.path || '/';
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    // 只限本主机的 cookie 不能带 domain，否则会变成对所有子域生效。
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    expirationDate: Math.floor(nowMs / 1000) + days * 86_400
  };
}

/** 只转换站点自己的、新写入的会话 cookie；删除事件和已持久的 cookie 一律不动。 */
export function shouldPersist(cookie: Cookie, removed: boolean, siteHosts: readonly string[]): boolean {
  if (removed || !cookie.session) return false;
  const host = cookieHost(cookie);
  return host !== '' && cookieBelongsTo(host, siteHosts);
}

/** 同一个分区会话可能被多个视图复用（视图重建、多个站点共用分区），只挂一次监听。 */
const keptSessions = new WeakSet<Session>();

/**
 * 在分区会话上持续把站点的会话 cookie 转成持久 cookie。
 * siteHosts 每次现取，站点列表可编辑的模块（AI 代充）改了列表也能跟上。
 */
export function keepLoginAcrossRestarts(session: Session, siteHosts: () => readonly string[]): void {
  if (keptSessions.has(session)) return;
  keptSessions.add(session);
  session.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!shouldPersist(cookie, removed, siteHosts())) return;
    // 写回的是持久 cookie，再次触发 changed 时 session 为 false，不会循环。
    session.cookies.set(persistentCopy(cookie, Date.now())).catch(() => { /* 站点随后又改写或删除了它 */ });
  });
}
