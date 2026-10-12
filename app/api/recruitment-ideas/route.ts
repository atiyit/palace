import { getChatGPTUser } from '@/app/chatgpt-auth';
import { createInitialState } from '@/lib/seeds';
import { upgradeAppState } from '@/lib/character-profile';
import type { AppState } from '@/lib/types';
import { PalaceError, publicError } from '@/lib/server/errors';
import { completeJson } from '@/lib/server/provider';
import { withProviderSettings } from '@/lib/server/provider-settings';
import { createRandomRecruitmentBrief, randomRecruitmentRequestSchema } from '@/lib/server/random-recruitment';
import { readState } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: '请先登录你的私人后宫。', code: 'UNAUTHORIZED' }, 401);
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new PalaceError('请求来源不匹配，请在应用页面内操作。', 403, 'ORIGIN_MISMATCH');
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PalaceError('请求需要JSON格式。', 415);
    const body = await request.text();
    if (body.length > 16_000) throw new PalaceError('请求内容过长。', 413);
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new PalaceError('请求JSON格式无效。'); }
    const parsed = randomRecruitmentRequestSchema.safeParse(raw);
    if (!parsed.success) throw new PalaceError('人物方向最多1800字，寻访数量需要是1至10之间的整数。', 400, 'RECRUITMENT_IDEA_INPUT_INVALID');
    return await withProviderSettings(user.userId, async () => {
      const state = upgradeAppState(await readState<AppState>(user.userId, createInitialState));
      if (state.pendingCleanup?.length) throw new PalaceError('请先完成数据清理，再生成人物设定。', 409, 'CLEANUP_PENDING');
      const idea = await createRandomRecruitmentBrief(state, parsed.data, async (...args) => (await completeJson(...args)).value);
      return json({ ...idea, message: '随机人物设定已生成，可在输入框中编辑后开始寻访。' });
    });
  } catch (error) {
    const safe = publicError(error);
    return json({ error: safe.message, code: safe.code }, safe.status);
  }
}
