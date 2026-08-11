import { AuditIssueRepository } from "../repositories/audit_issue.repository";
import { PageAuditRepository } from "../../page_audits/repositories/page_audit.repository";
import { UserRepository } from "../../users/repositories/user.repository";
import { DomainRepository } from "../../domains/repositories/domain.repository";
import { ProjectRepository } from "../../projects/repositories/project.repository";
import { PageRepository } from "../../pages/repositories/page.repository";
import { CreateAuditIssueDTO, UpdateAuditIssueDTO, QueryAuditIssueDTO } from "../validators/audit_issue.validator";
import { AuditIssueResponseDTO, toAuditIssueResponseDTO } from "../dtos/audit_issue.dto";
import { AppError } from "../../../shared/errors/appError";
import { IAuditIssueDocument } from "../interfaces/audit_issue.interface";
import { IPageAuditDocument } from "../../page_audits/interfaces/page_audit.interface";
import { IPageDocument } from "../../pages/interfaces/page.interface";
import { IDomainDocument } from "../../domains/interfaces/domain.interface";
import { IProjectDocument } from "../../projects/interfaces/project.interface";
import { IUserDocument } from "../../users/interfaces/user.interface";

export class AuditIssueService {
  constructor(
    private readonly auditIssueRepository: AuditIssueRepository = new AuditIssueRepository(),
    private readonly pageAuditRepository: PageAuditRepository = new PageAuditRepository(),
    private readonly userRepository: UserRepository = new UserRepository(),
    private readonly domainRepository: DomainRepository = new DomainRepository(),
    private readonly projectRepository: ProjectRepository = new ProjectRepository(),
    private readonly pageRepository: PageRepository = new PageRepository()
  ) {}

  async createAuditIssue(dto: CreateAuditIssueDTO): Promise<AuditIssueResponseDTO> {
    const audit = await this.pageAuditRepository.findByPublicId(dto.auditPublicId);
    if (!audit) {
      throw new AppError("Page audit not found", 404);
    }

    let assignedToUserId = undefined;
    if (dto.assignedToUserPublicId) {
      const user = await this.userRepository.findByPublicId(dto.assignedToUserPublicId);
      if (user) assignedToUserId = user._id;
    }

    const newIssue = await this.auditIssueRepository.create({
      auditId: audit._id,
      pageId: audit.pageId,
      domainId: audit.domainId,
      projectId: audit.projectId,
      ruleId: dto.ruleId,
      severity: dto.severity || "warning",
      category: dto.category || "technical",
      message: dto.message,
      details: dto.details,
      state: "open",
      assignedToUserId,
      aiSuggestedFix: dto.aiSuggestedFix,
      schemaVersion: "1.0.0",
    });

    const pagePublicId = (audit.pageId as unknown as IPageDocument)?.publicId || "";
    const domainPublicId = (audit.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (audit.projectId as unknown as IProjectDocument)?.publicId || "";

    return toAuditIssueResponseDTO(
      newIssue,
      audit.publicId,
      pagePublicId,
      domainPublicId,
      projectPublicId,
      dto.assignedToUserPublicId
    );
  }

  async getAuditIssueByPublicId(publicId: string): Promise<AuditIssueResponseDTO> {
    const issue = await this.auditIssueRepository.findByPublicId(publicId);
    if (!issue) {
      throw new AppError("Audit issue not found", 404);
    }

    const auditPublicId = (issue.auditId as unknown as IPageAuditDocument)?.publicId || "";
    const pagePublicId = (issue.pageId as unknown as IPageDocument)?.publicId || "";
    const domainPublicId = (issue.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (issue.projectId as unknown as IProjectDocument)?.publicId || "";
    const assignedToUserPublicId = (issue.assignedToUserId as unknown as IUserDocument)?.publicId;

    return toAuditIssueResponseDTO(issue, auditPublicId, pagePublicId, domainPublicId, projectPublicId, assignedToUserPublicId);
  }

  async listAuditIssues(query: QueryAuditIssueDTO): Promise<{ issues: AuditIssueResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.severity) filter.severity = query.severity;
    if (query.category) filter.category = query.category;
    if (query.state) filter.state = query.state;

    if (query.auditPublicId) {
      const audit = await this.pageAuditRepository.findByPublicId(query.auditPublicId);
      if (!audit) return { issues: [], total: 0, page: query.page, limit: query.limit };
      filter.auditId = audit._id;
    }

    if (query.pagePublicId) {
      const page = await this.pageRepository.findByPublicId(query.pagePublicId);
      if (!page) return { issues: [], total: 0, page: query.page, limit: query.limit };
      filter.pageId = page._id;
    }

    if (query.domainPublicId) {
      const domain = await this.domainRepository.findByPublicId(query.domainPublicId);
      if (!domain) return { issues: [], total: 0, page: query.page, limit: query.limit };
      filter.domainId = domain._id;
    }

    if (query.projectPublicId) {
      const project = await this.projectRepository.findByPublicId(query.projectPublicId);
      if (!project) return { issues: [], total: 0, page: query.page, limit: query.limit };
      filter.projectId = project._id;
    }

    if (query.assignedToUserPublicId) {
      const user = await this.userRepository.findByPublicId(query.assignedToUserPublicId);
      if (!user) return { issues: [], total: 0, page: query.page, limit: query.limit };
      filter.assignedToUserId = user._id;
    }

    const { issues, total } = await this.auditIssueRepository.list(filter, query.page, query.limit);

    const issueDtos = issues.map((issue) => {
      const auditPublicId = (issue.auditId as unknown as IPageAuditDocument)?.publicId || "";
      const pagePublicId = (issue.pageId as unknown as IPageDocument)?.publicId || "";
      const domainPublicId = (issue.domainId as unknown as IDomainDocument)?.publicId || "";
      const projectPublicId = (issue.projectId as unknown as IProjectDocument)?.publicId || "";
      const assignedToUserPublicId = (issue.assignedToUserId as unknown as IUserDocument)?.publicId;
      return toAuditIssueResponseDTO(issue, auditPublicId, pagePublicId, domainPublicId, projectPublicId, assignedToUserPublicId);
    });

    return {
      issues: issueDtos,
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateAuditIssue(publicId: string, dto: UpdateAuditIssueDTO): Promise<AuditIssueResponseDTO> {
    const existing = await this.auditIssueRepository.findByPublicId(publicId);
    if (!existing) {
      throw new AppError("Audit issue not found", 404);
    }

    const updateData: Record<string, unknown> = {};
    if (dto.state) updateData.state = dto.state;
    if (dto.aiSuggestedFix) updateData.aiSuggestedFix = dto.aiSuggestedFix;

    if (dto.assignedToUserPublicId !== undefined) {
      if (dto.assignedToUserPublicId === null) {
        updateData.assignedToUserId = null;
      } else {
        const user = await this.userRepository.findByPublicId(dto.assignedToUserPublicId);
        if (!user) throw new AppError("Assigned user not found", 404);
        updateData.assignedToUserId = user._id;
      }
    }

    const updated = await this.auditIssueRepository.updateByPublicId(publicId, updateData);
    if (!updated) {
      throw new AppError("Failed to update audit issue", 500);
    }

    const auditPublicId = (updated.auditId as unknown as IPageAuditDocument)?.publicId || "";
    const pagePublicId = (updated.pageId as unknown as IPageDocument)?.publicId || "";
    const domainPublicId = (updated.domainId as unknown as IDomainDocument)?.publicId || "";
    const projectPublicId = (updated.projectId as unknown as IProjectDocument)?.publicId || "";
    const assignedToUserPublicId = (updated.assignedToUserId as unknown as IUserDocument)?.publicId;

    return toAuditIssueResponseDTO(updated, auditPublicId, pagePublicId, domainPublicId, projectPublicId, assignedToUserPublicId);
  }
}
