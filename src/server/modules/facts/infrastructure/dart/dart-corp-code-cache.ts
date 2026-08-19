import { inflateRawSync } from 'node:zlib';

export interface CorpCodeResolver {
  /** 종목코드 → DART corp_code. 매핑에 없으면 null */
  resolve(symbol: string, beforeRequest?: () => void): Promise<string | null>;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const FIXED_HEADER_BYTES = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * 단일 엔트리 ZIP 의 첫 파일을 푼다.
 *
 * 새 의존성을 넣지 않는 이유: DART `corpCode.xml` 응답은 엔트리가 하나인 ZIP 이고,
 * local file header 하나만 읽으면 된다 (central directory 를 볼 필요가 없다).
 * 범용 ZIP 리더가 필요해지면 그때 라이브러리를 넣는다.
 *
 * CRC32 는 검증하지 않는다 — inflate 가 깨진 데이터에서 이미 던진다.
 */
export function extractSingleFileFromZip(zip: Buffer): Buffer {
  if (zip.length < FIXED_HEADER_BYTES || zip.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    // DART 는 인증 실패 시 ZIP 대신 XML 에러 본문을 준다 — 여기서 명확히 실패시킨다
    throw new Error(
      'ZIP 형식이 아닙니다. DART 가 오류 응답을 보냈을 수 있습니다 (API 키를 확인하세요).',
    );
  }

  const method = zip.readUInt16LE(8);
  const compressedSize = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const start = FIXED_HEADER_BYTES + nameLength + extraLength;

  // compressedSize 가 0(스트리밍 기록)이면 남은 바이트 전부를 쓴다
  const end = compressedSize > 0 ? start + compressedSize : zip.length;
  const payload = zip.subarray(start, end);

  if (method === METHOD_STORED) return Buffer.from(payload);
  if (method === METHOD_DEFLATE) return inflateRawSync(payload);
  throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
}

const LIST_PATTERN = /<list>([\s\S]*?)<\/list>/g;

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? (match[1] as string).trim() : null;
}

/**
 * `stock_code → corp_code` 맵.
 *
 * XML 파서를 쓰지 않는 이유: CORPCODE.xml 은 속성·네임스페이스·CDATA 가 없는 평면
 * `<result><list>...</list></result>` 구조다. 이 파일 하나를 위해 XML 의존성을
 * 넣는 것보다 태그 추출이 낫다. 구조가 바뀌면 맵이 비고 수집 리포트가 전부 gap 이
 * 되므로 조용히 틀리지 않는다.
 *
 * 상장코드가 빈 회사(비상장)는 넣지 않는다 — 빈 키가 모든 종목을 잡아버린다.
 */
export function parseCorpCodeXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  LIST_PATTERN.lastIndex = 0;
  for (let match = LIST_PATTERN.exec(xml); match !== null; match = LIST_PATTERN.exec(xml)) {
    const block = match[1] as string;
    const stockCode = tagValue(block, 'stock_code');
    const corpCode = tagValue(block, 'corp_code');
    if (!stockCode || !corpCode) continue;
    map.set(stockCode, corpCode);
  }
  return map;
}

/**
 * corp_code 매핑을 1회만 내려받아 캐시한다. 전 종목이 한 파일에 들어 있어 종목별
 * 조회가 없다.
 *
 * 진행 중인 다운로드를 공유하므로 동시 조회가 여러 번 내려받지 않는다. 실패는
 * 캐시하지 않는다 — 일시적 네트워크 오류로 수집 전체가 영구히 막히면 안 된다.
 */
export function createDartCorpCodeCache(
  fetchXmlZip: () => Promise<Buffer>,
): CorpCodeResolver {
  let pending: Promise<Map<string, string>> | null = null;

  const load = (beforeRequest?: () => void): Promise<Map<string, string>> => {
    if (pending) return pending;
    pending = (async () => {
      // 캐시 miss에서만 실제 다운로드가 생긴다. quota도 이 경계에서 한 번만 차감한다.
      beforeRequest?.();
      return parseCorpCodeXml(extractSingleFileFromZip(await fetchXmlZip()).toString('utf8'));
    })().catch((error: unknown) => {
      pending = null; // 실패는 캐시하지 않는다
      throw error;
    });
    return pending;
  };

  return {
    async resolve(symbol: string, beforeRequest?: () => void): Promise<string | null> {
      return (await load(beforeRequest)).get(symbol) ?? null;
    },
  };
}
