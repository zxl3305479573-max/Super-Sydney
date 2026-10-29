import { HeroSmsDashboard } from './hero-sms/HeroSmsDashboard';
import { HeroSmsKeyPanel } from './hero-sms/HeroSmsKeyPanel';
import { useHeroSmsWorkspace } from './hero-sms/useHeroSmsWorkspace';
import { Icon } from './ui';

export default function HeroSmsPanel({ active, notify }: { active: boolean; notify: (message: string) => void }) {
  const model = useHeroSmsWorkspace(active, notify);
  return (
    <div className="hero-sms">
      <HeroSmsKeyPanel
        configured={model.keyStatus.configured}
        masked={model.keyStatus.masked}
        keyDraft={model.keyDraft}
        busy={model.busy}
        onDraft={model.setKeyDraft}
        onSave={() => void model.saveKey()}
        onTest={() => void model.testKey()}
        onOpen={() => void window.sydney.openEmbeddedInBrowser('heroSms')}
        onDelete={model.deleteKey}
      />
      {model.error && (
        <p className="site-error" role="alert">
          <Icon name="alert" size={14} />
          <span>{model.error}</span>
        </p>
      )}
      {model.keyStatus.configured &&
        (model.loading && !model.overview ? (
          <section className="panel hero-sms-loading">
            <Icon name="refresh" />
            正在从 HeroSMS 读取余额、服务和活跃号码…
          </section>
        ) : (
          model.overview && <HeroSmsDashboard model={model} />
        ))}
    </div>
  );
}
