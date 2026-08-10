export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * 서버가 오류 메시지 옆에 실어 보낸 구조화된 값이다.
     * 예: `corporateActionGate`, `uncoveredDates`.
     * 기존 호출부는 `message` 만 보고 이 필드를 몰라도 된다.
     * 그래서 선택 필드로 둔다 — 필요한 곳만 꺼내 쓴다.
     */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** `api`·`postJsonWithStatus` 가 공유하는 오류 파싱 — 실패 응답 모양은 둘 다 같다 */
async function throwApiError(response: Response): Promise<never> {
  let message = response.statusText;
  let details: unknown;
  try {
    const body = (await response.json()) as { error?: string };
    details = body;
    if (body.error) message = body.error;
  } catch {
    // JSON 이 아닌 오류 응답은 statusText 사용
  }
  throw new ApiError(response.status, message, details);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) return throwApiError(response);

  // 204 No Content (예: DELETE) — 본문이 없으므로 JSON 파싱하지 않는다
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * 성공 응답의 status 코드까지 필요한 호출에 쓴다.
 *
 * `POST /backtests/universe-preview` 는 200(미리보기 완성)과 202(준비 작업 시작)를
 * 같은 성공 경로로 함께 쓰는데, `postJson` 은 그 구분을 버린다 — 몸통 모양만으로는
 * "이미 완성된 미리보기" 와 "이제 막 시작한 준비 job" 을 가를 수 없다
 * (`universe-rule-step.tsx` 의 `UniversePreviewStartResponse` 가 이 status 로 갈라진다).
 */
export async function postJsonWithStatus<T>(
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) return throwApiError(response);
  return { status: response.status, data: (await response.json()) as T };
}

/**
 * 부분 수정용. `postJson` 으로 PATCH 라우트를 부르면 메서드가 맞지 않아 404 가 오는데,
 * 그 404 는 "리소스가 없다" 로 읽혀 원인이 드러나지 않는다 — 헬퍼를 따로 둬서 호출부가
 * 메서드를 고민하지 않게 한다.
 */
export const patchJson = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

/** multipart 업로드 — Content-Type 은 브라우저가 boundary 와 함께 설정한다 */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}
