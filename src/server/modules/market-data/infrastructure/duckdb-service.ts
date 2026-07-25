import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

export interface DuckDbOptions {
  readonly threads: number;
  readonly memoryLimit: string;
}

/**
 * DuckDB 연결 관리 (스펙 §11 기본 제한: threads=1, memory_limit=384MB).
 * 인스턴스는 최초 사용 시 지연 생성한다.
 */
export class DuckDbService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

  constructor(private readonly options: DuckDbOptions) {}

  async getConnection(): Promise<DuckDBConnection> {
    if (this.connection) return this.connection;
    this.instance = await DuckDBInstance.create(':memory:', {
      threads: String(this.options.threads),
      memory_limit: this.options.memoryLimit,
    });
    this.connection = await this.instance.connect();
    return this.connection;
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const connection = await this.getConnection();
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjects() as T[];
  }

  async run(sql: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.run(sql);
  }

  close(): void {
    this.connection?.closeSync();
    this.connection = null;
    this.instance = null;
  }
}

/** SQL 문자열 리터럴 이스케이프 (경로 등 통제된 입력에만 사용) */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
