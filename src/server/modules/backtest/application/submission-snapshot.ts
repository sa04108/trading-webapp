import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { datasetIdentity } from "../../../../runtime/shared/db/database-layout.js";
import { PreparationReferenceError } from "./preparation-reference-service.js";

export interface SubmissionSnapshot {
  readonly datasetId: string;
  readonly revision: number;
}

/** 검증 후 데이터가 바뀌었으면 같은 쓰기 트랜잭션에서 작업 생성을 거부한다. */
export function assertSubmissionSnapshot(
  database: DatabaseHandle,
  expected: SubmissionSnapshot | undefined,
): void {
  if (!expected) return;
  const actual = datasetIdentity(database.sqlite);
  if (actual.datasetId !== expected.datasetId || actual.revision !== expected.revision)
    throw new PreparationReferenceError();
}
