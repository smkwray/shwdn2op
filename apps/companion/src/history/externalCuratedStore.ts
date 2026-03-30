import type { ExternalCuratedImportInfo } from "../types.js";

export interface ExternalCuratedFormatRecord {
  teamCount: number;
  leadSlotCount: number;
  moves: Record<string, number>;
  items: Record<string, number>;
  abilities: Record<string, number>;
  teraTypes: Record<string, number>;
}

export interface ExternalCuratedSpeciesRecord {
  species: string;
  formats: Record<string, ExternalCuratedFormatRecord>;
}

export interface ExternalCuratedStore {
  species: Record<string, ExternalCuratedSpeciesRecord>;
  imports: Record<string, ExternalCuratedImportInfo>;
}

export interface SampleTeamPriorImportSet {
  species?: string | null | undefined;
  item?: string | null | undefined;
  ability?: string | null | undefined;
  teraType?: string | null | undefined;
  moves?: string[] | null | undefined;
}

export interface SampleTeamPriorImportTeam {
  name?: string | null | undefined;
  author?: string | null | undefined;
  data: SampleTeamPriorImportSet[];
}

export interface SampleTeamPriorImportParams {
  format: string;
  formatId: string;
  sourceUrl: string;
  teams: SampleTeamPriorImportTeam[];
}

export function createExternalCuratedFormatRecord(): ExternalCuratedFormatRecord {
  return {
    teamCount: 0,
    leadSlotCount: 0,
    moves: {},
    items: {},
    abilities: {},
    teraTypes: {}
  };
}

export function normalizeExternalCuratedFormatRecord(
  formatRecord: Partial<ExternalCuratedFormatRecord> | undefined
): ExternalCuratedFormatRecord {
  return {
    ...createExternalCuratedFormatRecord(),
    ...(formatRecord ?? {})
  };
}

export function createExternalCuratedStore(): ExternalCuratedStore {
  return {
    species: {},
    imports: {}
  };
}

export function normalizeExternalCuratedStore(
  store: Partial<ExternalCuratedStore> | undefined
): ExternalCuratedStore {
  return {
    species: store?.species ?? {},
    imports: store?.imports ?? {}
  };
}
