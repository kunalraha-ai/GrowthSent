export interface KeywordData {
  keyword: string;
  country: string;
  language: string;
  searchVolume?: number;
  difficulty?: number;
  intent?: "informational" | "navigational" | "commercial" | "transactional";
  source: string;
  retrievedAt: Date;
}

export interface IKeywordProvider {
  name: string;
  getKeywordMetrics(keywords: string[], country?: string): Promise<KeywordData[]>;
}

export class DefaultKeywordProvider implements IKeywordProvider {
  name = "gsc_and_first_party";

  async getKeywordMetrics(keywords: string[], country: string = "US"): Promise<KeywordData[]> {
    return keywords.map((kw) => ({
      keyword: kw,
      country,
      language: "en",
      source: "first_party_page_signal",
      retrievedAt: new Date(),
    }));
  }
}
