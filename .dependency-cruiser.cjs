/** 스펙 §7 의존성 규칙 — tests/architecture/module-boundaries.test.ts 가 실행한다. */
module.exports = {
  forbidden: [
    {
      name: 'domain-to-infrastructure',
      severity: 'error',
      comment: 'domain → infrastructure 금지 (§7)',
      from: { path: '/domain/' },
      to: { path: '/infrastructure/' },
    },
    {
      name: 'domain-to-presentation',
      severity: 'error',
      comment: 'domain → presentation 금지 (§7)',
      from: { path: '/domain/' },
      to: { path: '/presentation/' },
    },
    {
      name: 'domain-to-application',
      severity: 'error',
      comment: 'domain → application 금지 (§7 의존 방향)',
      from: { path: '/domain/' },
      to: { path: '/application/' },
    },
    {
      name: 'application-to-presentation',
      severity: 'error',
      comment: 'application → presentation 금지 (§7)',
      from: { path: '/application/' },
      to: { path: '/presentation/' },
    },
    {
      name: 'domain-no-frameworks',
      severity: 'error',
      comment: 'domain 은 Fastify/React/SQLite/DuckDB/Drizzle/Pino 를 모른다 (§7)',
      from: { path: '/domain/' },
      to: {
        path: 'node_modules/(fastify|@fastify|react|react-dom|better-sqlite3|@duckdb|drizzle-orm|pino)',
      },
    },
    {
      name: 'domain-no-node-builtins',
      severity: 'error',
      comment: 'domain 은 파일 시스템·HTTP·process 등 Node 코어를 모른다 (§7)',
      from: { path: '/domain/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'market-data-no-broker',
      severity: 'error',
      comment:
        'market-data → broker 금지 (§7 포트 역전) — broker 가 market-data 의 port 를 구현한다',
      from: { path: 'src/server/modules/market-data' },
      to: { path: 'src/server/modules/broker' },
    },
    {
      name: 'market-data-no-facts',
      severity: 'error',
      comment:
        'market-data → facts 금지 (§7) — 조립부가 factsPhase·factsSyncEstimator 클로저로 잇는다',
      from: { path: 'src/server/modules/market-data' },
      to: { path: 'src/server/modules/facts' },
    },
    {
      name: 'strategy-no-broker-adapter',
      severity: 'error',
      comment: 'strategy → broker adapter 금지 (§7)',
      from: { path: 'src/server/modules/strategy' },
      to: { path: 'src/server/modules/broker' },
    },
    {
      name: 'backtest-no-broker-adapter',
      severity: 'error',
      comment: 'backtest → broker order adapter 금지 (§7)',
      from: { path: 'src/server/modules/backtest' },
      to: { path: 'src/server/modules/broker' },
    },
    {
      name: 'facts-no-broker',
      severity: 'error',
      comment:
        'facts → broker 금지 (§7) — DART 는 증권사가 아니다. 공용 HTTP 클라이언트는 src/server/shared 에 있다',
      from: { path: 'src/server/modules/facts' },
      to: { path: 'src/server/modules/broker' },
    },
    {
      name: 'web-no-server-internals',
      severity: 'error',
      comment: '웹이 서버 내부 구현을 직접 import 금지 (§7) — 공유는 src/shared 만',
      from: { path: '^src/web' },
      to: { path: '^src/server' },
    },
    {
      name: 'server-no-web',
      severity: 'error',
      comment: '서버가 웹 코드를 import 금지',
      from: { path: '^src/(server|workers)' },
      to: { path: '^src/web' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.server.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js'],
    },
  },
};
