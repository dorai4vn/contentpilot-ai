import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ message: "Vui lòng nhập địa chỉ email hợp lệ." })),
  password: z
    .string()
    .min(8, { message: "Mật khẩu phải có ít nhất 8 ký tự." })
    .max(72, { message: "Mật khẩu tối đa 72 ký tự." }),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Vui lòng nhập tên không gian làm việc." })
  .max(100, { message: "Tên không gian làm việc tối đa 100 ký tự." });

export type FormState = {
  error?: string;
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: { email?: string };
};

/** Reads credentials from a submitted form and validates them. */
export function parseCredentials(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get("email") ?? "",
    password: formData.get("password") ?? "",
  });
}

/** Flattens zod issues into one message per field. */
export function fieldErrorsFrom(error: z.ZodError): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    result[key] ??= issue.message;
  }
  return result;
}
