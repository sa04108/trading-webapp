import { InfoHint } from '@/components/info-hint';
import { paramLabel, paramMetaLine, type NumberParamSpec } from './param-specs';

/** 파라미터 설명 툴팁 — 여닫는 동작은 InfoHint 가 책임진다 */
export function ParamHint({ spec }: { spec: NumberParamSpec }) {
  if (!spec.help) return null;

  return (
    <InfoHint label={`${paramLabel(spec)} 설명`}>
      <p className="leading-relaxed">{spec.help}</p>
      <p className="font-mono text-[10px] opacity-70">{paramMetaLine(spec)}</p>
    </InfoHint>
  );
}
