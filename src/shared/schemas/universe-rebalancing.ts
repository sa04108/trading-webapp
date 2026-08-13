export type UniverseRebalancingEntryDto =
  | {
      readonly kind: 'INITIAL';
      readonly rebalanceDate: string;
      readonly effectiveDate: string;
      readonly memberCount: number;
    }
  | {
      readonly kind: 'CHANGE';
      readonly rebalanceDate: string;
      readonly effectiveDate: string;
      readonly addedCount: number;
      readonly removedCount: number;
      readonly changedCount: number;
    };
