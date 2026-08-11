import bcrypt from "bcryptjs";
import { UserRepository } from "../repositories/user.repository";
import { CreateUserDTO, UpdateUserDTO, QueryUserDTO } from "../validators/user.validator";
import { UserResponseDTO, toUserResponseDTO } from "../dtos/user.dto";
import { AppError } from "../../../shared/errors/appError";
import { IUserDocument } from "../interfaces/user.interface";

export class UserService {
  constructor(private readonly userRepository: UserRepository = new UserRepository()) {}

  async createUser(dto: CreateUserDTO): Promise<UserResponseDTO> {
    const existingUser = await this.userRepository.findByEmail(dto.email);
    if (existingUser) {
      throw new AppError("A user with this email address already exists.", 409);
    }

    let passwordHash: string | undefined;
    if (dto.password) {
      passwordHash = await bcrypt.hash(dto.password, 12);
    }

    const newUser = await this.userRepository.create({
      email: dto.email,
      name: dto.name,
      passwordHash,
      state: "active",
      authProviders: [
        {
          provider: "email",
          providerId: dto.email,
          linkedAt: new Date(),
        },
      ],
      metadata: {
        signupIp: dto.signupIp,
        loginCount: 0,
      },
      schemaVersion: "1.0.0",
      revision: 1,
    });

    return toUserResponseDTO(newUser);
  }

  async getUserByPublicId(publicId: string): Promise<UserResponseDTO> {
    const user = await this.userRepository.findByPublicId(publicId);
    if (!user) {
      throw new AppError("User not found", 404);
    }
    return toUserResponseDTO(user);
  }

  async getUserByObjectId(objectId: string): Promise<IUserDocument> {
    const user = await this.userRepository.findByObjectId(objectId);
    if (!user || user.state === "deleted") {
      throw new AppError("User not found", 404);
    }
    return user;
  }

  async listUsers(query: QueryUserDTO): Promise<{ users: UserResponseDTO[]; total: number; page: number; limit: number }> {
    const filter: Record<string, unknown> = {};
    if (query.state) {
      filter.state = query.state;
    }

    const { users, total } = await this.userRepository.list(filter, query.page, query.limit);

    return {
      users: users.map(toUserResponseDTO),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async updateUser(publicId: string, dto: UpdateUserDTO): Promise<UserResponseDTO> {
    const user = await this.userRepository.findByPublicId(publicId);
    if (!user) {
      throw new AppError("User not found", 404);
    }

    const updatedUser = await this.userRepository.updateByPublicId(publicId, dto);
    if (!updatedUser) {
      throw new AppError("Failed to update user", 500);
    }

    return toUserResponseDTO(updatedUser);
  }

  async deleteUser(publicId: string): Promise<void> {
    const deleted = await this.userRepository.softDeleteByPublicId(publicId);
    if (!deleted) {
      throw new AppError("User not found", 404);
    }
  }
}
