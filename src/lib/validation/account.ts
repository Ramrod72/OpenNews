import { z } from "zod";

// bcrypt silently ignores anything past 72 bytes; capping input length here
// avoids giving users a false sense of added security from extra characters
// that would never actually be hashed.
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(72),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
