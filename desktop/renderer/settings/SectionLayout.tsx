import type { ReactNode } from 'react';
import { ModuleBody, ModuleHeader, ModuleToolbar } from '../ui';

/** 设置页统一的标题、工具栏和正文骨架。 */
export function SettingsSection({ id, title, purpose, action, toolbar, children }: { id?: string; title: string; purpose: ReactNode; action?: ReactNode; toolbar?: ReactNode; children: ReactNode }) {
  return <section id={id} className="settings-section">
    <ModuleHeader title={title} purpose={purpose} action={action} />
    <ModuleToolbar label={`${title}工具栏`}>{toolbar}</ModuleToolbar>
    <ModuleBody className="settings-section-body">{children}</ModuleBody>
  </section>;
}
