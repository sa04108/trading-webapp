export class BrokerNotConfiguredError extends Error {
  constructor() {
    super('증권사 API 자격 증명이 설정되지 않았습니다. CSV/Parquet import 를 사용하세요.');
    this.name = 'BrokerNotConfiguredError';
  }
}
