import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MIB = 1024 * 1024;

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}
function number(file: string): number | null {
  const raw = read(file);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface AgentResources {
  cpus: number;
  availableBytes: number;
  reserveBytes: number;
  slots: number;
  heapMb: number;
  maxBars: number;
  budgetBytes: number;
  /** 운영 서버의 최소 여유 또는 API 프로세스 몫이 소진된 상태다. */
  memoryPressure?: boolean;
}

export interface ResourceSample {
  cpus: number;
  available: number;
  total: number;
  load: number;
  /** 가용량에서 이미 빠진 API 프로세스 RSS를 여유분으로 다시 차감하지 않는다. */
  parentRss?: number;
  /** 회수 가능한 파일 캐시를 제외하지 않은 실제 하드 한도의 여유다. */
  hardAvailable?: number;
}

/** 측정값을 분리해 메모리 압력과 큰 장치의 실행 한도를 검증한다. */
export function calculateResources(
  sample: ResourceSample,
  running: number,
  observedJobRss = 0,
  profiled = true,
  requestedBars = 0,
  server = false,
): AgentResources {
  const cpus = Math.max(1, Math.floor(sample.cpus));
  // 운영 서버는 memory.high까지의 절반을 API에 남기고
  // 이미 사용 중인 API RSS를 제외한 성장 여유만 가용량에서 차감한다.
  const parentRss = Math.max(0, sample.parentRss ?? 0);
  const reserveBytes = server
    ? Math.max(64 * MIB, sample.total * 0.5 - parentRss)
    : Math.max(256 * MIB, sample.total * 0.1);
  const availableBytes = Math.max(0, sample.available - reserveBytes);
  // 회수 압박 전에 계산을 중단한다. 하드 한도에는 별도로 64 MiB를 남긴다.
  const memoryPressure = server &&
    (parentRss >= sample.total * 0.5 || sample.available < 32 * MIB ||
      (sample.hardAvailable !== undefined && sample.hardAvailable < 64 * MIB));
  const workerAvailable = server
    ? Math.min(availableBytes, sample.total * 0.5)
    : availableBytes;
  const estimated = Math.max(
    // 로컬 분할 입력의 작업별 필요량은 배정과 시작 직전에 별도로 검사한다.
    server ? 0 : requestedBars * 1280,
    // 한 개만 실행하는 서버에서 과거 큰 작업의 RSS가 다음 작은 작업까지 막지 않는다.
    // 개별 작업은 시작 때 고정한 예산과 실행 중 RSS 감시로 제한한다.
    server ? 0 : observedJobRss * 1.35,
    // 장치 RAM/CPU 비율은 작업의 실사용량이 아니다. 첫 실행은 기존 128 MiB
    // 시작 기준으로 한 슬롯만 관찰하고, 이후 RSS와 입력 봉 수로 확장한다.
    128 * MIB,
  );
  const otherLoad = Math.max(0, sample.load - running);
  // 운영 서버에서는 요청 처리용 CPU 여유를 남기고 포화 상태에서 계산을 추가하지 않는다.
  const cpuBudget = server
    ? Math.max(1, cpus - Math.max(1, Math.ceil(cpus * 0.25)))
    : cpus;
  const cpuSlots =
    server && otherLoad >= cpus
      ? 0
      : Math.max(server ? 0 : 1, cpuBudget - Math.floor(otherLoad));
  const possible = Math.min(
    server ? 1 : Number.POSITIVE_INFINITY,
    memoryPressure ? 0 : Number.POSITIVE_INFINITY,
    cpuSlots,
    running + Math.floor(workerAvailable / estimated),
  );
  // 첫 계산의 실제 RSS를 관찰하기 전에는 하나만 실행하고 그 슬롯에 가용 예산을 준다.
  const slots = Math.max(running, profiled ? possible : Math.min(1, possible));
  const budget = workerAvailable / Math.max(1, slots - running);
  const heapMb = Math.max(64, Math.floor((budget * 0.65) / MIB));
  return {
    cpus,
    availableBytes,
    reserveBytes,
    slots,
    heapMb,
    budgetBytes: budget,
    memoryPressure,
    maxBars: Math.max(1, Math.floor((budget * 0.4) / 512)),
  };
}

/** 현재 cgroup과 상위 cgroup의 제한까지 적용한다. CPU affinity도 넘지 않는다. */
export function availableResources(
  running: number,
  observedJobRss = 0,
  profiled = true,
  requestedBars = 0,
  server = false,
): AgentResources {
  let cpus = os.availableParallelism();
  const memoryAvailable = /MemAvailable:\s+(\d+) kB/.exec(
    read("/proc/meminfo") ?? "",
  );
  const hostAvailable = memoryAvailable?.[1]
    ? Number(memoryAvailable[1]) * 1024 : os.freemem();
  // Node의 availableMemory는 memory.high도 반영할 수 있다. 서버의 하드 여유는
  // 아래에서 memory.max로 별도 계산해 high를 하드 한도로 이중 차감하지 않는다.
  let hardAvailable = server ? hostAvailable : Math.min(process.availableMemory(), hostAvailable);
  let available = server ? hostAvailable : hardAvailable;
  let total = os.totalmem();
  let sampledCgroup = false;
  const relative =
    /^0::(.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1] ?? "/";
  const root = "/sys/fs/cgroup";
  let directory = path.resolve(root, `.${relative}`);
  if (!directory.startsWith(`${root}/`) && directory !== root) directory = root;
  for (;;) {
    const cpuMax = read(path.join(directory, "cpu.max"))?.split(/\s+/);
    if (cpuMax?.[0] && cpuMax[0] !== "max" && Number(cpuMax[1]) > 0)
      cpus = Math.min(
        cpus,
        Math.max(1, Math.ceil(Number(cpuMax[0]) / Number(cpuMax[1]))),
      );
    const hardLimit = number(path.join(directory, "memory.max"));
    const high = server ? number(path.join(directory, "memory.high")) : null;
    const limit = high === null ? hardLimit
      : Math.min(high, hardLimit ?? Number.POSITIVE_INFINITY);
    const used = number(path.join(directory, "memory.current"));
    if (limit !== null) total = Math.min(total, limit);
    if (hardLimit !== null && used !== null)
      hardAvailable = Math.min(hardAvailable, Math.max(0, hardLimit - used));
    if (limit !== null && used !== null) {
      sampledCgroup = true;
      // 스냅샷 파일을 읽고 남은 비활성 캐시를 워커의 상주 메모리로 계산하지 않는다.
      // 쓰기 미완료 캐시와 활성 캐시는 회수 가능량에서 보수적으로 제외한다.
      const stat = server ? read(path.join(directory, "memory.stat")) ?? "" : "";
      const values = new Map(stat.split("\n").map((line): [string, number] => {
        const [key, raw] = line.split(/\s+/);
        return [key ?? "", Number(raw)];
      }));
      const counters = ["inactive_file", "file_dirty", "file_writeback"]
        .map((key) => values.get(key));
      const reclaimable = counters.every((value) => value !== undefined &&
          Number.isFinite(value) && value >= 0)
        ? Math.min(used, Math.max(0, counters[0]! - counters[1]! - counters[2]!)) : 0;
      available = Math.min(available, Math.max(0, limit - used + reclaimable));
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  if (server && !sampledCgroup) {
    // cgroup v1이나 읽을 수 없는 v2에서는 Node의 제한 인지를 보수적으로 유지한다.
    const fallbackAvailable = process.availableMemory();
    available = Math.min(available, fallbackAvailable);
    hardAvailable = Math.min(hardAvailable, fallbackAvailable);
    const constrained = process.constrainedMemory();
    if (constrained > 0) total = Math.min(total, constrained);
  }
  return calculateResources(
    { cpus, available, total, load: os.loadavg()[0]!,
      ...(server ? { parentRss: process.memoryUsage.rss(), hardAvailable } : {}) },
    running,
    observedJobRss,
    profiled,
    requestedBars,
    server,
  );
}

export function processRss(pid: number): number {
  const match = /VmRSS:\s+(\d+) kB/.exec(read(`/proc/${pid}/status`) ?? "");
  return match?.[1] ? Number(match[1]) * 1024 : 0;
}

/** 운영 서비스와 같은 장치의 계산은 더 넓은 자원 여유분을 보존한다. */
export const availableServerResources: typeof availableResources = (
  running,
  observed,
  profiled,
  requestedBars,
) => availableResources(running, observed, profiled, requestedBars, true);
