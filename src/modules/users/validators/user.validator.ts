import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email("Invalid email format").transform((val) => val.toLowerCase().trim()),
  name: z.string().min(1, "Name is required").max(100, "Name is too long").trim(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  signupIp: z.string().optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  state: z.enum(["active", "suspended", "pending", "deleted"]).optional(),
});

export const queryUserSchema = z.object({
  state: z.enum(["active", "suspended", "pending", "deleted"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateUserDTO = z.infer<typeof createUserSchema>;
export type UpdateUserDTO = z.infer<typeof updateUserSchema>;
export type QueryUserDTO = z.infer<typeof queryUserSchema>;
