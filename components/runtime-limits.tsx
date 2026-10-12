"use client";

import { useState } from 'react';
import { Check, Gauge, LoaderCircle } from 'lucide-react';
import type { Settings } from '@/lib/types';

type LimitKey = 'memoryLimit' | 'groupToolLimit' | 'groupImageLimit' | 'groupArtifactLimit';
export type RuntimeLimitValues = Required<Pick<Settings, LimitKey>>;
const FIELDS: { key: LimitKey; title: string; description: string }[] = [
  { key: 'memoryLimit', title: '每位成员的个人长期记忆', description: '达到设定条数后停止新增，已有记忆不会自动裁切。每场共议的经历摘要另行保留。' },
  { key: 'groupToolLimit', title: '每次成员发言的工具调用', description: '搜索、计算、写文件与生成图片共享此额度。' },
  { key: 'groupImageLimit', title: '每次成员发言的图片生成', description: '按图片生成尝试次数计算。' },
  { key: 'groupArtifactLimit', title: '每场共议保存的成果', description: '文件、图片及其新版本计入成果数量。' },
];
const valuesOf = (settings: Settings): Record<LimitKey, string> => Object.fromEntries(FIELDS.map(field => [field.key, String(settings[field.key] ?? 0)])) as Record<LimitKey, string>;

interface RuntimeLimitsProps { settings: Settings; busy: boolean; onSave: (values: RuntimeLimitValues) => Promise<boolean>; }
export function RuntimeLimits(props: RuntimeLimitsProps) {
  return <RuntimeLimitsForm key={FIELDS.map(({ key }) => props.settings[key] ?? 0).join(':')} {...props}/>;
}
function RuntimeLimitsForm({ settings, busy, onSave }: RuntimeLimitsProps) {
  const [values, setValues] = useState(() => valuesOf(settings));
  const [saving, setSaving] = useState(false);
  const valid = FIELDS.every(({ key }) => /^\d+$/.test(values[key]) && Number.isSafeInteger(Number(values[key])));
  const save = async () => {
    if (busy || saving || !valid) return;
    setSaving(true);
    try { await onSave(Object.fromEntries(FIELDS.map(({ key }) => [key, Number(values[key])])) as RuntimeLimitValues); }
    finally { setSaving(false); }
  };
  return <section className="panel runtime-limits" aria-labelledby="runtime-limits-heading">
    <h2 className="panel-title" id="runtime-limits-heading"><Gauge size={15}/>记忆与共议额度</h2>
    <p className="panel-note">填写非负整数，0 表示不限。不限时会继续按需调用模型、保存记忆和成果，直到交流完成或由你暂停。</p>
    <div className="runtime-limit-fields">{FIELDS.map(field => <label className="runtime-limit-field" key={field.key} htmlFor={`limit-${field.key}`}><span><strong>{field.title}</strong><small>{field.description}</small></span><input id={`limit-${field.key}`} type="number" min={0} step={1} inputMode="numeric" value={values[field.key]} disabled={busy || saving} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}/><span className="runtime-limit-unit">{values[field.key] === '0' ? '不限' : '上限'}</span></label>)}</div>
    {!valid && <p className="form-error" role="alert">请为每项填写有效的非负整数，0 表示不限。</p>}
    <div className="save-row"><button className="button primary" disabled={busy || saving || !valid} onClick={() => void save()}>{saving ? <LoaderCircle size={13} className="spin"/> : <Check size={13}/>}保存额度</button></div>
  </section>;
}
