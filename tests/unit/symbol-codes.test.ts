import { describe, expect, it } from 'vitest';
import {
  parseSymbolCodes,
  splitRegistered,
} from '../../src/web/features/datasets/symbol-codes.js';

describe('parseSymbolCodes', () => {
  it('빈 입력은 아무것도 만들지 않는다', () => {
    expect(parseSymbolCodes('')).toEqual({ codes: [], invalid: [], duplicates: 0 });
    expect(parseSymbolCodes('   \n ')).toEqual({ codes: [], invalid: [], duplicates: 0 });
  });

  it('단건도 목록이다 — 추가 경로를 둘로 나누지 않는다', () => {
    expect(parseSymbolCodes('005930').codes).toEqual(['005930']);
  });

  it('쉼표로 나눈다', () => {
    expect(parseSymbolCodes('005930,000660,035720').codes).toEqual([
      '005930',
      '000660',
      '035720',
    ]);
  });

  it('쉼표 뒤 공백을 흘려보낸다', () => {
    expect(parseSymbolCodes('005930, 000660,  035720').codes).toEqual([
      '005930',
      '000660',
      '035720',
    ]);
  });

  it('줄바꿈도 구분자다 — 스프레드시트 한 열을 붙이면 쉼표가 아니라 줄바꿈으로 온다', () => {
    expect(parseSymbolCodes('005930\n000660\r\n035720').codes).toEqual([
      '005930',
      '000660',
      '035720',
    ]);
  });

  it('쉼표와 줄바꿈이 섞여도 된다', () => {
    expect(parseSymbolCodes('005930, 000660\n035720\t096770').codes).toEqual([
      '005930',
      '000660',
      '035720',
      '096770',
    ]);
  });

  it('뒤에 붙는 쉼표가 빈 항목을 만들지 않는다', () => {
    expect(parseSymbolCodes('005930,000660,').codes).toEqual(['005930', '000660']);
    expect(parseSymbolCodes(',,005930,,').codes).toEqual(['005930']);
  });

  it('중복은 걷어내고 개수로 알린다 — 두 번 붙였다고 실패시킬 이유가 없다', () => {
    const parsed = parseSymbolCodes('005930, 000660, 005930');
    expect(parsed.codes).toEqual(['005930', '000660']);
    expect(parsed.duplicates).toBe(1);
  });

  it('입력 순서를 지킨다', () => {
    expect(parseSymbolCodes('035720, 005930').codes).toEqual(['035720', '005930']);
  });

  it('형식 위반은 조용히 버리지 않고 따로 돌려준다', () => {
    const parsed = parseSymbolCodes('005930, 하하하, 000660');
    expect(parsed.codes).toEqual(['005930', '000660']);
    expect(parsed.invalid).toEqual(['하하하']);
  });

  it('20자를 넘는 토큰은 형식 위반이다 (서버 상한과 같다)', () => {
    const long = 'A'.repeat(21);
    expect(parseSymbolCodes(long)).toEqual({ codes: [], invalid: [long], duplicates: 0 });
    expect(parseSymbolCodes('A'.repeat(20)).codes).toEqual(['A'.repeat(20)]);
  });

  it('영숫자와 . _ - 는 허용한다 — 해외 티커에 쓰인다', () => {
    expect(parseSymbolCodes('BRK.B, TSLA, A_B, A-B').codes).toEqual([
      'BRK.B',
      'TSLA',
      'A_B',
      'A-B',
    ]);
  });

  it('형식 위반 토큰도 중복을 걷어낸다 — 같은 오타를 두 줄로 늘어놓지 않는다', () => {
    expect(parseSymbolCodes('가, 나, 가').invalid).toEqual(['가', '나']);
  });

  it('대소문자를 바꾸지 않는다 — 티커는 대소문자가 있는 그대로여야 한다', () => {
    expect(parseSymbolCodes('aapl, MSFT').codes).toEqual(['aapl', 'MSFT']);
  });
});

describe('splitRegistered', () => {
  it('이미 등록된 코드를 갈라낸다', () => {
    const { fresh, already } = splitRegistered(
      ['005930', '000660', '035720'],
      new Set(['000660']),
    );
    expect(fresh).toEqual(['005930', '035720']);
    expect(already).toEqual(['000660']);
  });

  it('전부 등록돼 있으면 보낼 것이 없다', () => {
    const { fresh, already } = splitRegistered(['005930'], new Set(['005930']));
    expect(fresh).toEqual([]);
    expect(already).toEqual(['005930']);
  });

  it('등록된 것이 없으면 전부 새 종목이다', () => {
    const { fresh, already } = splitRegistered(['005930'], new Set());
    expect(fresh).toEqual(['005930']);
    expect(already).toEqual([]);
  });
});
