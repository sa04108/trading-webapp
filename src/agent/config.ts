import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export const agentSettingsSchema = z.object({
  serverUrl: z.string().url().transform((value) => value.replace(/\/$/, '')).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  }, '서버 주소는 HTTPS여야 합니다. 로컬 테스트 주소만 HTTP를 허용합니다.'),
  token: z.string().min(32).max(256),
}).strict();
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export function defaultStateDirectory(): string { return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state'), 'quant-agent'); }
export function readSettings(directory: string): AgentSettings {
  const file = path.join(directory, 'settings.json');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('settings.json 접근 권한은 600이어야 합니다');
  return agentSettingsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export function writeSettings(directory: string, settings: AgentSettings): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, 'settings.json.tmp');
  fs.writeFileSync(temporary, `${JSON.stringify(agentSettingsSchema.parse(settings), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, path.join(directory, 'settings.json'));
}
