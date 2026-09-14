import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIB = 1024 * 1024;
function read(file: string): string | null { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } }
function number(file: string): number | null {
  const value = Number(read(file));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface AgentResources { cpus: number; availableBytes: number; reserveBytes: number; slots: number; heapMb: number; maxBars: number; budgetBytes: number }

export interface ResourceSample { cpus: number; available: number; total: number; load: number }

/** 측정값을 분리해 메모리 압력과 큰 장치의 실행 한도를 검증한다. */
export function calculateResources(sample: ResourceSample, running: number, observedJobRss = 0, profiled = true, requestedBars = 0, server = false): AgentResources {
  const cpus = Math.max(1, Math.floor(sample.cpus));
  const reserveBytes = Math.max(256 * MIB, sample.total * (server ? 0.25 : 0.1));
  const availableBytes = Math.max(0, sample.available - reserveBytes);
  const estimated = Math.max(requestedBars * 1280, observedJobRss * 1.35, Math.min(sample.total / cpus, 512 * MIB));
  const otherLoad = Math.max(0, sample.load - running);
  // 운영 서버에서는 요청 처리용 CPU 여유를 남기고 포화 상태에서 계산을 추가하지 않는다.
  const cpuBudget = server ? Math.max(1, cpus - Math.max(1, Math.ceil(cpus * 0.25))) : cpus;
  const cpuSlots = server && otherLoad >= cpus ? 0 : Math.max(server ? 0 : 1, cpuBudget - Math.floor(otherLoad));
  const possible = Math.min(cpuSlots, running + Math.floor(availableBytes / Math.max(128 * MIB, estimated)));
  // 첫 계산의 실제 RSS를 관찰하기 전에는 하나만 실행하고 그 슬롯에 가용 예산을 준다.
  const slots = Math.max(running, profiled ? possible : Math.min(1, possible));
  const budget = availableBytes / Math.max(1, slots - running);
  const heapMb = Math.max(64, Math.floor(budget * 0.65 / MIB));
  return { cpus, availableBytes, reserveBytes, slots, heapMb, budgetBytes: budget, maxBars: Math.max(1, Math.floor(budget * 0.4 / 512)) };
}

/** 현재 cgroup과 상위 cgroup의 제한까지 적용한다. CPU affinity도 넘지 않는다. */
export function availableResources(running: number, observedJobRss = 0, profiled = true, requestedBars = 0, server = false): AgentResources {
  let cpus = os.availableParallelism();
  const memoryAvailable = /MemAvailable:\s+(\d+) kB/.exec(read('/proc/meminfo') ?? '');
  let available = Math.min(process.availableMemory(), memoryAvailable?.[1] ? Number(memoryAvailable[1]) * 1024 : os.freemem());
  let total = os.totalmem();
  const relative = /^0::(.*)$/m.exec(read('/proc/self/cgroup') ?? '')?.[1] ?? '/';
  const root = '/sys/fs/cgroup';
  let directory = path.resolve(root, `.${relative}`);
  if (!directory.startsWith(`${root}/`) && directory !== root) directory = root;
  for (;;) {
    const cpuMax = read(path.join(directory, 'cpu.max'))?.split(/\s+/);
    if (cpuMax?.[0] && cpuMax[0] !== 'max' && Number(cpuMax[1]) > 0) cpus = Math.min(cpus, Math.max(1, Math.ceil(Number(cpuMax[0]) / Number(cpuMax[1]))));
    const limit = number(path.join(directory, 'memory.max'));
    const used = number(path.join(directory, 'memory.current'));
    if (limit !== null) total = Math.min(total, limit);
    if (limit !== null && used !== null) available = Math.min(available, Math.max(0, limit - used));
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  return calculateResources({ cpus, available, total, load: os.loadavg()[0]! }, running, observedJobRss, profiled, requestedBars, server);
}

export function processRss(pid: number): number {
  const match = /VmRSS:\s+(\d+) kB/.exec(read(`/proc/${pid}/status`) ?? '');
  return match?.[1] ? Number(match[1]) * 1024 : 0;
}

/** 운영 서비스와 같은 장치의 계산은 더 넓은 자원 여유분을 보존한다. */
export const availableServerResources: typeof availableResources = (running, observed, profiled, requestedBars) =>
  availableResources(running, observed, profiled, requestedBars, true);
