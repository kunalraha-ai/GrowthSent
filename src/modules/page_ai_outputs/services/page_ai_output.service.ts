import { PageAiOutputRepository } from "../repositories/page_ai_output.repository";
import { PageRepository } from "../../pages/repositories/page.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { CreatePageAiOutputDTO, QueryPageAiOutputDTO, computePromptHash } from "../validators/page_ai_output.validator";
import { PageAiOutputResponseDTO, toPageAiOutputResponseDTO } from "../dtos/page_ai_output.dto";
import { AppError } from "../../../shared/errors/appError";
import { IPageAiOutputDocument } from "../interfaces/page_ai_output.interface";
import { IPageDocument } from "../../pages/interfaces/page.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";

export class PageAiOutputService {
  constructor(
    private readonly pageAiOutputRepository: PageAiOutputRepository = new PageAiOutputRepository(),
    private readonly pageRepository: PageRepository = new PageRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository()
  ) {}

  async createPageAiOutput(dto: CreatePageAiOutputDTO): Promise<PageAiOutputResponseDTO> {
    const page = await this.pageRepository.findByPublicId(dto.pagePublicId);
    if (!page) {
      throw new AppError("Page not found", 404);
    }

    const promptHash = computePromptHash(dto.prompt);
    const existing = await this.pageAiOutputRepository.findByPageAndPromptHash(page._id, promptHash);
    if (existing) {
      const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";
      return toPageAiOutputResponseDTO(existing, page.publicId, domainPublicId, projectPublicId);
    }

    const newAiOutput = await this.pageAiOutputRepository.create({
      pageId: page._id,
      domainId: page.domainId,
      projectId: page.projectId,
      promptHash,
      llmModel: dto.llmModel || "gemini-2.5-flash",
      suggestedMetaTitle: dto.suggestedMetaTitle,
      suggestedMetaDescription: dto.suggestedMetaDescription,
      suggestedH1: dto.suggestedH1,
      contentSummary: dto.contentSummary,
      actionableRecommendations: dto.actionableRecommendations || [],
      schemaVersion: "1.0.0",
    });

    const domainPublicId = (page.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (page.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageAiOutputResponseDTO(newAiOutput, page.publicId, domainPublicId, projectPublicId);
  }

  async getPageAiOutputByPublicId(publicId: string): Promise<PageAiOutputResponseDTO> {
    const aiOutput = await this.pageAiOutputRepository.findByPublicId(publicId);
    if (!aiOutput) {
      throw new AppError("Page AI output recommendation not found", 404);
    }

    const pagePublicId = (aiOutput.pageId as unknown as IPageDocument)?.publicId || "";
    const domainPublicId = (aiOutput.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (aiOutput.projectId as unknown as IProjectDocument)?.publicId || "";

    return toPageAiOutputResponseDTO(aiOutput, pagePublicId, domainPublicId, projectPublicId);
  }

  async listPageAiOutputs(query: QueryPageAiOutputDTO): Promise<{ aiOutputs: PageAiOutputResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.llmModel) filter.llmModel = query.llmModel;

    if (query.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(query.pagePublicId);
      if (!page) return { aiOutputs: [], total: 0, page: query.page, limit: query.limit };
      filter.pageId = page._id;
    }

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { aiOutputs: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { aiOutputs: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    const { aiOutputs, total } = await this.pageAiOutputRepository.list(filter, query.page, query.limit);

    const dtos = aiOutputs.map((ai) => {
      const pagePublicId = (ai.pageId as unknown as IPageDocument)?.publicId || "";
      const domainPublicId = (ai.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (ai.projectId as unknown as IProjectDocument)?.publicId || "";
      return toPageAiOutputResponseDTO(ai, pagePublicId, domainPublicId, projectPublicId);
    });

    return {
      aiOutputs: dtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
