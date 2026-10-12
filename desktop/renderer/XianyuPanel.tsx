/**
 * 闲鱼模块。
 *
 * 现在只创建模块本身：一个导航入口加一块空工作区，功能还没开始做。
 * 所以这里不引用公众号/视频的 .flow-*、.native-* 骨架，也没有数据表与 IPC——
 * 闲鱼要做什么、按什么方式组织还没定，先不把别的模块的形状套上去。
 */
export default function XianyuPanel() {
  return <section className="xy-panel" aria-label="闲鱼">
    <div className="xy-blank">
      <span className="xy-blank-mark" aria-hidden="true">闲</span>
      <h2>闲鱼模块已创建</h2>
      <p>这里先留一块空工作区。闲鱼具体要做什么、怎么组织，等定下来再往里填。</p>
      <ul className="xy-blank-notes">
        <li>还没有数据表与接口，页面不产生任何后台请求。</li>
        <li>页面结构独立，没有沿用公众号 / 视频的流水线骨架。</li>
      </ul>
    </div>
  </section>;
}
