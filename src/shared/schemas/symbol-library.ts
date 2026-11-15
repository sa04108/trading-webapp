export interface SymbolDirectoryEntry {
  symbol: string;
  name: string;
  market: string;
}

export interface SymbolLibrary {
  favorites: SymbolDirectoryEntry[];
  recent: SymbolDirectoryEntry[];
}
