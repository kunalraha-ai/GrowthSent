import { IUser, UserState, IAuthProvider } from "../interfaces/user.interface";

export interface UserResponseDTO {
  publicId: string;
  email: string;
  name: string;
  state: UserState;
  authProviders: IAuthProvider[];
  metadata: {
    signupIp?: string;
    lastLoginAt?: Date;
    loginCount: number;
  };
  revision: number;
  schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toUserResponseDTO(user: IUser): UserResponseDTO {
  return {
    publicId: user.publicId,
    email: user.email,
    name: user.name,
    state: user.state,
    authProviders: user.authProviders || [],
    metadata: {
      signupIp: user.metadata?.signupIp,
      lastLoginAt: user.metadata?.lastLoginAt,
      loginCount: user.metadata?.loginCount ?? 0,
    },
    revision: user.revision,
    schemaVersion: user.schemaVersion,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
