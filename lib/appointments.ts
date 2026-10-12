import { hasPersonalMemoryCapacity } from './memory-capacity.ts';
import type { Agent } from './types.ts';
import { PalaceError } from './server/errors.ts';

export interface AppointmentInput { title: string; duties?: string; }
export interface AppointmentMetadata { id: string; now: string; memoryLimit?: number; }

function requireMember(agent: Agent): void {
  if (!agent.hired) throw new PalaceError('请先邀请她加入庭院，再任命或撤销职务。', 400, 'APPOINTMENT_REQUIRES_MEMBER');
}

function appointmentMemory(agent: Agent, content: string, metadata: AppointmentMetadata): void {
  // 请容我替主人按您选择的容量保管日志；默认不限，真正的任命仍以 appointment 字段为准呢。
  if (!hasPersonalMemoryCapacity(agent, metadata.memoryLimit)) return;
  agent.memories.push({
    id: metadata.id, kind: 'experience', content,
    source: `user-appointment:${metadata.id}`, createdAt: metadata.now,
  });
}

export function setAppointment(agent: Agent, input: AppointmentInput, metadata: AppointmentMetadata): void {
  requireMember(agent);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 30) {
    throw new PalaceError('职务名称需要 1 至 30 个字符。', 400, 'INVALID_APPOINTMENT');
  }
  if (input.duties !== undefined && (typeof input.duties !== 'string' || input.duties.trim().length > 600)) {
    throw new PalaceError('职责最多 600 个字符，可以留空。', 400, 'INVALID_APPOINTMENT');
  }
  const title = input.title.trim();
  const duties = input.duties?.trim() || '';
  if (agent.appointment?.title === title && agent.appointment.duties === duties) return;
  const previousTitle = agent.appointment?.title;
  agent.appointment = { title, duties, appointedAt: metadata.now };
  const summary = duties ? `职责摘要：${duties.slice(0, 400)}${duties.length > 400 ? '…' : ''}。` : '用户未补充职责。';
  appointmentMemory(agent,
    `历史任命记录：用户${previousTitle ? `将我的职务由「${previousTitle}」调整为` : '任命我为'}「${title}」。${summary}`,
    metadata,
  );
}

export function removeAppointment(agent: Agent, metadata: AppointmentMetadata): void {
  requireMember(agent);
  if (!agent.appointment) return;
  const previousTitle = agent.appointment.title;
  delete agent.appointment;
  appointmentMemory(agent,
    `历史任命记录：用户撤销了我当时的「${previousTitle}」职务。`,
    metadata,
  );
}

/** 这道门牌由我替主人守着：只向外展示公开的职务信息，不夹带私聊内容和记忆，也不暗示任何权限哦。 */
export function appointmentContext(agent: Agent): Agent['appointment'] | null {
  if (!agent.hired || !agent.appointment) return null;
  return { title: agent.appointment.title, duties: agent.appointment.duties, appointedAt: agent.appointment.appointedAt };
}
